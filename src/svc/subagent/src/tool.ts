// ============================================================
// src/plugins/builtin/tools/subagent.ts —— 子 Agent 调度工具（单一 subagent，action 分发）
//
// 合并自旧 tools/{spawn_subagent,kill_subagent,list_subagents,await_subagent}：
// 子 Agent 生命周期（创建→查询→等待→终止）是同一工作流，拆成 4 个工具会
// 让 LLM 面对 4 个相似名字 + 4 份参数定义，心智负担大且浪费 tool 定义 token。
// 合并为单一 `subagent` 工具 + action 枚举（spawn/list/await/kill），
// 描述统一说清生命周期，参数按 action 复用（subagent_id 等）。
//
// 服务经 ToolContext.subAgent 注入；父 LLM/工具集经 ToolContext
// 的 llm/tools 注入（替代旧 getAppState().registry.getAgent(parent).getLLM()/getTools()）。
//
// 依赖方向：仅依赖本层 services/subagent + @agents/config + @core/types + define-tool + 本层 types。
// ============================================================

import { defineTool } from '@agentchat/toolkit';
import { CAPABILITY_CONDUCTOR, type AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';
import type { ToolContext } from '@agentchat/tools';
import type { SubAgentManager } from './subagent';
import type { LLMProvider } from '@agentchat/llm';

/** subagent 工具：创建子 Agent 执行独立子任务（action=spawn） */
async function spawnSubagent(
  selfId: string,
  services: ToolContext,
  args: Record<string, any>,
): Promise<string> {
  const manager = services.subAgent as SubAgentManager;
  if (!manager) return JSON.stringify({ status: 'error', data: { message: 'subAgent 服务未注入 ToolContext' } });
  const llm = services.llm as LLMProvider;
  if (!llm) return JSON.stringify({ status: 'error', data: { message: `父 Agent "${selfId}" 无 LLM，无法 spawn 子 Agent` } });

  const task = String(args.task ?? '').trim();
  if (!task) return JSON.stringify({ status: 'error', data: { message: '缺少 task 参数' } });

  const handle = await manager.spawn(
    {
      parentId: selfId,
      name: args.name ? String(args.name) : undefined,
      task,
      context: args.context ? String(args.context) : undefined,
      toolNames: Array.isArray(args.tools) ? args.tools.map((s: any) => String(s)) : undefined,
      maxSteps: Number(args.max_steps) || 15,
      timeoutMs: Math.round((Number(args.timeout_s) || 300) * 1000),
    },
    llm,
    services.tools ?? new Map(),
  );

  // 阻塞模式：等待结果（wait=true 或旧名 no_wait=false）
  const shouldWait = args.wait === true || args.no_wait === false;
  if (shouldWait) {
    const waitMs = Math.round((Number(args.wait_s) || 120) * 1000);
    const done = await manager.awaitResult(handle.id, waitMs);
    if (!done || done.status !== 'done') {
      return JSON.stringify({
        status: 'error',
        data: {
          subagent_id: handle.id,
          status: done?.status ?? 'unknown',
          message: done?.error || `子 Agent 未在 ${waitMs / 1000}s 内完成`,
        },
      });
    }
    return JSON.stringify({
      status: 'ok',
      data: {
        subagent_id: handle.id,
        status: 'done',
        result: done.result,
        elapsed_ms: (done.finishedAt ?? Date.now()) - done.startedAt,
      },
    });
  }

  return JSON.stringify({
    status: 'ok',
    data: {
      subagent_id: handle.id,
      status: 'running',
      message: `子 Agent "${handle.id}" 已启动，用 subagent(action="await", subagent_id) 获取结果`,
    },
  });
}

/** 中断并回收子 Agent（action=kill） */
async function killSubagent(services: ToolContext, args: Record<string, any>): Promise<string> {
  const manager = services.subAgent as SubAgentManager;
  if (!manager) return JSON.stringify({ status: 'error', data: { message: 'subAgent 服务未注入 ToolContext' } });
  const id = String(args.subagent_id ?? '');
  if (!id) return JSON.stringify({ status: 'error', data: { message: '缺少 subagent_id 参数' } });
  const ok = manager.kill(id);
  if (!ok) return JSON.stringify({ status: 'error', data: { message: `子 Agent "${id}" 不存在或已回收` } });
  return JSON.stringify({ status: 'ok', data: { subagent_id: id, message: `子 Agent "${id}" 已终止并回收` } });
}

/** 查看活跃子 Agent 状态（action=list） */
async function listSubagents(services: ToolContext): Promise<string> {
  const manager = services.subAgent as SubAgentManager;
  if (!manager) return JSON.stringify({ status: 'error', data: { message: 'subAgent 服务未注入 ToolContext' } });
  const list = manager.list().map(h => ({
    id: h.id,
    parent: h.parentId,
    name: h.name,
    status: h.status,
    task: h.task.slice(0, 80),
    started_at: new Date(h.startedAt).toLocaleTimeString('zh-CN'),
    elapsed_ms: (h.finishedAt ?? Date.now()) - h.startedAt,
  }));
  return JSON.stringify({ status: 'ok', data: { active_count: list.length, subagents: list } });
}

/** 等待子 Agent 完成并获取结果（action=await） */
async function awaitSubagent(services: ToolContext, args: Record<string, any>): Promise<string> {
  const manager = services.subAgent as SubAgentManager;
  if (!manager) return JSON.stringify({ status: 'error', data: { message: 'subAgent 服务未注入 ToolContext' } });
  const id = String(args.subagent_id ?? '');
  if (!id) return JSON.stringify({ status: 'error', data: { message: '缺少 subagent_id 参数' } });

  const waitMs = Math.round((Number(args.wait_s) || 60) * 1000);

  const cur = manager.get(id);
  if (!cur) {
    return JSON.stringify({ status: 'error', data: { message: `子 Agent "${id}" 不存在或已回收（可能早已完成，结果已丢失）` } });
  }
  if (cur.status !== 'running') {
    return JSON.stringify({
      status: 'ok',
      data: {
        subagent_id: id,
        status: cur.status,
        result: cur.result,
        error: cur.error,
        elapsed_ms: (cur.finishedAt ?? Date.now()) - cur.startedAt,
      },
    });
  }

  const done = await manager.awaitResult(id, waitMs);
  if (!done) return JSON.stringify({ status: 'error', data: { message: `子 Agent "${id}" 已消失` } });
  if (done.status === 'running') {
    return JSON.stringify({
      status: 'ok',
      data: {
        subagent_id: id,
        status: 'running',
        message: `子 Agent 仍在运行（已等待 ${waitMs / 1000}s）。可再次调用 subagent(action="await") 或 subagent(action="kill")。`,
      },
    });
  }
  return JSON.stringify({
    status: 'ok',
    data: {
      subagent_id: id,
      status: done.status,
      result: done.result,
      error: done.error,
      elapsed_ms: (done.finishedAt ?? Date.now()) - done.startedAt,
    },
  });
}

/** subagent 工具工厂（requires:[CAPABILITY_CONDUCTOR]） */
export function makeSubagentTool(_config: AgentConfig, services: ToolContext): Tool {
  return defineTool({
    name: 'subagent', label: '子 Agent 调度', requires: [CAPABILITY_CONDUCTOR],
    description: '子 Agent 调度（独立上下文、受控工具集、无持久化的并行执行单元）。适合把复杂任务拆成多个独立子任务并行处理。action 指定操作：spawn 创建（返回 subagent_id，异步运行；设 wait=true 可阻塞等待结果）；await 等待指定子任务完成并取结果（subagent_id 必填，wait_s 控制等待秒数）；list 查看全部活跃子任务及状态；kill 中断并回收（subagent_id 必填）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['spawn', 'list', 'await', 'kill'], description: '操作：spawn 创建 / list 查询 / await 等待结果 / kill 终止' },
        task: { type: 'string', description: '[spawn] 任务描述（子 Agent 的独立指令，需完整自包含）' },
        name: { type: 'string', description: '[spawn] 子 Agent 显示名称（可选，便于 list 区分）' },
        tools: { type: 'array', items: { type: 'string' }, description: '[spawn] 工具名数组（从你的工具中筛选，如 ["read","write","bash","edit"]）。留空则无工具（纯推理）' },
        context: { type: 'string', description: '[spawn] 附加上下文（子任务所需的背景信息）' },
        max_steps: { type: 'number', description: '[spawn] ReAct 步数上限（默认 15）' },
        timeout_s: { type: 'number', description: '[spawn] 超时秒数（默认 300）' },
        wait: { type: 'boolean', description: '[spawn] 是否阻塞等待结果（默认 false=异步立即返回，稍后用 await 取；true=阻塞等待）' },
        no_wait: { type: 'boolean', description: '[spawn 旧名] 是否异步立即返回（默认 true）。与 wait 相反，新代码请用 wait。' },
        wait_s: { type: 'number', description: '[spawn wait=true 或 await] 等待秒数（默认 120；超时任务仍在后台，可再次 await）' },
        subagent_id: { type: 'string', description: '[await/kill] 子 Agent ID（spawn 返回）' },
      },
      required: ['action'],
    },
    extractLabel: (args) => {
      const action = args.action || '?';
      if (action === 'spawn') {
        const t = String(args.task || '').slice(0, 40);
        const tools = Array.isArray(args.tools) && args.tools.length ? ` [${args.tools.length}工具]` : '';
        const wait = args.wait === true ? ' [等待]' : '';
        return `子任务: ${t}${tools}${wait}`;
      }
      if (action === 'await') return `⌛ 等待: ${args.subagent_id || '?'}`;
      if (action === 'kill') return `终止: ${args.subagent_id || '?'}`;
      return '子Agent';
    },
    execute: async (args) => {
      try {
        const action = args.action;
        switch (action) {
          case 'spawn':
            return spawnSubagent(_config.agent_id, services, args);
          case 'kill':
            return killSubagent(services, args);
          case 'list':
            return listSubagents(services);
          case 'await':
            return awaitSubagent(services, args);
          default:
            return JSON.stringify({ status: 'error', data: { message: `未知 action "${action}"，应为 spawn/list/await/kill 之一` } });
        }
      } catch (err: any) {
        return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
      }
    },
  });
}

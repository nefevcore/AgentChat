// ============================================================
// src/plugins/builtin/tools/subagent.ts —— 子 Agent 工具（spawn/kill/list/await_subagent）
//
// 迁移自旧 mod 的 tools/{spawn_subagent,kill_subagent,list_subagents,await_subagent}，
// 按领域聚合。服务经 PluginServices.subAgent 注入；父 LLM/工具集经 PluginServices
// 的 llm/tools 注入（替代旧 getAppState().registry.getAgent(parent).getLLM()/getTools()）。
//
// 依赖方向：仅依赖本层 services/subagent + @agents/config + @core/types + define-tool + 本层 types。
// ============================================================

import { defineTool } from '../../define-tool';
import type { AgentConfig } from '@agents/config';
import type { Tool } from '@core/types';
import type { PluginServices } from '../../types';

/** spawn_subagent 工具：创建子 Agent 执行独立子任务（照搬旧） */
export function makeSpawnSubagentTool(config: AgentConfig, services: PluginServices): Tool {
  const selfId = config.agent_id;
  return defineTool({
    name: 'spawn_subagent', label: '创建子 Agent', requires: ['conductor'],
    description: '创建子 Agent 独立执行子任务。子 Agent 具有隔离上下文（仅任务+上下文）、无持久化、受控工具集。返回 subagent_id，稍后用 await_subagent 获取结果。适合并行分解复杂任务。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '任务描述（子 Agent 的独立指令，需完整自包含）' },
        tools: { type: 'array', items: { type: 'string' }, description: '工具名数组（从你的工具中筛选，如 ["read","write","bash","edit"]）。留空则无工具（纯推理）' },
        context: { type: 'string', description: '附加上下文（子任务所需的背景信息）' },
        max_turns: { type: 'number', description: 'ReAct 轮次上限（默认 15）' },
        timeout_s: { type: 'number', description: '超时秒数（默认 300）' },
        no_wait: { type: 'boolean', description: '是否立即返回（默认 true，稍后 await_subagent 取结果；false 则阻塞等待）' },
        wait_s: { type: 'number', description: 'no_wait=false 时阻塞等待秒数（默认 120）' },
      },
      required: ['task'],
    },
    extractLabel: (args) => {
      const t = String(args.task || '').slice(0, 40);
      const tools = Array.isArray(args.tools) && args.tools.length ? ` [${args.tools.length}工具]` : '';
      const wait = args.no_wait === false ? ' [等待]' : '';
      return `子任务: ${t}${tools}${wait}`;
    },
    execute: async (args) => {
      try {
        const manager = services.subAgent;
        if (!manager) return JSON.stringify({ status: 'error', data: { message: 'subAgent 服务未注入 PluginServices' } });
        const llm = services.llm;
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
            maxTurns: Number(args.max_turns) || 15,
            timeoutMs: Math.round((Number(args.timeout_s) || 300) * 1000),
          },
          llm,
          services.tools ?? new Map(),
        );

        // 阻塞模式：等待结果
        if (args.no_wait === false) {
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
            message: `子 Agent "${handle.id}" 已启动，用 await_subagent(subagent_id) 获取结果`,
          },
        });
      } catch (err: any) {
        return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
      }
    },
  });
}

/** kill_subagent 工具：中断并回收子 Agent（照搬旧） */
export function makeKillSubagentTool(_config: AgentConfig, services: PluginServices): Tool {
  return defineTool({
    name: 'kill_subagent', label: '终止子 Agent', requires: ['conductor'],
    description: '中断并回收运行中的子 Agent，释放其 token 预算。用于子任务不再需要或卡住时。',
    parameters: {
      type: 'object',
      properties: { subagent_id: { type: 'string', description: '要终止的子 Agent ID' } },
      required: ['subagent_id'],
    },
    extractLabel: (args) => `终止: ${args.subagent_id || '?'}`,
    execute: async (args) => {
      try {
        const manager = services.subAgent;
        if (!manager) return JSON.stringify({ status: 'error', data: { message: 'subAgent 服务未注入 PluginServices' } });
        const id = String(args.subagent_id ?? '');
        if (!id) return JSON.stringify({ status: 'error', data: { message: '缺少 subagent_id 参数' } });
        const ok = manager.kill(id);
        if (!ok) return JSON.stringify({ status: 'error', data: { message: `子 Agent "${id}" 不存在或已回收` } });
        return JSON.stringify({ status: 'ok', data: { subagent_id: id, message: `子 Agent "${id}" 已终止并回收` } });
      } catch (err: any) {
        return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
      }
    },
  });
}

/** list_subagents 工具：查看活跃子 Agent 状态（照搬旧） */
export function makeListSubagentsTool(_config: AgentConfig, services: PluginServices): Tool {
  return defineTool({
    name: 'list_subagents', label: '子 Agent 清单', requires: ['conductor'],
    description: '列出所有活跃子 Agent 及其状态（running/done/error/timeout/killed）。用于查看已生成子任务的处理进度。',
    parameters: { type: 'object', properties: {} },
    extractLabel: () => '子Agent',
    execute: async () => {
      try {
        const manager = services.subAgent;
        if (!manager) return JSON.stringify({ status: 'error', data: { message: 'subAgent 服务未注入 PluginServices' } });
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
      } catch (err: any) {
        return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
      }
    },
  });
}

/** await_subagent 工具：等待子 Agent 完成并获取结果（照搬旧） */
export function makeAwaitSubagentTool(_config: AgentConfig, services: PluginServices): Tool {
  return defineTool({
    name: 'await_subagent', label: '等待子 Agent', requires: ['conductor'],
    description: '等待子 Agent 完成并返回其结果。使用 spawn_subagent 返回的 subagent_id。返回状态：running/done/error/timeout/killed。',
    parameters: {
      type: 'object',
      properties: {
        subagent_id: { type: 'string', description: '子 Agent ID（spawn_subagent 返回）' },
        wait_s: { type: 'number', description: '等待秒数（默认 60；超时任务仍在后台，可再次调用）' },
      },
      required: ['subagent_id'],
    },
    extractLabel: (args) => `⌛ 等待: ${args.subagent_id || '?'}`,
    execute: async (args) => {
      try {
        const manager = services.subAgent;
        if (!manager) return JSON.stringify({ status: 'error', data: { message: 'subAgent 服务未注入 PluginServices' } });
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
              message: `子 Agent 仍在运行（已等待 ${waitMs / 1000}s）。可再次调用 await_subagent 或 kill_subagent。`,
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
      } catch (err: any) {
        return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
      }
    },
  });
}

/** 子 Agent 工具工厂 */
export function makeSubagentTools(config: AgentConfig, services: PluginServices): Tool[] {
  return [
    makeSpawnSubagentTool(config, services),
    makeKillSubagentTool(config, services),
    makeListSubagentsTool(config, services),
    makeAwaitSubagentTool(config, services),
  ];
}

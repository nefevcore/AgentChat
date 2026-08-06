// ============================================================
// spawn_subagent 工具 —— 创建子 Agent 执行独立子任务
//
// 用途：
//   父 Agent 将复杂任务拆分为子任务，spawn 子 Agent 并行/独立执行。
//   子 Agent 无持久化（不写 sessions）、独立上下文（只含任务+上下文）、
//   受控工具集（从父 Agent 工具中按名筛选）。
//
// 参数：
//   task       – 任务描述（必填，子 Agent 的独立指令）
//   tools      – 工具名数组（从父 Agent 工具中筛选，如 ["read","write","bash"]）
//   context    – 附加上下文（可选，子 Agent 执行所需背景）
//   max_turns  – ReAct 轮次上限（默认 15，防失控）
//   timeout_s  – 超时秒数（默认 300s）
//   no_wait    – 是否立即返回不等待（默认 true，随后 await_subagent 获取结果）
//   wait_s     – no_wait=false 时阻塞等待秒数（默认 120s）
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { getAppState } from '@core/app-state';
import { getSubAgentManager } from '@plugins/builtin/src/sub-agent';
import type { AgentRegistry } from '@agents/registry';
import type { Agent } from '@core/agent';

export const tool: Tool = {
  ...meta,

  definition: {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description:
        '创建子 Agent 独立执行子任务。子 Agent 具有隔离上下文（仅任务+上下文）、无持久化、受控工具集。返回 subagent_id，稍后用 await_subagent 获取结果。适合并行分解复杂任务。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '任务描述（子 Agent 的独立指令，需完整自包含）' },
          tools: {
            type: 'array', items: { type: 'string' },
            description: '工具名数组（从你的工具中筛选，如 ["read","write","bash","edit"]）。留空则无工具（纯推理）',
          },
          context: { type: 'string', description: '附加上下文（子任务所需的背景信息）' },
          max_turns: { type: 'number', description: 'ReAct 轮次上限（默认 15）' },
          timeout_s: { type: 'number', description: '超时秒数（默认 300）' },
          no_wait: { type: 'boolean', description: '是否立即返回（默认 true，稍后 await_subagent 取结果；false 则阻塞等待）' },
          wait_s: { type: 'number', description: 'no_wait=false 时阻塞等待秒数（默认 120）' },
        },
        required: ['task'],
      },
    },
  },

  extractLabel: (args: Record<string, any>) => {
    const t = String(args.task || '').slice(0, 40);
    const tools = Array.isArray(args.tools) && args.tools.length ? ` [${args.tools.length}工具]` : '';
    const wait = args.no_wait === false ? ' [等待]' : '';
    return `⇣ 子任务: ${t}${tools}${wait}`;
  },

  execute: async (args: Record<string, any>) => {
    try {
      const from = args.from as string;
      const state = getAppState();
      const registry = state.registry as AgentRegistry;
      if (!registry || !registry.has(from)) {
        return JSON.stringify({ status: 'error', data: { message: `发送方 "${from}" 不在注册表中` } });
      }
      const parent = registry.getAgent(from) as Agent;
      if (!parent || !parent.getLLM()) {
        return JSON.stringify({ status: 'error', data: { message: `父 Agent "${from}" 无 LLM，无法 spawn 子 Agent` } });
      }

      const task = String(args.task ?? '').trim();
      if (!task) {
        return JSON.stringify({ status: 'error', data: { message: '缺少 task 参数' } });
      }

      const manager = getSubAgentManager();
      const handle = await manager.spawn(
        {
          parentId: from,
          name: args.name ? String(args.name) : undefined,
          task,
          context: args.context ? String(args.context) : undefined,
          toolNames: Array.isArray(args.tools) ? args.tools.map((s: any) => String(s)) : undefined,
          maxTurns: Number(args.max_turns) || 15,
          timeoutMs: Math.round((Number(args.timeout_s) || 300) * 1000),
        },
        parent.getLLM()!,
        parent.getTools(),
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

      // 异步模式：立即返回 id
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
};

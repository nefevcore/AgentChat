// ============================================================
// src/plugins/builtin/tools/timer.ts —— 定时任务工具（单一 timer，action 分发）
//
// 合并自旧 tools/{set_timer,list_timers,disable_timer}：
// 定时任务的管理（创建/修改 → 查询 → 禁用）是同一对象上的生命周期操作，
// 拆成 3 个工具增加 LLM 心智负担与 tool 定义 token。合并为单一 `timer`
// 工具 + action 枚举（set/list/disable），描述统一说清 5 种模式。
//
// timer 服务经 ToolContext.timer 注入（替代旧 timerManager 全局单例）。
//
// 依赖方向：仅依赖本层 services/timer + @agents/config + @core/types + define-tool + 本层 types。
// ============================================================

import { defineTool } from '@agentchat/toolkit';
import { CAPABILITY_BASE, type AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';
import type { ToolContext } from '@agentchat/tools';
import type { TimerEntry, TimerManager } from './timer';

/** action=set：添加或修改定时任务 */
function setTimerEntry(
  selfId: string,
  services: ToolContext,
  args: Record<string, any>,
): string {
  const timer = services.timer as TimerManager;
  if (!timer) return '[timer] 错误：timer 服务未注入 ToolContext';
  const agentId = selfId;
  if (!agentId) return '[timer] 错误：无法确定 Agent ID';

  const entries = [...timer.getEntries(agentId)];
  const id = args.id || `timer-${Date.now()}`;
  const existing = entries.findIndex(e => e.id === id);

  const entry: TimerEntry = {
    id,
    enabled: true,
    mode: args.mode || 'delay',
    // snake_case（schema 正典）→ camelCase（TimerEntry 持久化字段）
    repeatCount: (args.repeat_count ?? args.repeatCount) ?? 0,
    hint: args.hint || '',
    target: args.target || 'user',
    source: args.source,
    maxSteps: args.max_steps ?? args.maxSteps,
    ...(args.mode === 'delay' ? { delay: args.delay || '1h' }
      : args.mode === 'random' ? { delayMin: (args.delay_min ?? args.delayMin) || '30s', delayMax: (args.delay_max ?? args.delayMax) || '5m' }
      : { time: args.time || '08:00' }),
  };

  if (existing >= 0) {
    entries[existing] = entry;
  } else {
    entries.push(entry);
  }
  if (args.replace) {
    const replaceIdx = entries.findIndex((e: TimerEntry) => e.id === args.replace);
    if (replaceIdx >= 0 && replaceIdx !== existing) entries.splice(replaceIdx, 1);
  }

  timer.saveEntries(agentId, entries);
  const label = entry.mode === 'delay' ? `每 ${entry.delay}`
    : entry.mode === 'random' ? `随机 ${entry.delayMin || '30s'}~${entry.delayMax || '5m'}`
    : entry.mode === 'workday' ? `工作日 ${entry.time}`
    : entry.mode === 'holiday' ? `节假日 ${entry.time}`
    : `每天 ${entry.time}`;
  const action = existing >= 0 ? '已更新' : '已添加';
  return `定时任务 "${id}" ${action}：${label}，重复 ${(entry.repeatCount ?? 0) <= 0 ? '永久' : entry.repeatCount + '次'}，目标 ${entry.target || 'user'}`;
}

/** action=list：查询 Agent 的定时任务 */
function listTimerEntries(
  selfId: string,
  services: ToolContext,
): string {
  const timer = services.timer as TimerManager;
  if (!timer) return '[timer] 错误：timer 服务未注入 ToolContext';
  const agentId = selfId;
  if (!agentId) return '[timer] 错误：无法确定 Agent ID';
  const entries = timer.getEntries(agentId);
  if (entries.length === 0) {
    return `Agent "${agentId}" 没有配置定时任务。`;
  }
  const list = entries.map(e =>
    `- ${e.id} [${e.enabled ? '启用' : '禁用'}] ${e.mode === 'delay' ? '延时 每' + (e.delay || '?') : e.mode === 'random' ? '随机 ' + (e.delayMin || '30s') + '~' + (e.delayMax || '5m') : e.mode === 'workday' ? '工作日 ' + (e.time || '?') : e.mode === 'holiday' ? '节假日 ' + (e.time || '?') : '定时 ' + (e.time || '?')} × ${(e.repeatCount ?? 0) <= 0 ? '永久' : (e.repeatCount + '次')} -> ${e.target || 'user'}: ${e.hint}`
  ).join('\n');
  return `Agent "${agentId}" 的定时任务：\n${list}`;
}

/** action=disable：禁用定时任务（不删除） */
function disableTimerEntry(
  selfId: string,
  services: ToolContext,
  args: Record<string, any>,
): string {
  const timer = services.timer as TimerManager;
  if (!timer) return '[timer] 错误：timer 服务未注入 ToolContext';
  const agentId = selfId;
  if (!agentId) return '[timer] 错误：无法确定 Agent ID';
  const id = args.id;
  if (!id) return '[timer] 错误：缺少 id 参数';

  const entries = timer.getEntries(agentId);
  const idx = entries.findIndex(e => e.id === id);
  if (idx < 0) {
    return `[timer] 未找到任务 "${id}"。可用：${entries.map(e => e.id).join(', ') || '(无)'}`;
  }

  entries[idx] = { ...entries[idx], enabled: false };
  timer.saveEntries(agentId, entries);
  return `定时任务 "${id}" 已禁用。可通过 timer(action="set") 重新启用。`;
}

/** timer 工具工厂（requires:[CAPABILITY_BASE]） */
export function makeTimerTool(config: AgentConfig, services: ToolContext): Tool {
  const selfId = config.agent_id;
  return defineTool({
    name: 'timer', label: '定时任务', requires: [CAPABILITY_BASE],
    description: '管理定时任务：set 创建/修改、list 查看、disable 禁用。模式：delay 固定间隔 / random 随机间隔 / time 每天定点 / workday 工作日 / holiday 节假日；repeat_count=0 永久重复，N 次后自动归档。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'list', 'disable'], description: '操作' },
        id: { type: 'string', description: '[set] 任务 ID（更新时必填）；[disable] 要禁用的任务' },
        mode: { type: 'string', description: '[set] 模式', enum: ['delay', 'random', 'time', 'workday', 'holiday'] },
        delay: { type: 'string', description: '[set] 间隔（如 5m/1h）' },
        delay_min: { type: 'string', description: '[set] 最小间隔（random 模式）' },
        delay_max: { type: 'string', description: '[set] 最大间隔（random 模式）' },
        time: { type: 'string', description: '[set] 触发时刻（如 08:00 或 2026-07-27 14:30）' },
        repeat_count: { type: 'number', description: '[set] 重复次数（0 = 永久）', minimum: 0 },
        hint: { type: 'string', description: '[set] 触发时发给 Agent 的提示' },
        target: { type: 'string', description: '[set] 发送目标（逗号分隔，默认 user）' },
        source: { type: 'string', description: '[set] 来源标识' },
      },
      required: ['action'],
    },
    extractLabel: (args) => {
      const action = args.action || '?';
      if (action === 'set') return `${args.mode || 'delay'} ${args.time || args.delay || ''}`;
      if (action === 'disable') return `禁用: ${args.id || '?'}`;
      return action === 'list' ? '定时任务' : action;
    },
    execute: async (args) => {
      const action = args.action;
      switch (action) {
        case 'set':
          return setTimerEntry(selfId, services, args);
        case 'list':
          return listTimerEntries(selfId, services);
        case 'disable':
          return disableTimerEntry(selfId, services, args);
        default:
          return `[timer] 错误：未知 action "${action}"，应为 set/list/disable 之一。`;
      }
    },
  });
}

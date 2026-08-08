// ============================================================
// src/plugins/builtin/tools/timer.ts —— 定时任务工具（set_timer/list_timers/disable_timer）
//
// 迁移自旧 mod 的 tools/{set_timer,list_timers,disable_timer}，按领域聚合。
// timer 服务经 PluginServices.timer 注入（替代旧 timerManager 全局单例）。
//
// 依赖方向：仅依赖本层 services/timer + @agents/config + @core/types + define-tool + 本层 types。
// ============================================================

import { defineTool } from '../../define-tool';
import type { AgentConfig } from '@agents/config';
import type { Tool } from '@core/types';
import type { PluginServices } from '../../types';
import type { TimerEntry } from '../services/timer';

/** set_timer 工具：添加或修改定时任务（照搬旧） */
export function makeSetTimerTool(config: AgentConfig, services: PluginServices): Tool {
  const selfId = config.agent_id;
  return defineTool({
    name: 'set_timer', label: '设置定时任务', requires: ['agent'],
    description: '添加或修改定时任务。模式：delay(延时)/random(随机)/time(定时)/workday(工作日)/holiday(节假日)。例行任务用 repeatCount=0 永久；一次性提醒用 repeatCount=1 并在 time 填完整日期时间（如 2026-08-03 09:00），完成后自动归档。target 逗号分隔，默认 user。提供 id 则更新，否则新建。replace 指定要替换掉的旧任务 ID（新建时替掉旧任务，避免累积）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 ID（新建时可省略，更新时必填）' },
        replace: { type: 'string', description: '要替换的旧任务 ID，新任务创建后自动删除旧任务' },
        mode: { type: 'string', description: '模式', enum: ['delay', 'random', 'time', 'workday', 'holiday'] },
        delay: { type: 'string', description: '固定间隔（mode=delay），如 5m/1h' },
        delayMin: { type: 'string', description: '最小间隔（mode=random），如 30s' },
        delayMax: { type: 'string', description: '最大间隔（mode=random），如 5m' },
        time: { type: 'string', description: '定时时刻（mode=time），如 08:00 或 2026-07-27 14:30' },
        repeatCount: { type: 'number', description: '重复次数：0=永久（例行任务），N=N次（N 次后自动归档）' },
        hint: { type: 'string', description: '触发时发送给 Agent 的提示' },
        target: { type: 'string', description: '结果发送目标，逗号分隔，默认 user' },
        source: { type: 'string', description: '来源标识（日志用）' },
        maxTurns: { type: 'number', description: '最大 ReAct 轮次，默认不限制' },
      },
      required: ['mode', 'hint'],
    },
    extractLabel: (args) => `${args.mode || 'delay'} ${args.time || args.delay || ''}`,
    execute: async (args) => {
      const timer = services.timer;
      if (!timer) return '[set_timer] 错误：timer 服务未注入 PluginServices';
      const agentId = selfId;
      if (!agentId) return '[set_timer] 错误：无法确定 Agent ID';

      const entries = [...timer.getEntries(agentId)];
      const id = args.id || `timer-${Date.now()}`;
      const existing = entries.findIndex(e => e.id === id);

      const entry: TimerEntry = {
        id,
        enabled: true,
        mode: args.mode || 'delay',
        repeatCount: args.repeatCount ?? 0,
        hint: args.hint || '',
        target: args.target || 'user',
        source: args.source,
        maxTurns: args.maxTurns,
        ...(args.mode === 'delay' ? { delay: args.delay || '1h' }
          : args.mode === 'random' ? { delayMin: args.delayMin || '30s', delayMax: args.delayMax || '5m' }
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
    },
  });
}

/** list_timers 工具：查询 Agent 的定时任务（照搬旧） */
export function makeListTimersTool(config: AgentConfig, services: PluginServices): Tool {
  const selfId = config.agent_id;
  return defineTool({
    name: 'list_timers', label: '定时任务清单', requires: ['agent'],
    description: '查询当前 Agent 的所有定时任务（ID、状态、模式、时间/间隔、提示内容）。',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const timer = services.timer;
      if (!timer) return '[list_timers] 错误：timer 服务未注入 PluginServices';
      const agentId = selfId;
      if (!agentId) return '[list_timers] 错误：无法确定 Agent ID';
      const entries = timer.getEntries(agentId);
      if (entries.length === 0) {
        return `Agent "${agentId}" 没有配置定时任务。`;
      }
      const list = entries.map(e =>
        `- ${e.id} [${e.enabled ? '启用' : '禁用'}] ${e.mode === 'time' ? '定时 ' + (e.time || '?') : '延时 每' + (e.delay || '?')} × ${(e.repeatCount ?? 0) <= 0 ? '永久' : (e.repeatCount + '次')} -> ${e.target || 'user'}: ${e.hint}`
      ).join('\n');
      return `Agent "${agentId}" 的定时任务：\n${list}`;
    },
  });
}

/** disable_timer 工具：禁用定时任务（不删除）（照搬旧） */
export function makeDisableTimerTool(config: AgentConfig, services: PluginServices): Tool {
  const selfId = config.agent_id;
  return defineTool({
    name: 'disable_timer', label: '禁用定时任务', requires: ['agent'],
    description: '禁用指定定时任务（不删除，可通过 set_timer 重新启用）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '任务 ID（通过 list_timers 查看）' } },
      required: ['id'],
    },
    execute: async (args) => {
      const timer = services.timer;
      if (!timer) return '[disable_timer] 错误：timer 服务未注入 PluginServices';
      const agentId = selfId;
      if (!agentId) return '[disable_timer] 错误：无法确定 Agent ID';
      const id = args.id;
      if (!id) return '[disable_timer] 错误：缺少 id 参数';

      const entries = timer.getEntries(agentId);
      const idx = entries.findIndex(e => e.id === id);
      if (idx < 0) {
        return `[disable_timer] 未找到任务 "${id}"。可用：${entries.map(e => e.id).join(', ') || '(无)'}`;
      }

      entries[idx] = { ...entries[idx], enabled: false };
      timer.saveEntries(agentId, entries);
      return `定时任务 "${id}" 已禁用。可通过 set_timer 重新启用。`;
    },
    extractLabel: (args) => `${args.id || '?'}`,
  });
}

/** 定时任务工具工厂 */
export function makeTimerTools(config: AgentConfig, services: PluginServices): Tool[] {
  return [
    makeSetTimerTool(config, services),
    makeListTimersTool(config, services),
    makeDisableTimerTool(config, services),
  ];
}

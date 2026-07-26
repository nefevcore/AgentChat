// ============================================================
// set_timer 工具 —— 添加或修改 Agent 的定时任务
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { timerManager } from '@core/timer-manager';
import type { TimerEntry } from '@core/types';

export const tool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'set_timer',
      description:
        '添加或修改定时任务。' +
        '模式：delay(延时)/random(随机)/time(定时)/workday(工作日)/holiday(节假日)。' +
        'repeatCount=0 永久，N 次后停止。target 逗号分隔，默认 user。提供 id 则更新，否则新建。',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Agent ID（自动注入）' },
          id: { type: 'string', description: '任务 ID（新建时可省略）' },
          mode: { type: 'string', description: '模式', enum: ['delay', 'random', 'time', 'workday', 'holiday'] },
          delay: { type: 'string', description: '固定间隔（mode=delay），如 5m/1h' },
          delayMin: { type: 'string', description: '最小间隔（mode=random），如 30s' },
          delayMax: { type: 'string', description: '最大间隔（mode=random），如 5m' },
          time: { type: 'string', description: '定时时刻（mode=time），如 08:00 或 2026-07-27 14:30' },
          repeatCount: { type: 'number', description: '重复次数：0=永久，N=N次' },
          hint: { type: 'string', description: '触发时发送给 Agent 的提示' },
          target: { type: 'string', description: '结果发送目标，逗号分隔，默认 user' },
          source: { type: 'string', description: '来源标识（日志用）' },
          maxTurns: { type: 'number', description: '最大 ReAct 轮次，默认 5' },
        },
        required: ['mode', 'hint'],
      },
    },
  },
  ...meta,

  execute: async (args: Record<string, any>) => {
    const agentId = args.agent_id || args.from;
    if (!agentId) return '[set_timer] 错误：无法确定 Agent ID';

    const entries = [...timerManager.getEntries(agentId)];
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

    timerManager.saveEntries(agentId, entries);
    const label = entry.mode === 'delay' ? `每 ${entry.delay}`
      : entry.mode === 'random' ? `随机 ${entry.delayMin || '30s'}~${entry.delayMax || '5m'}`
      : entry.mode === 'workday' ? `工作日 ${entry.time}`
      : entry.mode === 'holiday' ? `节假日 ${entry.time}`
      : `每天 ${entry.time}`;
    const action = existing >= 0 ? '已更新' : '已添加';
    return `定时任务 "${id}" ${action}：${label}，重复 ${(entry.repeatCount ?? 0) <= 0 ? '永久' : entry.repeatCount + '次'}，目标 ${entry.target || 'user'}`;
  },
};

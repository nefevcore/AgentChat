// ============================================================
// ac-timer-tools —— 定时任务工具行（timer 工具：set/list/disable）
//
// src svc/timer/src/tool.ts 平移（M15 对账补齐：服务链路 M12 已就绪、
// LLM 工具面此前缺失——用户无法通过对话创建/管理定时任务）。
// 形态差异：src 经 ToolContext.timer 注入 → preview inject ['timers']；
// owner 从 config.agent_id 烘焙 → call.agentId 执行身份（M11）。
// 单一 timer 工具 + action 枚举（src 合并语义原样：同一对象的生命
// 周期操作拆三工具徒增 LLM 心智负担）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';
import type { TimerEntry } from 'ac-timer-core';
import { describeEntry } from 'ac-timer-core';

function err(message: string): ToolResult {
  return { ok: false, error: message };
}

/** 条目标签（src 语义） */
function entryLabel(entry: TimerEntry): string {
  const repeat = (entry.repeatCount ?? 0) <= 0 ? '永久' : `${entry.repeatCount}次`;
  const target = entry.task
    ? `机制任务 ${entry.task}`
    : `目标 ${entry.target || '本人'}`;
  return `${describeEntry(entry)} × ${repeat}，${target}`;
}

export const name = 'ac-timer-tools';

export const inject = ['tools', 'timers', 'agents'];

export function apply(ctx: Context) {
  ctx.tools.register({
    name: 'timer',
    description:
      '管理定时任务：set 创建/修改、list 查看、disable 禁用。模式：delay 固定间隔 / random 随机间隔 / time 每天定点 / workday 工作日 / holiday 节假日；repeat_count=0 永久重复，N 次后自动归档。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'list', 'disable'], description: '操作' },
        id: { type: 'string', description: '[set] 任务 ID（更新时必填）；[disable] 要禁用的任务' },
        mode: { type: 'string', enum: ['delay', 'random', 'time', 'workday', 'holiday'], description: '[set] 模式' },
        delay: { type: 'string', description: '[set] 间隔（如 5m/1h）' },
        delay_min: { type: 'string', description: '[set] 最小间隔（random 模式）' },
        delay_max: { type: 'string', description: '[set] 最大间隔（random 模式）' },
        time: { type: 'string', description: '[set] 触发时刻（如 08:00 或 2026-07-27 14:30）' },
        repeat_count: { type: 'number', description: '[set] 重复次数（0 = 永久）', minimum: 0 },
        hint: { type: 'string', description: '[set] 触发时发给 Agent 的提示' },
        target: { type: 'string', description: '[set] 发送目标（逗号分隔；per-Agent 条目仅本人，忽略此参数）' },
      },
      required: ['action'],
    },
    async execute(args, call): Promise<ToolResult> {
      try {
        const agentId = call.agentId;
        if (agentId === undefined) return err('缺少执行身份（agentId）——timer 需在 Agent run 内调用');
        const action = String(args.action ?? '');

        // ---- list ----
        if (action === 'list') {
          const entries = ctx.timers.entries(agentId);
          return {
            ok: true,
            output: {
              agent: agentId,
              count: entries.length,
              entries: entries.map((e) => ({
                id: e.id,
                enabled: e.enabled !== false,
                mode: e.mode,
                label: entryLabel(e),
                hint: e.hint,
              })),
            },
          };
        }

        // ---- disable ----
        if (action === 'disable') {
          const id = typeof args.id === 'string' ? args.id.trim() : '';
          if (!id) return err('缺少 id 参数');
          const entries = ctx.timers.entries(agentId);
          const target = entries.find((e) => e.id === id);
          if (!target) {
            return err(`未找到任务 "${id}"。可用：${entries.map((e) => e.id).join(', ') || '(无)'}`);
          }
          ctx.timers.save(agentId, entries.map((e) => (e.id === id ? { ...e, enabled: false } : e)));
          return {
            ok: true,
            output: { id, message: `定时任务 "${id}" 已禁用。可通过 timer(action="set") 重新启用。` },
          };
        }

        // ---- set ----
        if (action === 'set') {
          const mode = (args.mode ?? 'delay') as TimerEntry['mode'];
          if (!['delay', 'random', 'time', 'workday', 'holiday'].includes(mode)) {
            return err(`未知模式 "${String(mode)}"（delay/random/time/workday/holiday 之一）`);
          }
          const hint = typeof args.hint === 'string' ? args.hint : '';
          if (!hint.trim()) return err('缺少 hint 参数（触发时发给 Agent 的提示）');
          const id = (typeof args.id === 'string' && args.id.trim()) || `timer-${Date.now()}`;
          const entries = ctx.timers.entries(agentId);
          const existing = entries.findIndex((e) => e.id === id);
          const repeatRaw = Number(args.repeat_count);
          const entry: TimerEntry = {
            id,
            enabled: true,
            mode,
            ...(Number.isFinite(repeatRaw) && repeatRaw > 0 ? { repeatCount: Math.floor(repeatRaw) } : {}),
            hint,
            ...(typeof args.target === 'string' && args.target.trim() ? { target: args.target.trim() } : {}),
            ...(mode === 'delay'
              ? { delay: (typeof args.delay === 'string' && args.delay) || '1h' }
              : mode === 'random'
                ? {
                    delayMin: (typeof args.delay_min === 'string' && args.delay_min) || '30s',
                    delayMax: (typeof args.delay_max === 'string' && args.delay_max) || '5m',
                  }
                : { time: (typeof args.time === 'string' && args.time) || '08:00' }),
          };
          const next =
            existing >= 0 ? entries.map((e, i) => (i === existing ? entry : e)) : [...entries, entry];
          ctx.timers.save(agentId, next);
          return {
            ok: true,
            output: {
              id,
              updated: existing >= 0,
              label: entryLabel(entry),
              message: `定时任务 "${id}" ${existing >= 0 ? '已更新' : '已添加'}：${entryLabel(entry)}。`,
            },
          };
        }

        return err(`未知 action "${action}"（set/list/disable 之一）`);
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
}

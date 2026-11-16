// ============================================================
// timer-face.ts —— 宿主能力面贡献行：timer 工具（cr-1121）
//
// cr-886 时 timer 执行面住 ac-host-face/tools.ts（写死清单）；cr-1121
// 真动态化拆出：本行向 hostFaceRegistry 自报 timer 工具 spec +
// GUIDELINES_TIMER 段 + 执行器（HostTimersService 的 LLM 面——排程/
// 唤醒执行全在宿主，壳侧只见代理）。timers 行缺席时本行执行器报
// 「timers 服务未装配」；本行缺席 = timer 面从契约整体消失。
// 双闸：壳闸 = 代理注册面 requiredTags 门禁；宿主闸 = 执行器内复查。
// ============================================================
import type { Context, Plugin } from '@agentchat/cordis';
import { parseInterval, validateTimerEntries, type TimerEntry } from 'ac-timer-core';
import type { HostFaceContribution } from './index.ts';

export const name = 'ac-host-rows/timer-face';

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'timer-face',
  label: '宿主能力面：timer',
  description: 'timer 远程工具 + GUIDELINES_TIMER 段贡献行（host-face 契约注册面；timers 行在场时执行器闭环）',
  automatic: true,
};

const err = (msg: string): { ok: false; error: string } => ({ ok: false, error: msg });

/** timers 服务最小面（HostTimersService——宿主 timers 行在场即有） */
interface TimersFace {
  entries(owner: string): TimerEntry[];
  save(owner: string, entries: TimerEntry[]): void;
}

/** timer 执行器（cr-886 起语义原样——tools.ts executeTimer 搬家） */
function executeTimer(
  ctx: Context,
  args: Record<string, unknown>,
  identity: { agentId?: string; conversationId?: string },
): { ok: boolean; result?: unknown; error?: string } {
  const timers = ctx.get('timers', false) as TimersFace | undefined;
  if (timers === undefined) return err('timers 服务未装配（宿主行集无 timers 行）——定时工具不可用');
  const owner = identity.agentId;
  if (owner === undefined) return err('缺少执行身份（agentId）——timer 需在 Agent run 内调用');
  const action = String(args.action ?? '');
  if (action === 'list') {
    return {
      ok: true,
      result: {
        entries: timers.entries(owner).map((e) => ({
          id: e.id, mode: e.mode,
          time: e.time ?? e.delay ?? (e.delayMin !== undefined || e.delayMax !== undefined ? `${e.delayMin ?? '?'}-${e.delayMax ?? '?'}` : undefined),
          hint: e.hint, enabled: e.enabled,
        })),
      },
    };
  }
  if (action === 'cancel') {
    const id = String(args.entry_id ?? '');
    if (!id) return err('cancel 需要 entry_id');
    const current = timers.entries(owner);
    const next = current.filter((e) => e.id !== id);
    if (next.length === current.length) return err('条目不存在: ' + id);
    timers.save(owner, validateTimerEntries(next));
    return { ok: true, result: { cancelled: id } };
  }
  if (action === 'set') {
    const hint = String(args.hint ?? '').trim();
    const time = String(args.time ?? '').trim();
    if (!hint) return err('set 需要 hint（触发时携带的提示词）');
    if (!time) return err('set 需要 time（时间串）');
    const entry = parseTimerEntry(time, hint, identity.conversationId);
    if (entry === null) return err('无法解析时间串: ' + time + '（支持 HH:mm / YYYY-MM-DDTHH:mm / 周日 12:00 / 30m 间隔）');
    timers.save(owner, validateTimerEntries([...timers.entries(owner), entry]));
    return { ok: true, result: { entry_id: entry.id, mode: entry.mode, time: entry.time ?? entry.delay ?? undefined } };
  }
  return err('未知 action: ' + action);
}

/** 时间串 → 条目（词形与 ac-timer-core 同源；id = t-<随机>） */
function parseTimerEntry(time: string, hint: string, conversationId: string | undefined): TimerEntry | null {
  const id = 't-' + Math.random().toString(36).slice(2, 8);
  const base = { id, enabled: true, hint, ...(conversationId !== undefined ? { conversationId } : {}) } as Partial<TimerEntry>;
  if (/^\d+[smh]$/i.test(time)) {
    if (parseInterval(time) === null) return null;
    return { ...base, mode: 'delay', delay: time } as TimerEntry;
  }
  const weekly = time.match(/^(周一|周二|周三|周四|周五|周六|周日)\s*(\d{1,2}:\d{2})$/);
  if (weekly !== null) return { ...base, mode: 'time', time: `${weekly[1]} ${weekly[2]}` } as TimerEntry;
  if (/^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}$/.test(time)) return { ...base, mode: 'time', time } as TimerEntry;
  if (/^\d{1,2}:\d{2}$/.test(time)) return { ...base, mode: 'time', time } as TimerEntry;
  return null;
}

export function makeTimerFaceRow(): Plugin {
  return {
    name: 'ac-host-rows/timer-face',
    inject: ['hostFaceRegistry'],
    apply(ctx: Context) {
      const contribution: HostFaceContribution = {
        tools: [{
          name: 'timer',
          description:
            '管理定时任务：set 安排一条提醒/延时任务（到点以新消息唤醒你并携带 hint）、list 查看自己的条目、cancel 按 id 取消。会话维度：在哪个会话设置就回哪个会话；时间串支持 HH:mm（每天）/ YYYY-MM-DDTHH:mm（一次）/ 周日 12:00（每周）/ 间隔（30m、1h）。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['set', 'list', 'cancel'], description: '操作' },
              hint: { type: 'string', description: '[set] 触发时携带的提示词（到点唤醒你时看到的指令——写清楚要做什么）' },
              time: { type: 'string', description: '[set] 时间串：HH:mm 每天定点 / YYYY-MM-DDTHH:mm 指定时刻 / 周日 12:00 每周 / 30m 间隔延时' },
              entry_id: { type: 'string', description: '[cancel] 条目 id（list 可见）' },
            },
            required: ['action'],
          },
        }],
        sections: [{
          // 壳内恒无本地 owner——promise 段（可安全进壳 boot 静态面）。
          // cr-944 C：去 notSingle（主动提醒恰在 singles 最有用）。
          name: 'GUIDELINES_TIMER',
          text: '主动安排：发现值得持续跟进或适时提醒的事项时，主动用 timer(action="set") 安排，不必等用户指令。',
          promise: true,
          gate: { toolsAny: ['timer'] },
        }],
        executor: (c, args, identity) => executeTimer(c as Context, args, identity),
      };
      ctx.get('hostFaceRegistry')!.contribute(ctx, 'timer-face', contribution);
    },
  } satisfies Plugin;
}

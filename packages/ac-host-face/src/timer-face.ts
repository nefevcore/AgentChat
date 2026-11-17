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

/**
 * timer list 的视图版本。**只在诊断字段面发生「不兼容变化」时递增**——消费方
 * 应先确认 listVersion 达到自己需要的值，再读对应字段；不要用「某字段缺失」
 * 反推「该状态一致/正常」（2026-11-17 第五例：configStale 缺失被读成「一致」）。
 *   v1：id/mode/time/hint/enabled
 *   v2：+ 原样 delay/gate 等字段、lastAt/nextAt/lagMs、lastSkip*、lastGate*、configStale
 */
const LIST_VERSION = 2;

/** timers 服务最小面（HostTimersService——宿主 timers 行在场即有） */
interface TimersFace {
  entries(owner: string): TimerEntry[];
  /** ok:false = 写前冲突（磁盘被外部改过）——条目未被覆盖，需重取后重试 */
  save(owner: string, entries: TimerEntry[]): { ok: boolean; error?: string };
  /**
   * 存储一致性（缺席 = 旧版 timers 行无此能力）：configStale=true = 磁盘已变、
   * 内存仍是旧视图。新实现恒返回布尔（不返回 undefined）——字段缺失只应表示
   * 「旧代码」，不应同时表示「一致」，否则消费方无法区分。
   */
  storeState?(owner: string): { configStale: boolean };
  /** 排程态快照（缺席 = 旧版 timers 行——list 退回静态字段） */
  scheduleState?(owner: string, entryId: string): {
    lastAt?: string;
    nextAt?: string;
    lagMs?: number;
    lastSkipAt?: string;
    lastSkipReason?: string;
    skipStreak?: number;
    lastGateErrorAt?: string;
    lastGateCode?: number;
    lastGateCodeAt?: string;
  };
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
        // 视图版本（字面量，新代码恒有）：消费方先看它确认「诊断字段是否齐备」，
        // 再读各字段的值。缺席 = 旧版 timers 行（此时下列诊断字段全都没有）。
        listVersion: LIST_VERSION,
        entries: timers.entries(owner).map((e) => ({
          id: e.id, mode: e.mode,
          // time 保持旧行为（日历条目 = HH:mm；间隔/随机条目 = 周期摘要）——
          // 兼容既有消费方，勿改其语义。
          time: e.time ?? e.delay ?? (e.delayMin !== undefined || e.delayMax !== undefined ? `${e.delayMin ?? '?'}-${e.delayMax ?? '?'}` : undefined),
          // 原始字段原样透出（ISSUE-23）：只有 time 一个字段会让消费方把
          // 「delay 模式」误读成「磁盘上是 time 键」——2026-11-17 news 据此
          // 怀疑周期键被改名。列出口径 = 磁盘键名，判断配置变更请读这几个。
          ...(e.delay !== undefined ? { delay: e.delay } : {}),
          ...(e.delayMin !== undefined ? { delayMin: e.delayMin } : {}),
          ...(e.delayMax !== undefined ? { delayMax: e.delayMax } : {}),
          ...(e.gate !== undefined ? { gate: e.gate } : {}),
          ...(e.gateOnError !== undefined ? { gateOnError: e.gateOnError } : {}),
          hint: e.hint, enabled: e.enabled,
          // 排程态（lastAt 上次触发 / nextAt 下次触发的绝对时刻 / lagMs 上次迟到量）：
          // 空窗自查数据源——不必再靠落盘 mtime 反推（ISSUE-22）
          ...(timers.scheduleState?.(owner, e.id) ?? {}),
        })),
        // 内存视图 vs 磁盘：entries 读的是 boot 时的内存副本，改了 entries/timer.json
        // 但本字段为 true 时说明「磁盘已变、尚未生效」——重启/重载后一致（ISSUE-24）。
        // 新代码恒给出 true/false；字段**完全缺席**只表示「跑的是没有 storeState 的
        // 旧行」——缺失 ≠ 一致（2026-11-17 news 指出此处有缺失二义）。
        ...(timers.storeState !== undefined ? { configStale: timers.storeState(owner).configStale } : {}),
      },
    };
  }
  if (action === 'cancel') {
    const id = String(args.entry_id ?? '');
    if (!id) return err('cancel 需要 entry_id');
    const current = timers.entries(owner);
    const next = current.filter((e) => e.id !== id);
    if (next.length === current.length) return err('条目不存在: ' + id);
    const res = timers.save(owner, validateTimerEntries(next));
    if (!res.ok) return err(res.error ?? '保存失败');
    return { ok: true, result: { cancelled: id } };
  }
  if (action === 'set') {
    const hint = String(args.hint ?? '').trim();
    const time = String(args.time ?? '').trim();
    if (!hint) return err('set 需要 hint（触发时携带的提示词）');
    if (!time) return err('set 需要 time（时间串）');
    const entry = parseTimerEntry(time, hint, identity.conversationId);
    if (entry === null) return err('无法解析时间串: ' + time + '（支持 HH:mm / YYYY-MM-DDTHH:mm / 周日 12:00 / 30m 间隔）');
    const res = timers.save(owner, validateTimerEntries([...timers.entries(owner), entry]));
    if (!res.ok) return err(res.error ?? '保存失败');
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
            '管理定时任务：set 安排一条提醒/延时任务（到点以新消息唤醒你并携带 hint）、list 查看自己的条目（含 lastAt 上次触发 / nextAt 下次触发 / lagMs 上次迟到量 / lastSkipAt+lastSkipReason+skipStreak 最近一次按策略跳过 / lastGateCode+lastGateCodeAt 最近 gate 退出码及其时刻（成对读，旧值≠当前态）/ lastGateErrorAt gate 自身异常；顶层 configStale=true 表示磁盘条目已被外部修改但内存仍是旧视图——list 读的是内存副本，重启/重载后才生效）、cancel 按 id 取消。会话维度：在哪个会话设置就回哪个会话；时间串支持 HH:mm（每天）/ YYYY-MM-DDTHH:mm（一次）/ 周日 12:00（每周）/ 间隔（30m、1h；间隔以「上触发时刻」续排，宿主重启不重置周期）。',
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

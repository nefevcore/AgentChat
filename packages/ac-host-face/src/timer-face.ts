// ============================================================
// timer-face.ts —— 宿主能力面贡献行：timer 工具（cr-1147 脚本化）
//
// cr-886 执行面住 ac-host-face/tools.ts；cr-1121 真动态化拆出本行；
// cr-1147 参数面换轨：set 采 code（判定脚本源码，落盘前 dryRun 自检），
// 新增 test（干跑不落盘）。LLM 面：set/list/cancel/test。执行器走
// HostTimersService（timers 行缺席 = 调用报未装配）。双闸不变。
// ============================================================
import type { Context, Plugin } from '@agentchat/cordis';
import { validateScriptEntries, type TimerScriptEntry } from 'ac-timer-core';
import type { HostFaceContribution } from './index.ts';

export const name = 'ac-host-rows/timer-face';

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'timer-face',
  label: '宿主能力面：timer',
  description: 'timer 远程工具 + GUIDELINES_TIMER 段贡献行（cr-1147 脚本化：set 采 code / test 干跑 / list 诊断）',
  automatic: true,
};

const err = (msg: string): { ok: false; error: string } => ({ ok: false, error: msg });

/** timer list 视图版本（v3 起脚本型字段面：code/label/lastError 系列/triggeredCount） */
const LIST_VERSION = 3;

/** timers 服务最小面（HostTimersService） */
interface TimersFace {
  entries(owner: string): TimerScriptEntry[];
  save(owner: string, entries: TimerScriptEntry[]): { ok: boolean; error?: string };
  storeState?(owner: string): { configStale: boolean };
  scheduleState?(owner: string, entryId: string): Record<string, unknown>;
  dryRun(owner: string, code: string, state?: unknown): Promise<{ ok: true; verdict: unknown } | { ok: false; error: string }>;
}

async function executeTimer(
  ctx: Context,
  args: Record<string, unknown>,
  identity: { agentId?: string; conversationId?: string },
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const timers = ctx.get('timers', false) as TimersFace | undefined;
  if (timers === undefined) return err('timers 服务未装配（宿主行集无 timers 行）——定时工具不可用');
  const owner = identity.agentId;
  if (owner === undefined) return err('缺少执行身份（agentId）——timer 需在 Agent run 内调用');
  const action = String(args.action ?? '');
  if (action === 'list') {
    return {
      ok: true,
      result: {
        listVersion: LIST_VERSION,
        entries: timers.entries(owner).map((e) => ({
          id: e.id, kind: 'script', label: e.label, code: e.code,
          ...(e.conversationId !== undefined ? { conversationId: e.conversationId } : {}),
          ...(e.target !== undefined ? { target: e.target } : {}),
          ...(e.task !== undefined ? { task: e.task } : {}),
          ...(e.gate !== undefined ? { gate: e.gate } : {}),
          ...(e.gateOnError !== undefined ? { gateOnError: e.gateOnError } : {}),
          enabled: e.enabled,
          ...(timers.scheduleState?.(owner, e.id) ?? {}),
        })),
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
    const res = timers.save(owner, validateScriptEntries(next));
    if (!res.ok) return err(res.error ?? '保存失败');
    return { ok: true, result: { cancelled: id } };
  }
  if (action === 'test') {
    const code = String(args.code ?? '');
    if (!code.trim()) return err('test 需要 code（判定脚本源码）');
    const r = await timers.dryRun(owner, code);
    if (!r.ok) return err('干跑失败：' + r.error);
    return { ok: true, result: { verdict: r.verdict } };
  }
  if (action === 'set') {
    const code = String(args.code ?? '').trim();
    const label = String(args.label ?? '').trim();
    if (!code) return err('set 需要 code（判定脚本源码——双参谓词 (a, u) => { … return { action?, next?, state?, active? } }）');
    const dry = await timers.dryRun(owner, code);
    if (!dry.ok) return err('脚本自检失败（未落盘）：' + dry.error);
    const id = 't-' + Math.random().toString(36).slice(2, 8);
    const entry: TimerScriptEntry = {
      id, enabled: true, kind: 'script', code,
      ...(label ? { label } : {}),
      ...(identity.conversationId !== undefined ? { conversationId: identity.conversationId } : {}),
    };
    const res = timers.save(owner, validateScriptEntries([...timers.entries(owner), entry]));
    if (!res.ok) return err(res.error ?? '保存失败');
    return { ok: true, result: { entry_id: id, label: entry.label, firstCheck: dry.verdict } };
  }
  return err('未知 action: ' + action);
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
            '管理定时任务（cr-1147 探测循环：定时器 = 探测循环 + 判定脚本，Agent 自管理）：set 安排一条探测任务（code = 判定脚本，双参谓词 (a, u) => ({ action?, next?, state?, active? })，落盘前自动干跑自检）；test 干跑看 verdict（不落盘不触发）；list 查看条目（排程态 lastAt/nextAt/lastSkip*/lastGate*/lastError*/triggeredCount）；cancel 按 id 取消。会话维度：在哪个会话设置就回哪个会话。'
            + ' 脚本入参 a = { now, last?, count, state? }（宿主记账快照：now/last = owner 时区 ISO；count = 历史投递次数——可写「跑满 N 次收工」）；u = 时间工具纯函数包 { at(spec), after(iv, from?), minute(t), day(t), dow(t), workday(t), ms(iv) }（墙钟判定一律经 u——脚本内禁 new Date 墙钟操作，进程时区陷阱）。'
            + ' verdict：action 有值 = 本轮投唤醒信（无值 = 静默探测轮）；next = 下次探测时刻（Date 唯一形态，用 u.at 或 u.after 构造或 epoch 算术；过去值钳 10s 地板）；state = 跨探测持久记忆（gate 跳过轮也保存）；active:false = 完成归档。禁 import（须自包含可擦除 TS）。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['set', 'list', 'cancel', 'test'], description: '操作' },
              code: { type: 'string', description: '[set/test] 判定脚本源码（双参谓词 (a, u) => { … }；限可擦除 TS，禁 import）' },
              label: { type: 'string', description: '[set] 人读标签（list 展示）' },
              entry_id: { type: 'string', description: '[cancel] 条目 id（list 可见）' },
            },
            required: ['action'],
          },
        }],
        sections: [{
          name: 'GUIDELINES_TIMER',
          text: '主动安排：值得持续跟进或适时提醒的事项，主动用 timer(action="set") 安排，不必等用户指令。定时器 = 探测循环 + 判定脚本：宿主按脚本 next 周期探测，action 有值才唤醒你（静默轮零 token）——写脚本即设计自己的巡检/提醒节奏（可读状态、真随机、自适应间隔），并用 test 干跑验证、timer list 查健康度（lastError/triggeredCount）。',
          promise: true,
          gate: { toolsAny: ['timer'] },
        }],
        executor: (c, args, identity) => executeTimer(c as Context, args, identity),
      };
      ctx.get('hostFaceRegistry')!.contribute(ctx, 'timer-face', contribution);
    },
  } satisfies Plugin;
}

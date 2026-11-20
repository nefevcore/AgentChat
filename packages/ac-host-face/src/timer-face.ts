// ============================================================
// timer-face.ts —— 宿主能力面贡献行：timer 工具（cr-1164 v3 哑触发层）
//
// cr-886 执行面住 ac-host-face/tools.ts；cr-1121 真动态化拆出本行；
// cr-1164 参数面换轨：set = 纯数据写入（when/gates/until/missed 声明式
// 词汇，schema 校验单源 validateTimerEntries——无脚本无 dry-run）；
// test = 静态预览（未来三次触发点 + 事件模拟 match 求值）。LLM 面：
// set/list/cancel/test。执行器走 HostTimersService（timers 行缺席 =
// 调用报未装配）。双闸不变。权限降敏：set 是普通数据写，不再是
// 「安装持久化代码」。
// ============================================================
import type { Context, Plugin } from '@agentchat/cordis';
import {
  describeEntry,
  matchRow,
  previewFires,
  validateTimerEntries,
  type TimerEntry,
  type WhenTrigger,
} from 'ac-timer-core';
import { hasSourceView } from 'ac-auth-core';
import type { HostFaceContribution } from './index.ts';

export const name = 'ac-host-rows/timer-face';

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'timer-face',
  label: '宿主能力面：timer',
  description: 'timer 远程工具 + GUIDELINES_TIMER 段贡献行（cr-1164 哑触发层：set 纯数据写 / test 静态预览 / list 诊断）',
  automatic: true,
};

const err = (msg: string): { ok: false; error: string } => ({ ok: false, error: msg });

/**
 * timer list 视图版本——**只在诊断字段面发生不兼容变化时递增**。
 *   v4: cr-1147 脚本型——nextAt/lastAt 同格式、diagnosticsScope
 *   v5: cr-1164 v3 哑层——条目字段换轨（when/gates/until/missed/action 结构）；
 *       dormantReason / chained 新增；lastGate* / lagMs 退役；schedule 人读摘要
 */
const LIST_VERSION = 5;

/** timers 服务最小面（HostTimersService） */
interface TimersFace {
  entries(owner: string): TimerEntry[];
  save(owner: string, entries: TimerEntry[]): { ok: boolean; error?: string };
  storeState?(owner: string): { configStale: boolean };
  scheduleState?(owner: string, entryId: string): Record<string, unknown>;
  preview?(owner: string, entry: TimerEntry): { fires: Array<{ at: string; trigger: string; chained: boolean }> };
  /** 源视图授权查询（cr-1166——set 校验用；timers 行 dataRoot 在手） */
  maySubscribe?(owner: string, source: string, view: string): boolean;
}

/** 触发点预览（tz 求值走 timers 行——owner 时区归它管） */
function previewOf(timers: TimersFace, owner: string, entry: TimerEntry): { fires: Array<{ at: string; trigger: string; chained: boolean }> } {
  if (timers.preview !== undefined) return timers.preview(owner, entry);
  return { fires: previewFires(entry, Date.now(), { tz: 'UTC', armedAt: Date.now() }).map((f) => ({
    at: new Date(f.at).toISOString(),
    trigger: f.trigger.kind,
    chained: f.chained,
  })) };
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
        // 惰性诊断字段（lastSkip* / lastError* / lastNote*）只在事件发生后出现，
        // 且为内存态（宿主重启即清空）——缺失 = 本次启动以来未发生该事件。
        diagnosticsScope: 'since-boot',
        entries: timers.entries(owner).map((e) => ({
          id: e.id,
          label: e.label,
          enabled: e.enabled,
          when: e.when,
          ...(e.gates !== undefined ? { gates: e.gates } : {}),
          ...(e.until !== undefined ? { until: e.until } : {}),
          ...(e.missed !== undefined ? { missed: e.missed } : {}),
          action: e.action,
          schedule: describeEntry(e),
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
    const res = timers.save(owner, next);
    if (!res.ok) return err(res.error ?? '保存失败');
    return { ok: true, result: { cancelled: id } };
  }
  if (action === 'test') {
    // 静态预览：未来三次触发点 + 源事件模拟（match 求值）
    const when = args.when;
    try { validateTimerEntries([{ id: 'preview', enabled: true, when: when as WhenTrigger[], action: { text: 'preview' } }]); } catch (e: unknown) {
      return err('when 非法：' + (e instanceof Error ? e.message : String(e)));
    }
    const draft: TimerEntry = { id: 'preview', enabled: true, when: when as WhenTrigger[], action: { text: 'preview' } };
    const fires = previewOf(timers, owner, draft);
    const simulateRow = args.simulate_row;
    const matched = Array.isArray(when)
      ? (when as WhenTrigger[]).filter((t) => t.kind === 'source' && t.match !== undefined).map((t) => {
          const trig = t as Extract<WhenTrigger, { kind: 'source' }>;
          return {
            source: trig.source,
            hit: typeof simulateRow === 'object' && simulateRow !== null
              ? matchRow(trig.match!, simulateRow as Record<string, unknown>)
              : null, // 无模拟行 = 不求值
          };
        })
      : [];
    return {
      ok: true,
      result: {
        fires: fires.fires,
        ...(matched.length > 0 ? { matched } : {}),
      },
    };
  }
  if (action === 'set') {
    const text = String(args.text ?? '').trim();
    const label = String(args.label ?? '').trim();
    if (!text) return err('set 需要 text（唤醒文本——到点投给你的消息内容）');
    const id = 't-' + Math.random().toString(36).slice(2, 8);
    let entry: TimerEntry;
    try {
      entry = validateTimerEntries([{
        id,
        enabled: true,
        when: args.when,
        ...(args.gates !== undefined ? { gates: args.gates } : {}),
        ...(args.until !== undefined ? { until: args.until } : {}),
        ...(args.missed !== undefined ? { missed: args.missed } : {}),
        action: {
          text,
          ...(identity.conversationId !== undefined ? { conversationId: identity.conversationId } : {}),
        },
      }])[0]!;
    } catch (e: unknown) {
      return err('条目非法（未落盘）：' + (e instanceof Error ? e.message : String(e)));
    }
    // 源视图授权闸（cr-1166 §七「未授权视图校验拒」）：订阅的每个源视图都须
    // 有 inline grant（hasSourceView 单源）。运行时分发另有二道闸（防直改 timer.json）。
    if (timers.maySubscribe !== undefined) {
      for (const t of entry.when) {
        if (t.kind !== 'source') continue;
        if (!timers.maySubscribe(owner, t.source, t.view)) {
          return err('未授权的源视图 ' + t.source + '/' + t.view + '——订阅需 per-agent inline grant（{kind:"source-view",source,view}），请联系用户在授权面板配置');
        }
      }
    }
    const res = timers.save(owner, [...timers.entries(owner), entry]);
    if (!res.ok) return err(res.error ?? '保存失败');
    return {
      ok: true,
      result: {
        entry_id: id,
        label: label || undefined,
        schedule: describeEntry(entry),
        preview: previewOf(timers, owner, entry).fires,
      },
    };
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
            '管理定时任务（cr-1164 哑触发层：到点唤醒 = 声明式触发词汇，无脚本无代码执行）。set 安排一条定时（when = 触发器数组 OR 语义）；test 静态预览未来触发点；list 查看条目（nextAt/lastAt/triggeredCount/dormantReason）；cancel 按 id 取消。会话维度：在哪个会话设置就回哪个会话。'
            + ' when 触发词汇：{kind:"once", at:"ISO"} 单次；{kind:"daily", at:"HH:mm"}；{kind:"weekly", dow:0-6(0=周日), at:"HH:mm"}；{kind:"every", iv:"30m", base?, jitter?} 间隔网格（base 缺省 wall=墙钟网格对齐 cron 心智；{at:"HH:mm"} 显式锚如「每小时的 :20」= iv:"1h"+base:{at:"00:20"}；"after-last" 链式=上次投递起算）；{kind:"source", source, view, on:"rows-added"|"stale", match?, cooldown?} 源事件（需对应 source 行已安装，否则条目 dormant；且需该视图的读授权——未授权会被拒，请让用户在授权面板授予 inline grant {kind:"source-view",source,view}）。'
            + ' gates 时间门（AND）：{kind:"workday"}/{kind:"holiday"}/{kind:"hours", from, to}（from>to 为跨午夜形）。until 终结：{count:n}（按投递次数）或 {date:ISO}。missed 停机策略："skip"（缺省，周期触发错过直跳未来）或 "catchup-once"（once 缺省——错过补投一次）。'
            + ' 语义判断归你：唤醒信只是「时间到/有事件」，值不值得做、做什么由 run 内判定。test 可验证 when 词汇与 match 求值（传 simulate_row 模拟源行）。时区按 owner（agent）配置。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['set', 'list', 'cancel', 'test'], description: '操作' },
              when: { type: 'array', description: '[set/test] 触发器数组（OR 语义——见工具描述词汇表）', items: { type: 'object' } },
              text: { type: 'string', description: '[set] 唤醒文本（到点投递的消息内容；语义提示写清楚——唤醒后由你判定做什么）' },
              label: { type: 'string', description: '[set] 人读标签（list 展示，可选）' },
              gates: { type: 'array', description: '[set] 时间门数组（AND：workday/holiday/hours）', items: { type: 'object' } },
              until: { type: 'object', description: '[set] 终结条件（{count:n} 按投递次数 / {date:ISO}）' },
              missed: { type: 'string', enum: ['skip', 'catchup-once'], description: '[set] 停机策略（周期缺省 skip；once 缺省 catchup-once）' },
              entry_id: { type: 'string', description: '[cancel] 条目 id（list 可见）' },
              simulate_row: { type: 'object', description: '[test] 模拟源行（求值 source 触发器的 match）' },
            },
            required: ['action'],
          },
        }],
        sections: [{
          name: 'GUIDELINES_TIMER',
          text: '主动安排：值得持续跟进或适时提醒的事项，主动用 timer(action="set") 安排，不必等用户指令。定时器 = 哑触发层：when 触发词汇（once/daily/weekly/every/source）声明「何时叫醒你」，gates 时间门（工作日/时段）限定窗口，until 限定次数——唤醒信只是「时间到」，值不值得做、做什么由你 run 内判定（语义判断不进触发器）。外部状态变化（如新消息）用 source 触发器（需对应 source 行 + 该视图读授权）；test 可静态预览触发点，list 查健康度（nextAt/triggeredCount/dormantReason）。',
          promise: true,
          gate: { toolsAny: ['timer'] },
        }],
        executor: (c, args, identity) => executeTimer(c as Context, args, identity),
      };
      ctx.get('hostFaceRegistry')!.contribute(ctx, 'timer-face', contribution);
    },
  } satisfies Plugin;
}

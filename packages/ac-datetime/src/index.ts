// ============================================================
// ac-datetime —— 日期注入行（M14 → cr-1182 批2 全形态统一 before-run）
//
// 改造裁决（cr-1182，2026-11-21 用户裁决）：
//   · 移除 DATETIME 段（system 尾部日期行）与 singles 信封 splice 两形态
//     ——system prompt 全静态（singles prefix-snapshot 无需跨日重算日期位），
//     环境动态一律走消息流（KV 零失效）。
//   · 全形态统一 loop/before-run：
//     ① per-run 落盘日期 context 行（recordContext——回放有日期锚；
//        同会话同日已落则跳过：日内幂等）
//     ② 间隔注入：距本会话最后回复超阈值（缺省 1h）→ 时间信息 user 行
//        追加（日期+时刻+间隔）
//   · 间隔判断基准 = agent 最后回复时刻（非用户发送——用户裁决）。信封
//     LlmMessage 不带 timestamp（fold 投影只留 role+content）——基准值由
//     本行在 loop/after-run 时点记入私有状态文件
//     files/<agentId>/datetime/.last-reply.json。
//
// 门控：无 conversationId / agent（子 Agent / loop 直连）不注入；注入面缺席
//（宿主直调 run 无 steerQueue——call.inject 不装配）同样跳过。
// 时区按 owner 生效时区（settings〔timers〕.timezone——cr-1053 与定时触发同词汇）。
// cr-1251：落账归 loop 消费点统一发射（ac-ledger 订阅落账）——本行只声明注入。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-agent-loop'; // loop/* 事件类型增强（type-only）
import { DEFAULT_TZ, resolveTimezone } from 'ac-core-utils'; // 缺省时区单源（cr-1053）
import type {} from 'ac-agents'; // ctx.agents 服务类型增强（type-only）

/** 间隔注入阈值（ms；用户裁决缺省 1h——连续对话不打扰，timer 每日唤醒必中） */
export const RESYNC_INTERVAL_MS = 60 * 60 * 1000;

/** 生成日期行文本（仅日期 + 星期：`[当前时间] YYYY-MM-DD 周X`；纯函数供测试） */
export function datetimeLine(now: Date, tz: string = DEFAULT_TZ): string {
  const p = zonedParts(now, resolveTimezone(tz));
  return `[当前时间] ${p.y}-${pad2(p.m)}-${pad2(p.d)} ${zonedWeekday(now, tz)}`;
}

/** 时间信息行（间隔注入：日期 + 时刻 + 距上次回复间隔——重新定向场景） */
export function timeInfoLine(now: Date, tz: string, elapsedMs: number): string {
  const p = zonedParts(now, resolveTimezone(tz));
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: resolveTimezone(tz), hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  return `[当前时间] ${p.y}-${pad2(p.m)}-${pad2(p.d)} ${zonedWeekday(now, tz)} ${hm}（距上次回复已过 ${formatElapsed(elapsedMs)}）`;
}

/** 间隔人读（小时+分钟） */
export function formatElapsed(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return mins + ' 分钟';
  return m === 0 ? h + ' 小时' : h + ' 小时 ' + m + ' 分钟';
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 某时刻在某时区的中文周几（Intl weekday 直取——UTC 构造近似法在非整日
 *  时区边界会错位一天；与日期字段同源同 tz） */
function zonedWeekday(date: Date, tz: string): string {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
  const MAP: Record<string, string> = { Sun: '周日', Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六' };
  return MAP[wd] ?? '';
}

/** 时刻在某时区的墙上日历字段（Intl formatToParts；非法 tz 经 resolveTimezone
 *  已归一——本包内不再有降级分支） */
function zonedParts(date: Date, tz: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date);
  const get = (type: string) => parts.find((x) => x.type === type)?.value ?? '0';
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')) };
}

//（cr-1251：SessionLike 接口随 recordContext 双写退役删除）

/** 行配置（boot 装配参数——rowOptionsFor 注入 dataRoot） */
export interface DatetimeRowOptions {
  /** 数据根（缺省 AGENTCHAT_DATA_ROOT 或 './data'） */
  root?: string;
}

export const name = 'ac-datetime';

export const inject = ['agents']; // agents 服务（settingsOf）硬依赖——cr-1053 owner 时区
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'datetime',
  label: '日期注入',
  description:
    '全形态统一 loop/before-run（cr-1182）：per-run 落盘日期 context 行（回放日期锚，同会话同日幂等）+ 间隔超阈值（1h）注入时间信息行（日期+时刻+距上次回复间隔——基准为 agent 最后回复时刻，由 loop/after-run 记入私有状态文件；无会话键不注入）',
  listeners: [
    { event: 'loop/before-run', role: '日期落盘与时间信息注入', description: 'per-run 落日期 context 行 + 间隔超阈值注入时间信息行' },
    { event: 'loop/after-run', role: '最后回复时刻记录', description: 'run 收束记最后回复时刻（间隔注入基准）' },
  ],
};

export function apply(ctx: Context, options: DatetimeRowOptions = {}) {
  const dataRoot = path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data');

  // ---- 私有状态（per-agent；tmp+rename 原子写）----
  // .last-reply.json：{ lastReplyAt }——间隔注入基准
  // .day-anchor.json：{ <会话键>: <已锚定日期行> }——日期锚幂等（信封回放是
  //   wrapper 包裹形态且可能被压缩截断，扫描判重不可靠——私有状态单源）
  const stateDir = (agentId: string): string => path.join(dataRoot, 'files', agentId, 'datetime');
  const readLastReply = (agentId: string): number | undefined => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(stateDir(agentId), '.last-reply.json'), 'utf-8')) as { lastReplyAt?: unknown };
      return typeof raw.lastReplyAt === 'number' && raw.lastReplyAt > 0 ? raw.lastReplyAt : undefined;
    } catch {
      return undefined;
    }
  };
  const writeLastReply = (agentId: string, ts: number): void => {
    try {
      const file = path.join(stateDir(agentId), '.last-reply.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ lastReplyAt: ts }), 'utf-8');
      fs.renameSync(tmp, file);
    } catch { /* fail-soft：写失败 → 下次 run 间隔判断退化（多注一次），无震荡 */ }
  };
  const readAnchoredDay = (agentId: string, conversationId: string): string | undefined => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(stateDir(agentId), '.day-anchor.json'), 'utf-8')) as Record<string, unknown>;
      const v = raw[conversationId];
      return typeof v === 'string' ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const writeAnchoredDay = (agentId: string, conversationId: string, line: string): void => {
    const file = path.join(stateDir(agentId), '.day-anchor.json');
    let days: Record<string, string> = {};
    try {
      days = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, string>;
    } catch { /* 缺席/坏文件 → 覆盖重建 */ }
    days[conversationId] = line;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(days), 'utf-8');
      fs.renameSync(tmp, file);
    } catch { /* fail-soft：写失败 → 下次重落一行日期锚（冗余但如实） */ }
  };

  // ---- after-run：记最后回复时刻（per-agent 单值——多会话取 max） ----
  ctx.on('loop/after-run', (request, result) => {
    const agentId = request.agent;
    if (agentId === undefined || request.conversationId === undefined) return;
    if (result.finish === 'error' || result.finish === 'interrupted') return; // 失败 run 不刷新基准
    const cur = readLastReply(agentId);
    const now = Date.now();
    if (cur === undefined || now > cur) writeLastReply(agentId, now);
  }, { description: '记录最后回复时刻（datetime 间隔注入基准）' });

  // ---- before-run：日期锚 + 间隔注入（cr-1251 统一注入面——单写） ----
  ctx.on('loop/before-run', (call, next) => {
    // 无会话键/agent（子 Agent / loop 直连）：不注入（提示词全静态）
    const req = call.request;
    // cr-1233 干跑（previewSystemPrompt）：只读预览不落账——早退防凭空
    // 创建会话（新会话草稿哨兵键会被直接物化成真）
    if (req.dryRun === true || call.inject === undefined) return next();
    const convId = req.conversationId;
    const agentId = (req as { agent?: string }).agent;
    if (convId === undefined || agentId === undefined) return next();

    const tz = resolveTimezone(
      (ctx.agents.settingsOf(agentId, 'timers') as { timezone?: string } | undefined)?.timezone,
    );
    const now = new Date();
    const line = datetimeLine(now, tz);

    // ① 日期锚（同会话同日已注则跳过——私有状态单源判重）：注入面单写——
    //    消息进数组 + 消费点落账（loop/inject-consumed → journalInject）由
    //    loop 统一承担，落位 = 首步相位行之前（模型消息序）。
    if (readAnchoredDay(agentId, convId) !== line) {
      call.inject({ role: 'user', content: line }, { injectSource: 'datetime', label: '日期锚' });
      writeAnchoredDay(agentId, convId, line);
    }

    // ② 间隔注入（裁决：进入 LLM 消息的注入体一律落账——live 与回放恒等）：
    //    基准 = 私有状态文件的最后回复时刻
    const lastReplyAt = readLastReply(agentId);
    if (lastReplyAt !== undefined) {
      const elapsed = now.getTime() - lastReplyAt;
      if (elapsed >= RESYNC_INTERVAL_MS) {
        call.inject({ role: 'user', content: timeInfoLine(now, tz, elapsed) }, { injectSource: 'datetime', label: '时间信息' });
      }
    }
    return next();
  }, { description: '日期锚 + 间隔时间信息注入（cr-1182 → cr-1251 注入面单写）' });
}

// ============================================================
// ac-datetime —— 日期注入行（M14；M21 步骤 4 双形态；cr-881 段注册制）
//
// 双形态：
//   · 独立会话（singles）：每日 user 快照行——loop/before-run 改写信封
//     （尾部追加、每 run 恰一行、日内字节恒定），**不进 system**
//     （§5.2：singles 是前缀绝对稳定的最佳试点位——[system+tool
//     schema] 跨轮跨重启字节不变）。信封改写是 run 级动作（消息数组
//     事实），留在事件 seam——正当的 before-run 用途。
//   · 其余会话：system 尾部仅日期行——**DATETIME 段（SECTION_ORDER 具名
//     位，绝对收尾）**。cr-881：尾档 before-run-last 退役，收尾语义由
//     段注册制的具名 order 承载（910 = 表尾）——排序确定性 = 字节确定性，
//     与任何行的加载顺序无关。
//
// KV cache（M21"仅日期行收尾"本义）：日期真正居尾——每日翻转只失效
// 日期行自身，不连带失效偶然落在其后的静态块。
//
// 门控：无 conversationId（子 Agent / loop 直连）不注入。日期每 run
// 计算一次（跨日 run 全程旧日期——run 边界本就翻转，语义不变）。
// 时区：owner 生效时区（settings〔timers〕.timezone——cr-1053 与定时触发
// 同词汇；singles 无 agent 身份 → DEFAULT_TZ）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-agent-loop'; // loop/* 事件类型增强 + 段注册面类型（type-only）
import { DEFAULT_TZ, resolveTimezone } from 'ac-core-utils'; // 缺省时区单源（cr-1053）
import type {} from 'ac-agents'; // ctx.agents 服务类型增强（type-only）

// KV Cache effect（M21/D9 声明纪律）: 独立会话 = Append-only（每日 user
// 快照行，尾部追加、日内零失效）；其余会话 = 日内 Prefix-stable、跨日
// invalidate-from-X（system 位日期行重写，每日至多一次——DATETIME 段
// 居 SECTION_ORDER 表尾，失效面收敛为日期行自身）。

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 生成日期行文本（仅日期 + 星期：`[当前时间] YYYY-MM-DD 周X`；纯函数供测试。
 * 墙上日历按 tz（缺省 DEFAULT_TZ——cr-1053 单源；与 timer 触发/owner
 * 生效时区同基线，Agent 对「今天几号」与「定时何时触发」同一口径）） */
export function datetimeLine(now: Date, tz: string = DEFAULT_TZ): string {
  const p = zonedParts(now, resolveTimezone(tz));
  const wdIdx = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  return `[当前时间] ${p.y}-${pad2(p.m)}-${pad2(p.d)} ${WEEKDAYS[wdIdx]}`;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 时刻在某时区的墙上日历字段（Intl formatToParts；非法 tz 经 resolveTimezone
 *  已归一——本包内不再有降级分支） */
function zonedParts(date: Date, tz: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date);
  const get = (type: string) => parts.find((x) => x.type === type)?.value ?? '0';
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')) };
}

/** singles 可选能力形状（ctx.get('singles', false)） */
type SinglesLike = { get(id: string): unknown };

export const name = 'ac-datetime';

// agentLoop 是段注册面的硬依赖（start-time 注册，cr-282：fiber 无构造期
// 就位保证，ctx.get 探测后注册副作用 = 激活序赌博）——inject 声明。
export const inject = ['agents', 'agentLoop']; // agents 服务（settingsOf）硬依赖——cr-1053 owner 时区
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'datetime',
  label: '日期注入',
  description:
    'singles 每日 user 快照行（信封追加）+ 其余会话 system 尾部仅日期行（DATETIME 段——SECTION_ORDER 表尾绝对收尾；墙上日历按 owner 生效时区〔timers.timezone，缺省 DEFAULT_TZ——与定时触发同口径，cr-1053〕；无会话键不注入）',
  listeners: [
    { event: 'loop/before-run', role: '独立会话日快照行', description: 'singles 信封尾部插入 user 快照行（每 run 恰一行；system 不动）' },
  ],
};

export function apply(ctx: Context) {
  // ── 形态一：独立会话（singles）每日 user 快照行（§5.2，per-run 一次）──
  // 留在事件 seam：信封消息改写是 run 级动作（每信封恰一行），次序中立。
  ctx.on('loop/before-run', (call, next) => {
    // 无会话键（子 Agent / loop 直连）：不注入（提示词全静态）
    const convId = call.request.conversationId;
    if (convId === undefined) return next();
    // 独立会话（可选能力：singles 行未装 = 恒 false）——非 singles 由
    // 尾档收尾，此处早退
    const singles = ctx.get('singles', false) as SinglesLike | undefined;
    if (!singles?.get(convId)) return next();

    const agentId = (call.request as { agent?: string }).agent;
    const tz = resolveTimezone(
      agentId ? (ctx.agents.settingsOf(agentId, 'timers') as { timezone?: string } | undefined)?.timezone : undefined,
    );
    const line = datetimeLine(new Date(), tz);
    const messages = [...call.request.messages];
    messages.splice(Math.max(0, messages.length - 1), 0, { role: 'user', content: line });
    call.request = { ...call.request, messages };
    return next();
  }, { description: '独立会话每日 user 快照行（singles）' });

  // ── 形态二：其余会话 system 尾部日期行（DATETIME 段，cr-881）──
  // SECTION_ORDER 表尾具名位（910）——绝对收尾的次序语义由排序键承载，
  // 与行加载顺序无关（原尾档 push 收敛式随之退役）。
  ctx.agentLoop.registerPromptSection({
    name: 'DATETIME',
    text: (request) => {
      // 无会话键（子 Agent / loop 直连）：不注入（提示词全静态）
      const convId = request.conversationId;
      if (convId === undefined) return '';
      // singles 走形态一（user 快照行），system 不动
      const singles = ctx.get('singles', false) as SinglesLike | undefined;
      // owner 生效时区（settings〔timers〕.timezone ∪ 全局默认层——与定时
      // 触发同一词汇：Agent 的「今天」与「定时几点」恒同口径）；request.agent
      // 缺省（直连 loop）→ DEFAULT_TZ
      const tz = resolveTimezone(
        request.agent ? (ctx.agents.settingsOf(request.agent, 'timers') as { timezone?: string } | undefined)?.timezone : undefined,
      );
      return datetimeLine(new Date(), tz);
    },
  }, 'ac-datetime');
}

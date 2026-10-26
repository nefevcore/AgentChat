// ============================================================
// ac-datetime —— 日期注入行（M14；M21 步骤 4 双形态；2026-09-05 收尾档位化）
//
// 双形态：
//   · 独立会话（singles）：每日 user 快照行——loop/before-run（主档）改写
//     信封（尾部追加、每 run 恰一行、日内字节恒定），**不进 system**
//     （§5.2：singles 是前缀绝对稳定的最佳试点位——[system+tool
//     schema] 跨轮跨重启字节不变）。
//   · 其余会话：system 尾部仅日期行——**落 loop/before-run-last（尾档）**。
//
// 【收尾档位化，2026-09-05】为什么是尾档：一切常规提示词装配（persona /
// system-prompt / memory / skill / 引用约定各 owner 行）都在主档
// loop/before-run 追加 system，相互次序 = 监听器注册序 = 依赖驱动的激活序
// （cordis 行序无激活语义）——"日期行收尾"靠装配顺序只能是运气。三档
// 装配链 before-run-first → before-run → before-run-last 是显式的结构性
// 次序：尾档 body 晚于主档全体执行，且此刻 request.messages 尚未构建，
// system 改写即终值——run 级一次写回（无 per-step 重注入/累积问题），
// 日期与任何行的加载顺序无关。曾试 llm/before-chat 收尾（2026-09-05
// 上午）：per-step 语义 + 与凭据/路由/未来上下文裁剪同 seam 竞争，被否决。
// KV cache（M21"仅日期行收尾"本义）：日期真正居尾——每日翻转只失效
// 日期行自身，不连带失效偶然落在其后的静态块。
//
// 门控：无 conversationId（子 Agent / loop 直连）不注入；
// settings['datetime'].enabled（per-Agent，M24 X1/A1）软停用。日期每 run
// 计算一次（跨日 run 全程旧日期——run 边界本就翻转，语义不变）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-agent-loop'; // loop/* 事件类型增强（type-only）
import type {} from 'ac-agents'; // ctx.agents 服务类型增强（type-only）

// KV Cache effect（M21/D9 声明纪律）: 独立会话 = Append-only（每日 user
// 快照行，尾部追加、日内零失效）；其余会话 = 日内 Prefix-stable、跨日
// invalidate-from-X（system 位日期行重写，每日至多一次——尾档收尾后
// 失效面收敛为日期行自身）。

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 生成日期行文本（仅日期 + 星期：`[当前时间] YYYY-MM-DD 周X`；纯函数供测试） */
export function datetimeLine(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `[当前时间] ${date} ${WEEKDAYS[now.getDay()]}`;
}

/** settings['datetime'].enabled 软停用判定（缺省 true） */
function isEnabled(cfg: unknown): boolean {
  if (cfg !== undefined && cfg !== null && typeof cfg === 'object') {
    return (cfg as { enabled?: unknown }).enabled !== false;
  }
  return true;
}

/** singles 可选能力形状（ctx.get('singles', false)） */
type SinglesLike = { get(id: string): unknown };

export const name = 'ac-datetime';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'datetime',
  label: '日期注入',
  description:
    'singles 每日 user 快照行（主档信封追加）+ 其余会话 system 尾部仅日期行（尾档 before-run-last 结构性收尾——晚于主档一切装配，与行加载顺序无关；日内稳定，KV cache 友好；无会话键不注入）',
  fields: [{ name: 'enabled', type: 'boolean', default: true, description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' }],
  listeners: [
    { event: 'loop/before-run', role: '独立会话日快照行', description: 'singles 信封尾部插入 user 快照行（每 run 恰一行；system 不动）', respectsEnabled: true },
    { event: 'loop/before-run-last', role: 'system 日期行收尾（尾档·push 居后）', description: '晚于主档一切装配与尾档 prepend 住户（对话信息块）的仅日期行——绝对收尾；新住户需裁决', respectsEnabled: true },
  ],
};


export const inject = ['agents'];

export function apply(ctx: Context) {
  // ── 形态一：独立会话（singles）每日 user 快照行（§5.2，per-run 一次）──
  // 留在主档：信封消息改写是 run 级动作（每信封恰一行），次序中立。
  ctx.on('loop/before-run', (call, next) => {
    // 无会话键（子 Agent / loop 直连）：不注入（提示词全静态）
    const convId = call.request.conversationId;
    if (convId === undefined) return next();
    // 独立会话（可选能力：singles 行未装 = 恒 false）——非 singles 由
    // 尾档收尾，此处早退
    const singles = ctx.get('singles', false) as SinglesLike | undefined;
    if (!singles?.get(convId)) return next();
    const agentId = call.request.agent;
    const settings = agentId ? ctx.agents.settingsOf(agentId, 'datetime') : {};
    if (!isEnabled(settings)) return next();

    const line = datetimeLine(new Date());
    const messages = [...call.request.messages];
    messages.splice(Math.max(0, messages.length - 1), 0, { role: 'user', content: line });
    call.request = { ...call.request, messages };
    return next();
  }, { description: '独立会话每日 user 快照行（singles）' });

  // ── 形态二：其余会话 system 尾部日期行（尾档 before-run-last）──
  // 三档装配链的结构性收尾位：晚于主档一切装配（persona/system-prompt
  // 静态块/memory/skill/引用约定…），先于 execute；此刻 messages 尚未构建，
  // system 改写即终值——run 级一次写回。尾档内相对次序（prepend 收敛式，
  // ADR-7 同款）：ac-system-prompt 对话信息块恒 prepend（unshift 居前）、
  // 本行恒 push（居后，绝对收尾）——两种注册时序收敛同一链序。
  ctx.on('loop/before-run-last', (call, next) => {
    // 无会话键（子 Agent / loop 直连）：不注入（提示词全静态）
    const convId = call.request.conversationId;
    if (convId === undefined) return next();
    // singles 走形态一（user 快照行），system 不动
    const singles = ctx.get('singles', false) as SinglesLike | undefined;
    if (singles?.get(convId)) return next();
    const agentId = call.request.agent;
    const settings = agentId ? ctx.agents.settingsOf(agentId, 'datetime') : {};
    if (!isEnabled(settings)) return next();

    const line = datetimeLine(new Date());
    call.request = {
      ...call.request,
      system: call.request.system ? `${call.request.system}\n\n${line}` : line,
    };
    return next();
  }, { description: 'system 尾部追加仅日期行（尾档 before-run-last）' });
}

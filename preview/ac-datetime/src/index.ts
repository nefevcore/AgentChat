// ============================================================
// ac-datetime —— 日期注入行（M14；M21 步骤 4 双形态）
//
// src 轨道映射：agent-datetime 的 runStart 清单钩子 → preview 的
// loop/before-run waterfall。KV cache 友好（资产 #12）：仅日期粒度
// （YYYY-MM-DD 周X），日内内容恒定。
//
// 【M21 步骤 4 / §5.2】独立会话（singles）：日期走「每日 user 快照行」
// ——追加在当前消息之前（尾部追加、每信封恰一行、日内字节恒定），
// **不进 system**（singles 是前缀绝对稳定的最佳试点位：[system+tool
// schema] 跨轮跨重启字节不变，日期只做尾部追加后缀）。跨日 = 新一行
// 内容（一次尾部变化），日内多轮零变化。
// 其余会话形态维持 system 注入（§4.4 显式接受抖动：失效面单桶、
// 频率 = 日更；优化后议）。
//
// settings[具名]（M24 X1/A1）：settingsOf(id,'datetime') = { enabled?: boolean }
// （缺省 true；enabled=false = 本 Agent 软停用——ADR-4；全局默认层可写
// 同键）。无会话键（conversationId 缺省：子 Agent / loop 直连）不注入——
// 对齐 src "独立会话提示词全静态、最大 KV cache" 语义。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-agents'; // ctx.agents 服务类型增强（type-only）

// KV Cache effect（M21/D9 声明纪律）: 独立会话 = Append-only（每日 user
// 快照行，尾部追加、日内零失效）；其余会话 = 日内 Prefix-stable、跨日
// invalidate-from-X（system 位日期行重写，每日至多一次）。

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

export const name = 'ac-datetime';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'datetime',
  label: '日期注入',
  description: 'system 尾部追加仅日期行（日内稳定，KV cache 友好；无会话键不注入）',
  fields: [{ name: 'enabled', description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' }],
  listeners: [{ event: 'loop/before-run', role: '日期行', description: 'Agent 循环启动前拦截（人格注入/预算控制/直接否决）', respectsEnabled: true }],
};


export const inject = ['agents'];

export function apply(ctx: Context) {
  ctx.on('loop/before-run', (call, next) => {
    // 无会话键（子 Agent / loop 直连）：不注入（提示词全静态）
    if (call.request.conversationId === undefined) return next();
    const agentId = call.request.agent;
    const settings = agentId ? ctx.agents.settingsOf(agentId, 'datetime') : {};
    if (!isEnabled(settings)) return next();

    const line = datetimeLine(new Date());
    // 独立会话（可选能力：singles 行未装 = 恒 false）：日快照行形态——
    // 追加在当前消息（信封末条）之前，system 不动（§5.2）
    const singles = ctx.get('singles', false) as { get(id: string): unknown } | undefined;
    if (singles?.get(call.request.conversationId)) {
      const messages = [...call.request.messages];
      messages.splice(Math.max(0, messages.length - 1), 0, { role: 'user', content: line });
      call.request = { ...call.request, messages };
      return next();
    }
    call.request = {
      ...call.request,
      system: call.request.system ? `${call.request.system}\n\n${line}` : line,
    };
    return next();
  }, { description: 'system 尾部追加仅日期行' });
}

// ============================================================
// ac-llm-pool/src/session-affinity.ts —— 会话亲和头注入（llm/before-chat 订阅）
//
// 背景（2026-09 连通性复查）：部分托管推理网关要求每会话稳定的
// session 头用于粘性路由/prompt cache（OpenCode Go 2026-09-05 起
// 缺 x-opencode-session 即 400 MissingSessionID）。普通用户不会手配
// llmProviders.<名>.headers——本模块把确认过的事实清单内置为 preset，
// 按 base_url 自动匹配；未知端点默认不发（fail-closed：盲目发头可能
// 触发网关 400，如 Envoy 拒下划线头 / GLM 拒未知归因头）。
//
// 头值 = 按 conversationId 确定性派生的稳定 UUID（无状态：同会话跨
// 重启同值，满足"stable per-conversation"；不同会话自然分流）。派生
// 盐固定于本版本——换盐 = 全体会话换路由目标，只应在重大变更时做。
// ============================================================
import { createHash } from 'node:crypto';
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-llm'; // llm/* 事件目录（type-only）

/** 池条目 sessionHeader 字段形状（index.ts LlmPoolEntry 消费） */
export type SessionHeaderSpec =
  | false // 强制关闭（连 preset 匹配也不发）
  | { name: string }; // 显式指定头名（值仍按会话派生）

/**
 * 确认过需要会话亲和头的网关事实清单（base_url 后缀匹配，大小写不敏感）。
 * 只收录【官方公告/网关运营方确认】的条目——道听途说的端点不进表
 *（发错头可能帮倒忙）。新增条目须附来源注释。
 */
const SESSION_HEADER_PRESETS: Array<{ urlSuffix: string; header: string }> = [
  {
    urlSuffix: 'opencode.ai',
    header: 'x-opencode-session',
    // OpenCode Go 托管推理 2026-09-05 起强制（400 MissingSessionID），运营方
    // 确认 any stable UUID per conversation works：
    // github.com/openai/openai-agents-python/issues/4841
  },
];

/**
 * 解析池条目的会话亲和头名：显式 sessionHeader 优先（false = 关闭），
 * 其次 preset 匹配（base_url 后缀），无匹配 = undefined（不发）。
 * 纯函数，测试友好。
 */
export function resolveSessionHeader(
  baseUrl: string | undefined,
  explicit: unknown,
): string | undefined {
  if (explicit === false) return undefined;
  if (explicit !== null && typeof explicit === 'object' && typeof (explicit as { name?: unknown }).name === 'string') {
    const name = (explicit as { name: string }).name;
    return name || undefined;
  }
  if (!baseUrl) return undefined;
  // hostname 精确/后缀匹配（防路径段误配：'https://x.opencode.ai.evil/c' 的
  // host 后接 '.evil' 不命中；等值或以 '.<suffix>' 开头才算子域）
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined; // 非 URL 形态（池归一已挡，防御性兜底）
  }
  for (const p of SESSION_HEADER_PRESETS) {
    if (host === p.urlSuffix || host.endsWith('.' + p.urlSuffix)) return p.header;
  }
  return undefined;
}

/**
 * 会话稳定头值：conversationId + 固定盐 → UUID 形态（确定性——无状态、
 * 跨重启稳定）。conversationId 缺失（无会话语境的探测类调用）时回退
 * 进程级稳定值。
 */
const SESSION_SALT = 'AgentChatSessionAffinity:v1';
const PROCESS_SESSION = uuidOf('process:' + process.pid);

function uuidOf(input: string): string {
  const h = createHash('sha256').update(SESSION_SALT + '\u0000' + input).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function sessionHeaderValue(conversationId: string | undefined): string {
  return uuidOf(conversationId ?? PROCESS_SESSION);
}

/**
 * 会话亲和头注入订阅（apply 装配）。与凭据注入同款模式：拦截链在路由
 * 之前、只改传输头不改路由；观察型监听器必调 next()。headerMap 为
 * provider 名 → 头名的期望集（desiredProviders 解析产物，随池热更刷新）。
 */
export function registerSessionAffinityInjection(
  ctx: Context,
  headerOf: (provider: string) => string | undefined,
): void {
  ctx.on('llm/before-chat', (call, next) => {
    if (call.input.headers) return next(); // 上游显式指定：不覆盖
    const provider = call.input.provider;
    if (!provider) return next();
    const header = headerOf(provider);
    if (!header) return next();
    call.input = {
      ...call.input,
      headers: { [header]: sessionHeaderValue(call.input.meta?.conversationId) },
    };
    return next();
  }, { description: '会话亲和头注入：preset 网关按会话派生稳定 session 头（粘性路由/prompt cache）' });
}
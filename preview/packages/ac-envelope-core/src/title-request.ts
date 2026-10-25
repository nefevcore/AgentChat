// ============================================================
// title-request.ts —— 会话标题请求信 payload schema（cr-672）
//
// 形态依据（plugin-request / grant 同族）：标题写权归宿主 singles 行
//（viewer/sessions/<sid>/session.json 单写者），标题生成要 LLM——LLM 只住
// 壳（llm / llm-pool 行在壳树）。故壳侧 auto-title 行生成后经邮局发本请求：
// 壳 → 邮局 → 宿主 HostInbox 受理（singles 行 write-if-absent 落盘 +
// singles/updated 广播）。
//
// uuid 键 = 'title-' + 会话键（host 请求域独立键，cr-641 同款：直接用会话键
// 会撞 R-1 登记集 [user, agent]——to=host 的 participants 近似 [agent, host]
// 非其子集 → conflict fail-loud，信被邮局静默吞掉）。kind=message +
// budget=0：宿主写面动作，不需要回执也不续跑（标题是装饰性面，失败降级
// 为派生标题，绝不放大成 run 失败）。
// ============================================================
import type { Envelope, EndpointId } from './envelope.ts';
import { makeEnvelope } from './envelope.ts';

/** 标题请求 payload（壳 → host） */
export interface TitleRequestPayload {
  /** 会话键（= viewer/sessions/<sid> 目录名） */
  conversationId: string;
  /** 生成的标题（已按 TITLE_MAX_LEN 清洗——宿主侧仍按上限再裁一次） */
  title: string;
  /** 发起 agent（= 请求信 sender；诊断/审计用） */
  agent: string;
}

/** 构造标题请求信封（壳 → host；uuid 见文件头——host 请求域独立键） */
export function makeTitleRequestEnvelope(input: {
  conversationId: string;
  requestId: string;
  sender: EndpointId;
  payload: TitleRequestPayload;
}): Envelope {
  return makeEnvelope({
    uuid: 'title-' + input.conversationId,
    requestId: input.requestId,
    sender: input.sender,
    to: 'host',
    kind: 'message',
    budget: 0,
    payload: input.payload,
  });
}

/** payload 结构校验（纯函数 fail-closed：只收集不修复） */
export function validateTitleRequestPayload(payload: unknown): string[] {
  const issues: string[] = [];
  const p = payload as Partial<TitleRequestPayload> | null;
  if (p === null || typeof p !== 'object') return ['payload 非对象'];
  if (typeof p.conversationId !== 'string' || p.conversationId.length === 0) issues.push('conversationId 缺席');
  if (typeof p.title !== 'string' || p.title.trim().length === 0) issues.push('title 缺席或空白');
  if (typeof p.agent !== 'string' || p.agent.length === 0) issues.push('agent 缺席');
  return issues;
}

/** 信封是否标题请求（宿主收信面分流——payload 词形判别） */
export function isTitleRequest(env: Envelope): boolean {
  if (env.kind !== 'message' || env.to !== 'host') return false;
  const p = env.payload as { conversationId?: unknown; title?: unknown } | null;
  if (p === null || typeof p !== 'object') return false;
  return typeof p.conversationId === 'string' && typeof p.title === 'string';
}

// ============================================================
// grant.ts —— 授权信 payload schema（协议规格 E：grant/revoke 事务载体）
//
// 域外唯一动作类（D3 修订/R-4）：agent → 邮局 → 宿主 auth-registry 行。
// 回执 kind=receipt 新 subject（grant-applied / grant-rejected）进 agent
// 经验流——与 upgrade 回执同构（静默生效是反自治的）。回执与受理信
// uuid/requestId 同值（agent 侧按原 requestId 对账——payload 不回显）。
//
// 受理边界（宿主侧语义收窄——用户域动作不经信封）：
//   · 资产面：credential（轮换）/ mcp-server（放行）；
//   · row / inline 不受理：装载 = 授权动作（A7/A10——插壳即授权），
//     用户域经行集声明面表达，信封面恒拒；
//   · scope 边界（D4）：global 授予/吊销需 user 审批（审批 = user 端点
//     的消息形态，R-9——webui 卡面归产品批）→ 现阶段预检拒收。
// ============================================================
import type { Envelope, EndpointId } from './envelope.ts';

/** 授权信资产单（协议 E：凭据引用 | MCP 服务器名；row/inline 恒拒——A10 用户域） */
export type GrantAsset =
  | { kind: 'credential'; ref: string }
  | { kind: 'mcp-server'; name: string };

/** grant/revoke 信 payload（协议 E） */
export interface GrantPayload {
  /** 'grant' = 授予；'revoke' = 吊销（撤销授予） */
  action: 'grant' | 'revoke';
  /** 授权资产 */
  asset: GrantAsset;
  /** 生效层：per-agent（agents/<id>/auth.json grants）| global（auth.json 条目） */
  scope: 'per-agent' | 'global';
  /** 变更前授权注册表指纹（E 节乐观锁——不匹配拒收） */
  priorFingerprint: string;
  /** 注释性伴随（审计行） */
  note?: string;
}

/** 授权受理回执 payload（kind = receipt；对账键 = 信封 requestId 原值） */
export interface GrantReceiptPayload {
  subject: 'grant-applied' | 'grant-rejected';
  /** 受影响 agent（= 受理信 sender） */
  agent: string;
  ok: boolean;
  /** 成功线：变更后授权注册表指纹 */
  newFingerprint?: string;
  /** 拒收线：原因（结构非法 / 指纹对拍不匹配 / 资产面拒收 / scope 预检） */
  reason?: string;
}

/** 构造授权信信封（agent → host） */
export function makeGrantEnvelope(input: {
  uuid: string;
  requestId: string;
  sender: EndpointId;
  payload: GrantPayload;
}): Envelope {
  return {
    uuid: input.uuid,
    requestId: input.requestId,
    sender: input.sender,
    to: 'host',
    kind: input.payload.action,
    budget: 0,
    payload: input.payload,
  };
}

/** 构造受理回执信封（host → agent；uuid/requestId = 受理信原值——按 requestId 对账） */
export function makeGrantReceiptEnvelope(input: {
  uuid: string;
  requestId: string;
  to: EndpointId;
  payload: GrantReceiptPayload;
}): Envelope {
  return {
    uuid: input.uuid,
    requestId: input.requestId,
    sender: 'host',
    to: input.to,
    kind: 'receipt',
    budget: 0,
    payload: input.payload,
  };
}

/** payload 结构校验（纯函数——fail-closed 只收集） */
export function validateGrantPayload(payload: unknown): string[] {
  const issues: string[] = [];
  const p = payload as Partial<GrantPayload> | null;
  if (p === null || typeof p !== 'object') return ['payload 非对象'];
  if (p.action !== 'grant' && p.action !== 'revoke') issues.push('action 非法');
  if (p.scope !== 'per-agent' && p.scope !== 'global') issues.push('scope 非法');
  if (typeof p.priorFingerprint !== 'string' || p.priorFingerprint.length === 0) {
    issues.push('priorFingerprint 缺席');
  }
  const a = p.asset as { kind?: unknown; ref?: unknown; name?: unknown } | null | undefined;
  if (typeof a !== 'object' || a === null) {
    issues.push('asset 缺席');
  } else if (a.kind === 'credential') {
    if (typeof a.ref !== 'string' || a.ref.length === 0) issues.push('credential ref 缺席');
  } else if (a.kind === 'mcp-server') {
    if (typeof a.name !== 'string' || a.name.length === 0) issues.push('mcp-server name 缺席');
  } else {
    issues.push('asset.kind 非法（仅 credential / mcp-server——row/inline 恒拒）');
  }
  return issues;
}

/** 回执 payload 结构校验（纯函数） */
export function validateGrantReceiptPayload(payload: unknown): string[] {
  const issues: string[] = [];
  const p = payload as Partial<GrantReceiptPayload> | null;
  if (p === null || typeof p !== 'object') return ['payload 非对象'];
  if (p.subject !== 'grant-applied' && p.subject !== 'grant-rejected') issues.push('subject 非法');
  if (typeof p.agent !== 'string' || p.agent.length === 0) issues.push('agent 缺席');
  if (typeof p.ok !== 'boolean') issues.push('ok 非布尔');
  if (p.subject === 'grant-applied' && p.ok !== true) issues.push('成功回执 ok 须 true');
  if (p.subject === 'grant-applied' && (typeof p.newFingerprint !== 'string' || p.newFingerprint.length === 0)) {
    issues.push('成功回执缺 newFingerprint');
  }
  if (p.subject === 'grant-rejected' && p.ok !== false) issues.push('拒收回执 ok 须 false');
  if (p.subject === 'grant-rejected' && (p.reason === undefined || p.reason.length === 0)) {
    issues.push('拒收回执缺 reason');
  }
  return issues;
}

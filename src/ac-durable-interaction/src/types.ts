// ============================================================
// ac-durable-interaction/src/types.ts —— 通用持久化交互契约
// （src durable-interaction 直接平移——src 已是 preview owning-package 形态）
//
// 语义（durable suspension / resumable interaction 模式）：
//   · open 先落盘意图，再允许发生外部可见动作（弹窗/回调/审批）
//   · reply 先落盘回答，再允许推进执行
//   · 恢复方按 state 对账：pending 继续等 / answered 幂等续跑 / closed 已终止
// ============================================================

/** 无损 JSON 值（store 只接受可 JSON 序列化的 payload/answer） */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** 交互生命周期状态机：pending → answered → closed */
export type DurableInteractionState = 'pending' | 'answered' | 'closed';

/** 打开一个持久化暂停点时提供的意图信息 */
export interface DurableInteractionInput {
  /** 路由/会话身份（业务方自己定义，如 conversationId / orderId / workflowId） */
  key: string;
  /** 交互种类（如 ask_questions / approval / webhook；恢复方据此选择处理方式） */
  kind: string;
  /** 展示/处理所需的完整数据（问题、选项、回调参数等） */
  payload: JsonValue;
  /** 与执行点关联的稳定关联键（如 toolCallId / stepId）；恢复对账用 */
  correlationId?: string;
  /** 发起方/属主（如 agentId / userId；可选，便于路由与广播） */
  owner?: string;
  /** 截止时间（epoch ms）；缺省 = 永久等待 */
  deadline?: number;
  /** 确定性测试或跨写者协同时指定 id；缺省自动生成 */
  id?: string;
}

/** 一条持久化交互记录（append-only store 的投影） */
export interface DurableInteraction {
  id: string;
  key: string;
  kind: string;
  payload: JsonValue;
  state: DurableInteractionState;
  correlationId?: string;
  owner?: string;
  deadline?: number;
  /** 回答内容（state=answered 时存在） */
  answer?: JsonValue;
  /** 关闭原因（state=closed 时存在，如 timeout / aborted / consumed） */
  closedReason?: string;
  createdAt: number;
  updatedAt: number;
}

/** reply 的结果（幂等语义） */
export type ReplyStatus = 'ok' | 'duplicate' | 'not-found' | 'closed';

export interface ReplyOutcome {
  status: ReplyStatus;
  interaction?: DurableInteraction;
  /** duplicate 时返回此前已落盘的回答 */
  answer?: JsonValue;
}

/** list 过滤条件（全部可选） */
export interface DurableInteractionFilter {
  key?: string;
  kind?: string;
  owner?: string;
  correlationId?: string;
  state?: DurableInteractionState;
}

/**
 * 持久化交互 store 最小契约。
 * 实现需保证：
 *   1. open 返回前记录已持久（write-ahead）
 *   2. reply/close 返回前状态已持久
 *   3. 同 id 的 reply 幂等（返回 duplicate + 原回答）
 *   4. 崩溃后重新构造 store 可恢复相同投影
 */
export interface DurableInteractionStore {
  /** 后端标识（诊断用） */
  readonly name: string;
  open(input: DurableInteractionInput): DurableInteraction;
  reply(id: string, answer: JsonValue): ReplyOutcome;
  close(id: string, reason?: string): boolean;
  get(id: string): DurableInteraction | undefined;
  list(filter?: DurableInteractionFilter): DurableInteraction[];
  listOpen(filter?: DurableInteractionFilter): DurableInteraction[];
  /** 清空全部记录（测试/重置用；生产慎用） */
  clear(): number;
  dispose(): void;
}

/** 打开失败：id 已存在 */
export class DurableInteractionConflictError extends Error {
  id: string;
  constructor(id: string) {
    super(`durable interaction "${id}" already exists`);
    this.name = 'DurableInteractionConflictError';
    this.id = id;
  }
}

/** 数据不可 JSON 序列化 */
export class DurableInteractionSerializationError extends Error {
  field: string;
  constructor(field: string) {
    super(`durable interaction ${field} is not a lossless JSON value`);
    this.name = 'DurableInteractionSerializationError';
    this.field = field;
  }
}

/** 持久文件损坏（非 torn tail 的重复/非法前缀） */
export class DurableInteractionCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurableInteractionCorruptionError';
  }
}

/** 深拷贝 + JSON 无损校验 */
export function cloneJson(value: JsonValue, field: string): JsonValue {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new DurableInteractionSerializationError(field);
  }
  if (text === undefined) throw new DurableInteractionSerializationError(field);
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new DurableInteractionSerializationError(field);
  }
}

/** 生成稳定唯一的 interaction id */
export function makeInteractionId(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `dur-${Date.now().toString(36)}-${suffix}`;
}

/** 按过滤条件匹配 */
export function matchesFilter(record: DurableInteraction, filter?: DurableInteractionFilter): boolean {
  if (!filter) return true;
  if (filter.key !== undefined && record.key !== filter.key) return false;
  if (filter.kind !== undefined && record.kind !== filter.kind) return false;
  if (filter.owner !== undefined && record.owner !== filter.owner) return false;
  if (filter.correlationId !== undefined && record.correlationId !== filter.correlationId) return false;
  if (filter.state !== undefined && record.state !== filter.state) return false;
  return true;
}

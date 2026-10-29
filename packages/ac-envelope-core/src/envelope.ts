// ============================================================
// envelope.ts —— 信封 schema 与字段语义（协议规格 A1 / A3 / A4）
//
// 一切投递的统一载体（A6）：uuid = 会话身份（一次会话一个，永不重发），
// requestId = 投递幂等键（每封一个，重发不变）。EndpointId 开放词汇：
// user / agent id / host / group 地址 / child id。
// ============================================================

/** 信封 kind（A1）：message = 普通发言/任务信/终稿回复；grant/revoke = 授权
 * 状态变更信（域外唯一动作类）；receipt = 观察回执（指纹+快照对位） */
export type EnvelopeKind = 'message' | 'grant' | 'revoke' | 'receipt';

/** 端点 id（开放词汇——不做结构断言，寻址归邮局/直投层） */
export type EndpointId = string;

export interface Envelope {
  /** 会话身份键：首条消息发送方生成（UUIDv7），随首消息投递，之后不变 */
  uuid: string;
  /** 投递幂等键：每封独立生成（UUIDv4 即可）；同键重发 = 接收方去重 */
  requestId: string;
  /** 发送方端点：user | <agentId> | host | <childId> */
  sender: EndpointId;
  /** 接收方端点（扇出时为多播地址，邮局展开） */
  to: EndpointId;
  kind: EnvelopeKind;
  /** 防自激预算：收到本信后至多可自动唤醒 run 的次数。每次自动唤醒 -1，
   * 0 = 不再触发 run（只落账不激活，不入 inbox——A4）；user 直发重置满额 */
  budget: number;
  /** 邮局中继跳数（直投 = 0；每经一次发件箱滞留中继 +1）——诊断用，
   * 不参与裁决（budget 才是防自激承重字段） */
  hop?: number;
  /** 按 kind 分型：message = 行协议消息体；grant/revoke = 授权变更单；
   * receipt = 指纹 + 快照元数据 */
  payload: unknown;
  /** 终稿回信目标覆盖（cr-638）：sender ≠ 回信目标时显式指定。late-reply
   * 重放以 owner（本 agent）作 sender 保 replayView 投影语义，但终稿必须回给
   * user——缺此字段时 postReply 投回自身端点，形成自激回环（每次收束再拉
   * 一轮 run，预算耗尽前反复自答）。缺席 = 回给 sender。 */
  replyTo?: EndpointId;
  /** 会话级模型覆盖（'name@model' 或裸模型名）——deliver 合并点的产物
   * （显式入参 > conv-settings 存储，cr-565）。随信投递而非壳内查表：
   * 排队/inbox 重放的信仍按其投递时刻的覆盖跑，语义确定。 */
  model?: string;
  /** 单次投递提权档位（'sandbox-access' | 'full-access'——access-tier
   * §七：临时提权随信投递而非壳内查表，主线 loop request.elevation 同
   * 词汇；缺席 = 按 Agent tags 档位〔tierOf〕。cr-626：输入框档位选择
   * 此前在 deliver 边界被丢——full-access 下 pwsh workdir 仍按 base 拦）。 */
  elevation?: 'sandbox-access' | 'full-access';
}

/** budget 缺省值（MAX_AUTO_WAKES 同源值 3，现状常量语义平移） */
export const DEFAULT_BUDGET = 3;

export type EnvelopeField = 'uuid' | 'requestId' | 'sender' | 'to' | 'kind' | 'budget' | 'hop' | 'model' | 'elevation';

export interface EnvelopeValidationIssue {
  field: EnvelopeField;
  message: string;
}

const KINDS: ReadonlySet<string> = new Set(['message', 'grant', 'revoke', 'receipt']);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** 结构校验（纯函数，fail-closed：只收集不修复） */
export function validateEnvelope(env: Envelope): EnvelopeValidationIssue[] {
  const issues: EnvelopeValidationIssue[] = [];
  if (!isNonEmptyString(env.uuid)) issues.push({ field: 'uuid', message: '会话身份键缺失' });
  if (!isNonEmptyString(env.requestId)) issues.push({ field: 'requestId', message: '投递幂等键缺失' });
  if (!isNonEmptyString(env.sender)) issues.push({ field: 'sender', message: '发送方端点缺失' });
  if (!isNonEmptyString(env.to)) issues.push({ field: 'to', message: '接收方端点缺失' });
  if (!KINDS.has(env.kind)) issues.push({ field: 'kind', message: `未知 kind: ${String(env.kind)}` });
  if (!Number.isInteger(env.budget) || env.budget < 0) issues.push({ field: 'budget', message: '预算须为非负整数' });
  if (env.hop !== undefined && (!Number.isInteger(env.hop) || env.hop < 0)) {
    issues.push({ field: 'hop', message: '跳数须为非负整数' });
  }
  if (env.model !== undefined && !isNonEmptyString(env.model)) {
    issues.push({ field: 'model', message: '模型覆盖须为非空字符串' });
  }
  if (env.elevation !== undefined && !(['sandbox-access', 'full-access'] as const).includes(env.elevation)) {
    issues.push({ field: 'elevation', message: `未知提权档位: ${String(env.elevation)}` });
  }
  return issues;
}

/** 工厂（除 uuid/requestId 由发送方签发外全部缺省化） */
export function makeEnvelope(init: {
  uuid: string;
  requestId: string;
  sender: EndpointId;
  to: EndpointId;
  kind?: EnvelopeKind;
  budget?: number;
  hop?: number;
  payload?: unknown;
  replyTo?: EndpointId;
  model?: string;
  elevation?: 'sandbox-access' | 'full-access';
}): Envelope {
  return {
    uuid: init.uuid,
    requestId: init.requestId,
    sender: init.sender,
    to: init.to,
    kind: init.kind ?? 'message',
    budget: init.budget ?? DEFAULT_BUDGET,
    hop: init.hop,
    payload: init.payload ?? null,
    ...(init.replyTo !== undefined ? { replyTo: init.replyTo } : {}),
    ...(init.model !== undefined ? { model: init.model } : {}),
    ...(init.elevation !== undefined ? { elevation: init.elevation } : {}),
  };
}

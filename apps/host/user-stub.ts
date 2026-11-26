// ============================================================
// user-stub.ts —— user 壳桩（M8.4；R-2 webui 形态）
//
// user 端点无进程 → 必须有壳：webui 形态 = 宿主进程内极薄 user 壳
//（R-2）。send = 签发（R-1：发送方签发 UUIDv7）+ 邮局投递——发言行由
// 壳侧落 agent 域入站行（deliverRow）；收信面 = 邮局 local 通道（进程内
// 直调）。
// cr-1344（cr-1343 user 域对称化）：本桩成为 user 域唯一写者——agent→user
// 投递落 agents/user/sessions/<uuid>/messages.jsonl（入站行同构：role:agent、
// agent_id=sender、requestId 幂等锚；机制信 context+event 同 inboundRowOf 口径）。
// sender 侧出站行退役（deliver 跨壳分支）；回放读面全域并读（conversationDirs
// 自动带上 user 域）。直播帧顺序对齐壳侧入站语义：先 durable 后广播。
// ============================================================
import type { Envelope } from 'ac-envelope-core';
import { issueConversationId, issueRequestId, makeEnvelope } from 'ac-envelope-core';
import { projectUserReplay, LedgerWriter, sessionDir, type LedgerAttachment, type LedgerRow, type UserReplayRow } from 'ac-ledger';
import type { PostOffice, DispatchResult } from 'ac-post-office';

export interface UserSendOptions {
  /** 续聊会话键（缺省 = 新签发——R-1 发送方签发） */
  uuid?: string;
  requestId?: string;
  /** 会话级模型覆盖（deliver 合并点产物——随信投递，cr-565） */
  model?: string;
  /** 忙态投递方式（DSH 语义——随 payload 透传壳侧 ConversationMachine 决策，cr-575） */
  lane?: 'next-step' | 'next-turn';
  placement?: 'steer' | 'next-run';
  /**
   * 多模态附件引用（cr-1278）：随信封 payload 透传——壳侧入站行落账、
   * 回放还原为 LlmMessage.attachments（provider 边界物化）。只存引用。
   */
  attachments?: LedgerAttachment[];
}

/**
 * user 壳桩（宿主内极薄——非 cordis 行：user 端点无行集无 run，
 * 只是投递原语的 user 侧执行体 + user 域收信账本唯一写者〔cr-1344〕）。
 */
export class UserStub {
  private readonly po: PostOffice;
  private readonly dataRoot: string;
  /** user 域 writer 注册表（per-uuid 惰性——cr-1344 收信落账面） */
  private readonly writers = new Map<string, LedgerWriter>();
  /** 会话新行通知（cr-870/973：宿主装配点连 ctx.emit——语义 = 该会话
   *  agent 域有新事实，singles 注册表条目宜标 stale） */
  private readonly onAppend?: (uuid: string) => void;
  /** 独立私信直播帧（cr-1144）：send_agent(to:'user') 的非回信信封 →
   *  router/message-received 前端帧出口（装配点注入 webServer.broadcast）。
   *  缺席 = 无直播面（CLI/纯测试形态）。 */
  private readonly onStandalone?: (agentId: string, text: string, requestId: string, uuid: string) => void;

  constructor(
    po: PostOffice,
    dataRoot: string,
    onAppend?: (uuid: string) => void,
    onStandalone?: (agentId: string, text: string, requestId: string, uuid: string) => void,
  ) {
    this.po = po;
    this.dataRoot = dataRoot;
    this.onAppend = onAppend;
    this.onStandalone = onStandalone;
  }

  /** user 域 writer（agents/user/sessions/<uuid>/——cr-1344 收信落账面） */
  private writerFor(uuid: string): LedgerWriter {
    let w = this.writers.get(uuid);
    if (w === undefined) {
      // participants 首建生效（对桶键双端 / single 桶 uuid——写者域恒 user）
      w = new LedgerWriter(sessionDir(this.dataRoot, 'user', uuid), { participants: ['user'], kind: 'user' });
      this.writers.set(uuid, w);
    }
    return w;
  }

  /** 起桩：user 端点注册进邮局 local 通道 */
  start(): void {
    this.po.registerLocal('user', async (env: Envelope) => this.receive(env));
  }

  stop(): void {
    this.po.unregisterLocal('user');
  }

  /** user 发言（R-1/R-2）：签发 + 投递（发言行由壳落 agent 域入站行）。
   *  通知时机 = 投递完成（行落账在壳侧异步——通知语义是「宜失效」，
   *  装载对账兜底；终稿信到达时还有一次精确通知）。 */
  async send(agentId: string, text: string, options: UserSendOptions = {}): Promise<{ uuid: string; dispatched: DispatchResult[] }> {
    const uuid = options.uuid ?? issueConversationId();
    const requestId = options.requestId ?? 'u-' + issueRequestId();
    const dispatched = await this.po.dispatch(makeEnvelope({
      uuid, requestId, sender: 'user', to: agentId,
      payload: {
        text,
        ...(options.lane !== undefined ? { lane: options.lane } : {}),
        ...(options.placement !== undefined ? { placement: options.placement } : {}),
        ...(options.attachments !== undefined ? { attachments: options.attachments } : {}),
      },
      ...(options.model !== undefined ? { model: options.model } : {}),

    }));
    this.onAppend?.(uuid);
    return { uuid, dispatched };
  }

  /** user 视角回放（终稿层读时投影——webui 读面消费） */
  replay(uuid: string): UserReplayRow[] {
    return projectUserReplay(this.dataRoot, uuid);
  }

  /** 收信面（agent 终稿/通知/私信到达 user 端点）：cr-1344 起本桩是 user
   *  域唯一写者——收信先 durable 落 agents/user/sessions/<uuid>/（A2 落账
   *  即确认，requestId 幂等在 writer 内；机制信 context+event 同
   *  inboundRowOf 口径不打标），再走通知/直播（先 durable 后广播——与壳
   *  侧入站语义对齐）。回信信封的 run/runMs 随行透传（读面 steps 联查锚）。
   *  独立私信直播（cr-1144）：非回信信封（send_agent(to:'user')）发
   *  router/message-received 帧（前端既有 case 直消费，message_id =
   *  requestId 幂等锚）。回信信封（payload.run 在场）跳过帧：run/settled
   *  已计，再发即双计。 */
  private async receive(env: Envelope): Promise<{ ack: string; fresh: boolean }> {
    const payload = env.payload as { text?: unknown; run?: unknown; runMs?: unknown; mechanism?: unknown } | null;
    const text = env.kind === 'message' && payload !== null && typeof payload === 'object' && typeof payload.text === 'string'
      ? payload.text
      : '';
    // durable 落账（cr-1344）：一切 message 信封入账（机制信转 context 行——
    // 壳侧 inboundRowOf 同构；receipt/grant 等 kind 非消息体不落）。
    // timestamp = 落行时刻（无快照语义需求——与壳侧 deliverRow 同口径）。
    if (env.kind === 'message') {
      const mechanism = payload?.mechanism === true;
      const row: Omit<LedgerRow, 'message_id' | 'timestamp' | 'seq'> = mechanism
        ? { role: 'context', source: 'event', content: text, agent_id: env.sender, requestId: env.requestId, uuid: env.uuid }
        : {
          role: 'agent',
          content: text,
          agent_id: env.sender,
          requestId: env.requestId,
          uuid: env.uuid,
          ...(typeof payload?.run === 'string' && payload.run !== '' ? { run: payload.run } : {}),
          ...(typeof payload?.runMs === 'number' ? { runMs: payload.runMs } : {}),
          delivered: true as const,
        };
      await this.writerFor(env.uuid).deliver(row);
    }
    this.onAppend?.(env.uuid);
    if (this.onStandalone !== undefined && env.kind === 'message') {
      if (text !== '' && payload?.run === undefined) {
        this.onStandalone(env.sender, text, env.requestId, env.uuid);
      }
    }
    return { ack: env.requestId, fresh: true };
  }
}

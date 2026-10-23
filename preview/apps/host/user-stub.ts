// ============================================================
// user-stub.ts —— user 壳桩（M8.4；R-2 webui 形态）
//
// user 端点无进程 → 必须有壳：webui 形态 = 宿主进程内极薄 user 壳
//（R-2）。send = 签发（R-1：发送方签发 UUIDv7）+ own 落账 + 邮局
// 投递；收信面 = 邮局 local 通道（进程内直调），agent 终稿经
// writeThrough 写穿 user 账本（requestId 幂等）。写权循 webui 单
// 进程串行（R-2a）——桩即唯一写者。
// ============================================================
import type { Envelope } from 'ac-envelope-core';
import { issueConversationId, issueRequestId, makeEnvelope } from 'ac-envelope-core';
import { UserLedger, type UserReplayRow } from 'ac-ledger';
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
}

/**
 * user 壳桩（宿主内极薄——非 cordis 行：user 端点无行集无 run，
 * 只是投递原语的 user 侧执行体）。
 */
export class UserStub {
  private readonly ledgers = new Map<string, UserLedger>();
  private readonly po: PostOffice;
  private readonly dataRoot: string;

  constructor(po: PostOffice, dataRoot: string) {
    this.po = po;
    this.dataRoot = dataRoot;
  }

  /** 起桩：user 端点注册进邮局 local 通道 */
  start(): void {
    this.po.registerLocal('user', async (env: Envelope) => this.receive(env));
  }

  stop(): void {
    this.po.unregisterLocal('user');
  }

  /** user 发言（R-1/R-2）：签发 + own 落账 + 投递 */
  async send(agentId: string, text: string, options: UserSendOptions = {}): Promise<{ uuid: string; dispatched: DispatchResult[] }> {
    const uuid = options.uuid ?? issueConversationId();
    const requestId = options.requestId ?? 'u-' + issueRequestId();
    await this.ledgerFor(uuid, agentId).writeOwn(text, requestId);
    const dispatched = await this.po.dispatch(makeEnvelope({
      uuid, requestId, sender: 'user', to: agentId,
      payload: {
        text,
        ...(options.lane !== undefined ? { lane: options.lane } : {}),
        ...(options.placement !== undefined ? { placement: options.placement } : {}),
      },
      ...(options.model !== undefined ? { model: options.model } : {}),
    }));
    return { uuid, dispatched };
  }

  /** user 视角回放（终稿层投影——webui 读面消费） */
  replay(uuid: string): UserReplayRow[] {
    return new UserLedger(this.dataRoot, uuid, ['user']).replay();
  }

  /** 收信面（agent 终稿/来信到达 user 端点）：写穿 user 账本 + ack */
  private async receive(env: Envelope): Promise<{ ack: string; fresh: boolean }> {
    const payload = env.payload as { text?: string; run?: string } | null;
    const text = typeof payload?.text === 'string' ? payload.text : '';
    // payload.run（cr-595）：终稿产生 run 的键——盖 source=run:<id> 戳供
    // webui history 按 run 联查 agent 账本 journal（D4.2 思考/工具卡带出）。
    const run = typeof payload?.run === 'string' && payload.run !== '' ? payload.run : undefined;
    const fresh = await this.ledgerFor(env.uuid, env.sender).writeThrough({
      agentId: env.sender,
      content: text,
      uuid: env.uuid,
      requestId: env.requestId,
      ...(run !== undefined ? { run } : {}),
    });
    return { ack: env.requestId, fresh };
  }

  /** per-uuid 账本缓存（同进程同 writer——AdmissionGate 幂等跨信封有效） */
  private ledgerFor(uuid: string, peerId: string): UserLedger {
    let ledger = this.ledgers.get(uuid);
    if (ledger === undefined) {
      ledger = new UserLedger(this.dataRoot, uuid, ['user', peerId]);
      this.ledgers.set(uuid, ledger);
    }
    return ledger;
  }
}

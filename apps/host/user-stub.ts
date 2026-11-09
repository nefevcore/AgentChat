// ============================================================
// user-stub.ts —— user 壳桩（M8.4；R-2 webui 形态）
//
// user 端点无进程 → 必须有壳：webui 形态 = 宿主进程内极薄 user 壳
//（R-2）。send = 签发（R-1：发送方签发 UUIDv7）+ 邮局投递——发言行由
// 壳侧落 agent 域入站行（deliverRow）；收信面 = 邮局 local 通道（进程内
// 直调），agent 终稿信到达即通知宿主缓存面失效。cr-973（cr-972 第一刀）
// 起 viewer 物化账本退役：本桩不再写任何消息文件（写权归壳侧 agent
// 域账本），回放走读时投影 projectUserReplay。
// ============================================================
import type { Envelope } from 'ac-envelope-core';
import { issueConversationId, issueRequestId, makeEnvelope } from 'ac-envelope-core';
import { projectUserReplay, type UserReplayRow } from 'ac-ledger';
import type { PostOffice, DispatchResult } from 'ac-post-office';

export interface UserSendOptions {
  /** 续聊会话键（缺省 = 新签发——R-1 发送方签发） */
  uuid?: string;
  requestId?: string;
  /** 会话级模型覆盖（deliver 合并点产物——随信投递，cr-565） */
  model?: string;
  /** 单次投递安全档位（cr-626；cr-947 前名 elevation：输入框档位选择随信投递——信封字段） */
  access?: 'sandbox-access' | 'full-access';
  /** 忙态投递方式（DSH 语义——随 payload 透传壳侧 ConversationMachine 决策，cr-575） */
  lane?: 'next-step' | 'next-turn';
  placement?: 'steer' | 'next-run';
}

/**
 * user 壳桩（宿主内极薄——非 cordis 行：user 端点无行集无 run，
 * 只是投递原语的 user 侧执行体）。
 */
export class UserStub {
  private readonly po: PostOffice;
  private readonly dataRoot: string;
  /** 会话新行通知（cr-870/973：宿主装配点连 ctx.emit——语义 = 该会话
   *  agent 域有新事实，singles 注册表条目宜标 stale） */
  private readonly onAppend?: (uuid: string) => void;

  constructor(po: PostOffice, dataRoot: string, onAppend?: (uuid: string) => void) {
    this.po = po;
    this.dataRoot = dataRoot;
    this.onAppend = onAppend;
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
      },
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.access !== undefined ? { access: options.access } : {}),
    }));
    this.onAppend?.(uuid);
    return { uuid, dispatched };
  }

  /** user 视角回放（终稿层读时投影——webui 读面消费） */
  replay(uuid: string): UserReplayRow[] {
    return projectUserReplay(this.dataRoot, uuid);
  }

  /** 收信面（agent 终稿/通知到达 user 端点）：cr-973 起纯通知——agent 域
   *  行已 durable（壳落账先于回信），viewer 派生器退役，通知缓存面失效。 */
  private async receive(env: Envelope): Promise<{ ack: string; fresh: boolean }> {
    this.onAppend?.(env.uuid);
    return { ack: env.requestId, fresh: true };
  }
}

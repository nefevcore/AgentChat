// ============================================================
// post-office.ts —— 邮局投递执行器（B1 三通道执行面；M8.4）
//
// 路由决策（router.ts 纯函数）× IO 执行：direct = ipc 帧投递
// （连接池）或进程内直调（hint local:<endpointId>——宿主内端点，
// 如 user 壳桩）；outbox = 落盘滞留（at-least-once——重投由接收方
// requestId 幂等去重）。uuid 登记校验（R-1）在路由内先行，冲突
// fail-loud。
// ============================================================
import * as path from 'node:path';
import type { Envelope } from 'ac-envelope-core';
import { socketPathFor } from 'ac-envelope-core';
import { ConversationRegistry, ReachabilityTable } from './registry.ts';
import { routeEnvelope, type MulticastTable, type RouteTarget } from './router.ts';
import { Outbox, type OutboxEntry } from './outbox.ts';
import { listenIpc, IpcClient, type PostOfficeServer } from './ipc.ts';

/** 端点收信面（进程内直调通道——hint local:<endpointId> 的落点） */
export type LocalReceiver = (envelope: Envelope) => Promise<{ ack: string; fresh: boolean }>;

const LOCAL_PREFIX = 'local:';

/** 单端点投递结果 */
export interface DispatchResult {
  to: string;
  channel: 'direct' | 'local' | 'outbox';
  /** 接收方 ack（A2 落账即确认）；null = 投递失败已转滞留 */
  ack: { ack: string; fresh: boolean } | null;
}

export interface PostOfficeOptions {
  dataRoot: string;
  /** ipc 监听地址（缺省 = <dataRoot>/ipc/post-office——socketPathFor） */
  address?: string;
  multicast?: MulticastTable;
  /**
   * 端点拉起钩子（按需拉起——编排面注入）：投递中端点不可达时以
   * fire-and-forget 触发（结果不改投递路径——信恒落箱，拉起完成经
   * D2 节拍 2 转投）。拒绝/缺钩子不阻塞投递。
   */
  ensureHook?: (target: RouteTarget) => void;
}

/**
 * 邮局（宿主进程内单例）：投递执行 + 端点可达登记 + 发件箱滞留。
 * user 壳桩等宿主内端点经 registerLocal 注册（local 通道——D2
 * 「通道多种、协议层恒一」的进程内形态）。
 */
export class PostOffice {
  readonly registry = new ConversationRegistry();
  readonly reach = new ReachabilityTable();
  private readonly outbox: Outbox;
  private readonly address: string;
  private readonly multicast: MulticastTable | undefined;
  private readonly locals = new Map<string, LocalReceiver>();
  private readonly pool = new Map<string, IpcClient>();
  private ensureHook: ((target: RouteTarget) => void) | undefined;
  private server: PostOfficeServer | null = null;

  constructor(options: PostOfficeOptions) {
    this.outbox = new Outbox(options.dataRoot);
    this.address = options.address ?? socketPathFor(path.resolve(options.dataRoot), 'post-office');
    this.multicast = options.multicast;
  }

  /** 进程内端点注册（user 壳桩等）：可达表同步标记 local:<endpointId> */
  registerLocal(endpointId: string, receiver: LocalReceiver): void {
    this.locals.set(endpointId, receiver);
    this.reach.markReachable(endpointId, LOCAL_PREFIX + endpointId);
  }

  unregisterLocal(endpointId: string): void {
    this.locals.delete(endpointId);
    this.reach.markGone(endpointId);
  }

  /** 端点拉起钩子注册（编排面——boot 后接线；构造期注入同形） */
  setEnsureHook(hook: (target: RouteTarget) => void): void {
    this.ensureHook = hook;
  }

  /** 单 hint 投递：local 直调 / ipc 帧（连接池——失败逐出，下次重连） */
  private async deliverVia(hint: string, envelope: Envelope): Promise<{ ack: string; fresh: boolean }> {
    if (hint.startsWith(LOCAL_PREFIX)) {
      const receiver = this.locals.get(hint.slice(LOCAL_PREFIX.length));
      if (receiver === undefined) throw new Error('local 端点未注册：' + hint);
      return receiver(envelope);
    }
    let client = this.pool.get(hint);
    if (client === undefined) {
      client = new IpcClient();
      await client.connect(hint);
      this.pool.set(hint, client);
    }
    // ack 帧谓词：壳连接上混走的 B3 旁带 stream 帧（壳 uplink 广播）跳过
    const isAckFrame = (frame: unknown): boolean => {
      if (typeof frame !== 'object' || frame === null) return false;
      const f = frame as { ack?: unknown; fresh?: unknown };
      return typeof f.ack === 'string' && typeof f.fresh === 'boolean';
    };
    try {
      return (await client.request(envelope, isAckFrame)) as { ack: string; fresh: boolean };
    } catch (err) {
      this.pool.delete(hint);
      client.close();
      throw err;
    }
  }

  /** 投递（路由三通道执行）：登记校验先行（冲突 throw）；直投失败转滞留 */
  async dispatch(envelope: Envelope): Promise<DispatchResult[]> {
    const instructions = routeEnvelope(envelope, {
      registry: this.registry,
      reach: this.reach,
      ...(this.multicast !== undefined ? { multicast: this.multicast } : {}),
    });
    const out: DispatchResult[] = [];
    for (const inst of instructions) {
      if (inst.channel === 'outbox') {
        // 先落箱再触发拉起（cr-647）：ensureHook 可能在钩内立即回登记可达并
        // 同步 flushOutbox（撞活锁救援面）——信必须先入箱，否则本次转投看不
        // 见触发它的这封信，滞留成死信（宿主换代后活壳消息全滞留现场）。
        this.outbox.store(inst.envelope, inst.reason);
        // 按需拉起（cr-551 编排面）：不可达即触发端点拉起（fire-and-forget——
        // 拒绝不改路径，信恒落箱；拉起完成后 adopted 转投 outbox 滞留信）
        if (this.ensureHook !== undefined) {
          try { this.ensureHook(inst.to); } catch { /* 拉起拒绝不阻塞投递 */ }
        }
        out.push({ to: inst.to, channel: 'outbox', ack: null });
        continue;
      }
      try {
        const ack = await this.deliverVia(inst.transportHint, inst.envelope);
        out.push({
          to: inst.to,
          channel: inst.transportHint.startsWith(LOCAL_PREFIX) ? 'local' : 'direct',
          ack,
        });
      } catch {
        // 直投失败（端点死/连接断）→ 摘除陈旧可达项 + 落箱 + 按需拉起（at-least-once）。
        // cr-648：此前只落箱不摘可达项也不触发拉起——壳死但宿主不知情时，
        // 陈旧 transportHint 让之后每一封信都静默进箱、无人重拉（「消息发出去
        // 没反应」现场）。与不可达同链：先落箱（ensureHook 内同步 flush 要看得到
        // 触发信，cr-647）再拉起。
        // local 通道（user/host 桩）不摘项：处理器抛错 ≠ 端点死，摘了会断掉
        // 同 requestId 的幂等重投（at-least-once 面由落箱重试承载）。
        if (!inst.transportHint.startsWith(LOCAL_PREFIX)) this.reach.markGone(inst.to);
        this.outbox.store(inst.envelope, 'send-failed');
        if (this.ensureHook !== undefined) {
          try { this.ensureHook(inst.to); } catch { /* 拉起拒绝不阻塞投递 */ }
        }
        out.push({ to: inst.to, channel: 'outbox', ack: null });
      }
    }
    return out;
  }

  /** 发件箱转投（通道恢复节拍）：ack 到手即出箱；失败留箱重试 */
  async flushOutbox(): Promise<Array<{ entry: OutboxEntry; ack: { ack: string; fresh: boolean } }>> {
    const delivered: Array<{ entry: OutboxEntry; ack: { ack: string; fresh: boolean } }> = [];
    for (const { entry, transportHint } of this.outbox.flush((id) => this.reach.hintFor(id))) {
      try {
        const ack = await this.deliverVia(transportHint, entry.envelope);
        this.outbox.remove(entry.seq, entry.envelope.requestId);
        delivered.push({ entry, ack });
      } catch {
        // 留箱（下次 flush 重试）
      }
    }
    return delivered;
  }

  /** ipc 监听（外部发送方帧投递面——壳 postReply 回链用）：信封帧 → dispatch → 回执帧 */
  async listen(): Promise<PostOfficeServer> {
    this.server = await listenIpc(this.address, async (payload) => {
      const env = payload as Envelope | null;
      if (typeof env !== 'object' || env === null
        || typeof env.requestId !== 'string' || typeof env.sender !== 'string') {
        return undefined;
      }
      return { dispatched: await this.dispatch(env) };
    });
    return this.server;
  }

  get listeningAddress(): string {
    return this.address;
  }

  async close(): Promise<void> {
    for (const client of this.pool.values()) client.close();
    this.pool.clear();
    if (this.server !== null) await this.server.close();
    this.server = null;
  }
}

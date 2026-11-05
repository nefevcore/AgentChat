// ============================================================
// ac-host-face-core/src/client.ts —— host-face 契约 client（corrId 多路复用）
//
// 直连 socket + FrameDecoder 自管分发（IpcClient 单飞语义不满足工具
// execute 并发）。corrId = <随机前缀>-<单调序>——进程重启后前缀换新，
// 宿主侧陈旧 corrId 回帧自然丢弃。
// ============================================================
import * as net from 'node:net';
import { encodeFrame, FrameDecoder } from 'ac-envelope-core';
import { isHostFaceFrame, type HostFaceContract, type HostFaceFrame } from './contract.ts';

/** 连接失败/断连语义：调用方各自良定义降级（discover 失败 = 能力缺席） */
export class HostFaceClient {
  private socket: net.Socket | null = null;
  private decoder = new FrameDecoder();
  private seq = 0;
  private readonly prefix: string;
  /** corrId → 在途请求 resolver；断连时全部拒绝 */
  private pending = new Map<string, { resolve: (v: HostFaceFrame) => void; reject: (e: Error) => void }>();
  /** invalidate 通知面（壳侧挂回调重拉 discover） */
  onInvalidate: (() => void) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastAddress = '';

  constructor() {
    this.prefix = Math.random().toString(36).slice(2, 8);
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  /** 连接（幂等：已连接直返；错误语义 = 拒绝，调用方降级） */
  connect(address: string): Promise<void> {
    if (this.socket !== null) return Promise.resolve();
    this.lastAddress = address;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(address, () => resolve());
      socket.on('error', (err) => {
        this.failAll(err);
        reject(err);
      });
      socket.on('data', (chunk) => this.feed(chunk));
      socket.on('close', () => {
        this.failAll(new Error('host-face 连接断开'));
        this.socket = null;
        if (this.lastAddress !== '') this.scheduleReconnect();
      });
      this.socket = socket;
    });
  }

  /** 宿主重启窗口：退避重连（250ms 起、上限 5s）——成功即停 */
  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    let delay = 250;
    const attempt = (): void => {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.connect(this.lastAddress).then(
          () => { this.onInvalidate?.(); }, // 重连成功 = 契约可能已变（宿主换代），重拉
          () => { delay = Math.min(delay * 2, 5000); attempt(); },
        );
      }, delay);
    };
    attempt();
  }

  private feed(chunk: Buffer): void {

    let frames: unknown[];
    try {
      frames = this.decoder.push(chunk);
    } catch {
      this.socket?.destroy();
      return;
    }
    for (const f of frames) {
      if (!isHostFaceFrame(f)) continue;
      if (f.kind === 'invalidate') {
        this.onInvalidate?.();
        continue;
      }
      const waiter = this.pending.get(f.corrId);
      if (waiter !== undefined) {
        this.pending.delete(f.corrId);
        waiter.resolve(f);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, w] of this.pending) w.reject(err);
    this.pending.clear();
  }

  private nextCorrId(): string {
    this.seq += 1;
    return this.prefix + '-' + this.seq.toString(36);
  }

  /** 发帧并等同 corrId 回帧（多在途并发安全） */
  private roundtrip(frame: Record<string, unknown>): Promise<HostFaceFrame> {
    if (this.socket === null) return Promise.reject(new Error('host-face 未连接'));
    const corrId = this.nextCorrId();
    const payload = { ...frame, corrId };
    return new Promise((resolve, reject) => {
      this.pending.set(corrId, { resolve, reject });
      this.socket!.write(encodeFrame(payload), (err) => {
        if (err != null) {
          this.pending.delete(corrId);
          reject(err);
        }
      });
    });
  }

  /** 拉取完整契约（宿主缺席 = reject，调用方降级） */
  async discover(): Promise<HostFaceContract> {
    const reply = await this.roundtrip({ kind: 'discover' });
    if (reply.kind !== 'contract') throw new Error('host-face discover 回帧非 contract');
    return reply.contract;
  }

  /** 远程工具执行（透传执行身份——宿主闸复查用） */
  async execute(tool: string, args: Record<string, unknown>, identity?: { agentId?: string; conversationId?: string }): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const reply = await this.roundtrip({ kind: 'execute', tool, args, ...identity });
    if (reply.kind !== 'exec-result') throw new Error('host-face execute 回帧非 exec-result');
    return { ok: reply.ok, result: reply.result, error: reply.error };
  }

  /** 活性探测 */
  async ping(): Promise<boolean> {
    const reply = await this.roundtrip({ kind: 'ping' });
    return reply.kind === 'pong';
  }

  close(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.lastAddress = '';
    this.socket?.destroy();
    this.socket = null;
    this.failAll(new Error('client 关闭'));
  }
}
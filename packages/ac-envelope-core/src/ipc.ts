// ============================================================
// ipc.ts —— ipc socket 传输（协议规格 B1/B2 通道）
//
// 监听地址 = socketPathFor(dataRoot, <endpoint>)（数据根内聚 ipc/ 域）；
// 帧 = 长度前缀 JSON（frame.ts）。连接 = 每客户端一连接，帧到达即回调
//（信封或控制帧——载荷语义归上层）。cr-861 自 ac-post-office 移入：
// 传输层是信封协议通道面（B1），deliver 对等投递纯库（deliver.ts）与
// 邮局同为消费者——归协议库断「deliver → post-office」循环依赖。
//
// cr-1046 失败面闭环：onFrame reject 不再静默吞（旧注释自称「发送方
// 超时重发兜底」但 request 无超时实现——兜底从未存在）：回 __ipcReject
// 错误帧让发送方明确失败；request 缺省 15s 超时兜半死连接。现场：邮局
// dispatch 的 uuid 登记冲突 throw 被吞 → 壳 postReply 永挂 → activeRuns
// 泄漏（三壳 busy 永真、前端「运行中」假象十余小时）。
// ============================================================
import * as net from 'node:net';
import { encodeFrame, FrameDecoder } from './frame.ts';

/** 传输层错误回帧（onFrame reject 的 wire 形——发送方 IpcClient 转 reject） */
export interface IpcRejectFrame {
  __ipcReject: string;
}

/** 错误帧判定 */
export function isIpcRejectFrame(frame: unknown): frame is IpcRejectFrame {
  return typeof (frame as { __ipcReject?: unknown } | null)?.__ipcReject === 'string';
}

export interface IpcServer {
  address: string;
  close(): Promise<void>;
}

/**
 * 起 ipc 监听（host 进程内）。onFrame 每帧回调（可异步——IpcClient
 * 逐帧等回执，无并发乱序）；返回值经 write 回帧。
 */
export function listenIpc(
  address: string,
  onFrame: (payload: unknown) => unknown | undefined | Promise<unknown | undefined>,
): Promise<IpcServer> {
  return listenIpcConns(address, onFrame).then((r) => r.server);
}

/**
 * listenIpc 的连接集形态（cr-886）：宿主能力面需要 server 侧主动推帧
 * （invalidate 广播）——返回在连 socket 集（帧写入经 encodeFrame）。
 * listenIpc 语义不变（内部委托本函数）。
 */
export function listenIpcConns(
  address: string,
  onFrame: (payload: unknown) => unknown | undefined | Promise<unknown | undefined>,
): Promise<{ server: IpcServer; conns: Set<net.Socket> }> {
  return new Promise((resolve, reject) => {
    // 连接跟踪：close 时强制销毁（对端常驻连接〔壳 postReply 池〕不主动
    // 断——server.close 回调等连接断尽会永挂；关停路径强制断连安全，
    // at-least-once 由发送方重发兜底）
    const conns = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      conns.add(socket);
      socket.on('close', () => conns.delete(socket));
      const decoder = new FrameDecoder();
      socket.on('data', (chunk: Buffer) => {
        let frames: unknown[];
        try {
          frames = decoder.push(chunk);
        } catch {
          socket.destroy(); // 通道污染——断连
          return;
        }
        for (const frame of frames) {
          // cr-1046：onFrame 失败（同步 throw 或异步 reject）统一回 __ipcReject
          // 错误帧（不静默吞——吞 = 发送方永等）。同步 throw 需在此捕获：裸调会
          // 炸 socket data handler（uncaught exception）。
          let handled: Promise<unknown>;
          try {
            handled = Promise.resolve(onFrame(frame));
          } catch (err) {
            handled = Promise.reject(err);
          }
          void handled.then((reply) => {
            if (reply !== undefined && reply !== null) {
              try {
                socket.write(encodeFrame(reply));
              } catch {
                socket.destroy();
              }
            }
          }, (err: unknown) => {
            try {
              socket.write(encodeFrame({ __ipcReject: String(err instanceof Error ? err.message : err) } satisfies IpcRejectFrame));
            } catch {
              socket.destroy();
            }
          });
        }
      });
      socket.on('error', () => socket.destroy());
    });
    server.once('error', reject);
    server.listen(address, () => {
      server.removeListener('error', reject);
      resolve({
        server: {
          address,
          close: () => {
            for (const s of conns) s.destroy();
            return new Promise<void>((res) => server.close(() => res()));
          },
        },
        conns,
      });
    });
  });
}

/**
 * 客户端连接（壳/测试面：连一次发多帧，逐帧等回）。
 * 收帧分发：帧先喂在位 waiter（谓词型——返回 false = 未消费，waiter
 * 保持原位继续等下一帧）；无 waiter 入 queue，供下次请求先行试配。
 * 连接上混走的非回复帧（B3 旁带 stream 等）经谓词跳过丢弃——
 * 同一时刻至多一个在途请求（单飞）。
 */
export class IpcClient {
  private socket: net.Socket | null = null;
  private decoder = new FrameDecoder();
  private waiter: ((frame: unknown) => boolean) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private queue: unknown[] = [];

  /** 连接在位判定（cr-991）——连接池拒陈旧客户端用（对端关闭即 false） */
  connected(): boolean {
    return this.socket !== null;
  }

  connect(address: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(address, () => {
        resolve();
      });
      socket.once('error', reject);
      socket.on('data', (chunk: Buffer) => {
        for (const frame of this.decoder.push(chunk)) this.offer(frame);
      });
      // 对端关闭感知（cr-991）：旧实现无 close 处理——壳死后池内客户端残留
      // 「半死」socket 引用（下一次 write 才炸，现场 = outbox 转投撞死 pipe
      // 刷 W）。close 即摘 socket + 拒在途 request（否则 waiter 永挂）。
      socket.on('close', () => {
        this.socket = null;
        if (this.pendingReject !== null) {
          this.pendingReject(new Error('ipc 连接已关闭——对端退出或断连'));
          this.pendingReject = null;
        }
        this.waiter = null;
      });
      socket.on('error', () => {
        this.socket = null;
      });
      this.socket = socket;
    });
  }

  /** 帧分发：在位 waiter 谓词试配（false = 未消费继续等）；无 waiter 入队 */
  private offer(frame: unknown): void {
    if (this.waiter !== null) {
      if (this.waiter(frame)) this.waiter = null;
      return;
    }
    this.queue.push(frame);
  }

  /**
   * 请求-回执（谓词等待）：发送 payload 后等第一帧满足 isReply 的
   * 回复；不满足的帧丢弃继续等。与 send 同为单飞。
   *
   * cr-1046 双失败面：①对端回 __ipcReject 错误帧 → reject（onFrame
   * 失败的 wire 表达）；②超时（缺省 15s，timeoutMs 覆盖——对端半死/
   * 回帧丢失的自愈兜底）。两路径都让上层重试面真正可达。
   */
  request(payload: unknown, isReply: (frame: unknown) => boolean, timeoutMs = 15_000): Promise<unknown> {
    if (this.socket === null) throw new Error('ipc 未连接');
    return new Promise<unknown>((resolve, reject) => {
      if (this.waiter !== null) {
        reject(new Error('ipc request 并发——同连接至多一个在途请求'));
        return;
      }
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const consume = (frame: unknown): boolean => {
        if (this.waiter === null) return true; // 已决——吞帧
        if (isIpcRejectFrame(frame)) {
          const message = frame.__ipcReject;
          this.waiter = null;
          this.pendingReject = null;
          finish(() => reject(new Error('对端处理失败：' + message)));
          return true;
        }
        if (!isReply(frame)) return false; // 非回复帧——丢弃继续等
        this.waiter = null;
        this.pendingReject = null;
        finish(() => resolve(frame));
        return true;
      };
      const timer = setTimeout(() => {
        this.waiter = null;
        this.pendingReject = null;
        finish(() => reject(new Error('ipc 回帧超时（' + timeoutMs + 'ms）——对端未应答')));
      }, timeoutMs);
      // 队列内已有帧先行试配（send 间隙到达的）；未消费完则挂 waiter 等后续帧
      this.waiter = consume;
      this.pendingReject = (err: Error) => finish(() => reject(err));
      for (const frame of this.queue.splice(0)) {
        if (consume(frame)) break;
      }
      // 写总执行（含队列先行命中——迟到旧帧错配时真载荷已在对端，requestId
      // 幂等去重兜底；不写 = 队列命中即静默丢信）
      this.socket!.write(encodeFrame(payload), (err) => {
        // named pipe 路径成功回调 err 实测可为 null——判真值（成功 = null/undefined 均放行）
        if (err != null) {
          this.waiter = null;
          this.pendingReject = null;
          finish(() => reject(err));
          return;
        }
        // close 抢决即吞（双保险——close 回调先于 write 回调到达的窗口）
        if (!settled && this.socket === null) {
          this.waiter = null;
          this.pendingReject = null;
          finish(() => reject(new Error('ipc 连接已关闭——写入后对端断连')));
        }
      });
    });
  }

  /** 单帧即回（旧语义——谓词恒真的 request） */
  send(payload: unknown): Promise<unknown> {
    return this.request(payload, () => true);
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

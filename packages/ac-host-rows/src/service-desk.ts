// ============================================================
// service-desk.ts —— 宿主服务台（cr-1175 批 1：D4 注册面——宿主收面住
// ac-host-rows，boot 装配后注入邮局 listen 分派链）
//
// 服务动词注册 register(verb, handler)——不进可达表、不进 registry、
// 永不触发 ensureHook（掐断劫持与自激链的三重根）。两档失败语义（§4.4）：
// request 失败回 ok:false；report 失败 W/E 日志即丢。永不落盘、不重试、
// 不进 outbox。
// ============================================================
import type { ServiceTier } from 'ac-post-office';

export type ServiceHandler = (payload: unknown, ctx: { senderSocket: unknown }) => Promise<unknown> | unknown;

/** 诊断日志面（与 PostOffice onLog 同形） */
export type DeskLog = (level: 'W' | 'E', message: string) => void;

export class HostServiceDesk {
  private readonly handlers = new Map<string, ServiceHandler>();
  private readonly onLog: DeskLog | undefined;

  constructor(onLog?: DeskLog) {
    this.onLog = onLog;
  }

  /** 注册服务动词（owner 声明——usage 行 / plugin-registry 行 / auth 行 / boot 自有；
   *  tier 仅诊断词汇，不承载分派——分派按帧 reqId 在场与否） */
  register(verb: string, handler: ServiceHandler, _opts?: { tier?: ServiceTier }): void {
    this.handlers.set(verb, handler);
  }

  /** 在册动词清单（诊断面） */
  registered(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * 帧处理入口（邮局 listen onFrame 首段分派）：request 档回 ServiceAck，
   * report 档回 undefined（无回执帧——listenIpc 对 undefined 不写回）。
   * 未知 verb：request 档回 ok:false（调用方明确失败）；report 档 W 日志即丢。
   */
  async handle(frame: { svc: string; reqId?: string; payload: unknown }, senderSocket: unknown): Promise<unknown> {
    const handler = this.handlers.get(frame.svc);
    if (handler === undefined) {
      this.onLog?.('W', '服务动词未注册：' + frame.svc + '（在册：' + (this.registered().join(',') || '无') + '）');
      if (typeof frame.reqId === 'string') {
        return { reqId: frame.reqId, ok: false, error: '服务动词未注册：' + frame.svc };
      }
      return undefined;
    }
    try {
      const result = await handler(frame.payload, { senderSocket });
      return typeof frame.reqId === 'string'
        ? { reqId: frame.reqId, ok: true, ...(result !== undefined ? { result } : {}) }
        : undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onLog?.('E', '服务动词处理失败（' + frame.svc + '）：' + msg);
      return typeof frame.reqId === 'string'
        ? { reqId: frame.reqId, ok: false, error: msg }
        : undefined; // report 档失败不回执（fire-and-forget——W/E 已记）
    }
  }
}

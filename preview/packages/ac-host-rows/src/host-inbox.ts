// ============================================================
// host-inbox.ts —— host 端点收信扇出组合器（cr-545）
//
// 邮局 local 通道每端点单 receiver——usage 行首建时独占 'host'；后续
// 宿主收信行（auth-registry 等）经本组合器共存。语义：
//   · requestId 幂等时点 = 全部 handler 成功之后——失败重投重跑全部
//     handler（handler 须自持幂等：usage 行自持 seen、auth 行写面
//     幂等键去重）；
//   · 任一 handler 抛错 = 整体投递失败 → 邮局转发件箱滞留重试
//     （at-least-once 契约）；
//   · 非本域信静默直过（各 handler 自判 kind/payload）。
// ============================================================
import type { Envelope } from 'ac-envelope-core';

/** 邮局注册面（PostOffice 的结构子集——测试可替身） */
export interface LocalRegister {
  registerLocal(endpointId: string, receiver: (env: Envelope) => Promise<{ ack: string; fresh: boolean }>): void;
}

export class HostInbox {
  private readonly handlers: Array<(env: Envelope) => Promise<void>> = [];
  private readonly seen = new Set<string>();
  private readonly po: LocalRegister;

  constructor(po: LocalRegister) {
    this.po = po;
  }

  /** 起 host 端点收信面（boot 在邮局 listen 后调用一次） */
  start(): void {
    this.po.registerLocal('host', async (env: Envelope) => {
      if (this.seen.has(env.requestId)) return { ack: env.requestId, fresh: false };
      let firstErr: unknown;
      for (const handler of this.handlers) {
        try {
          await handler(env);
        } catch (err) {
          firstErr ??= err;
        }
      }
      if (firstErr !== undefined) throw firstErr;
      this.seen.add(env.requestId);
      return { ack: env.requestId, fresh: true };
    });
  }

  /** 注册收信 handler（行装配期——各 handler 自判域，非本域信直过） */
  on(handler: (env: Envelope) => Promise<void>): void {
    this.handlers.push(handler);
  }
}

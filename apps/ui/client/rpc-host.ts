// ============================================================
// rpc-host.ts —— preview ui 树 rpc 服务最小面（8.5b 第二批）
//
// 通道模块（conversation/settings 等域件）inject rpc 是公共依赖
//（对齐主线 main.ts rpcHostPlugin 在装配序列先于一切域件——传输基座）。
// wire 实现注入：测试桩直给 / main.ts 真面（/ws——8.5e 联调面接线）。
// 主线终态 = apps/ui/src/runtime/rpcClient.ts 平移进 ac-webui 单包
//（ui-tree §4 client/ 半边——cutover 时收编本文件）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext, type RpcClientFace } from 'ac-client-runtime';

/** wire 注入面（call/onEvent 家族——主线 wireRpc 单例语义的数据化） */
export interface RpcWire {
  call<T>(method: string, params?: unknown, requestId?: string, timeoutMs?: number): Promise<T>;
  onEvent(handler: (type: string, args: unknown[]) => void): () => void;
  onOpen(handler: () => void): () => void;
  onAck(handler: (ack: unknown) => void): () => void;
  onClose(handler: () => void): () => void;
  connected(): boolean;
}

export class RpcHostService extends Service {
  private readonly wire: RpcWire;

  constructor(ctx: Context, wire: RpcWire) {
    super(ctx, 'rpc');
    this.wire = wire;
  }

  call<T>(method: string, params?: unknown, requestId?: string, timeoutMs?: number): Promise<T> {
    return this.wire.call<T>(method, params, requestId, timeoutMs);
  }

  onEvent(handler: (type: string, args: unknown[]) => void): () => void {
    return this.wire.onEvent(handler);
  }

  onOpen(handler: () => void): () => void {
    return this.wire.onOpen(handler);
  }

  onAck(handler: (ack: unknown) => void): () => void {
    return this.wire.onAck(handler);
  }

  connected(): boolean {
    return this.wire.connected();
  }

  onClose(handler: () => void): () => void {
    return this.wire.onClose(handler);
  }
}

declare module 'ac-client-runtime' {
  interface ClientContext {
    /** 宿主 RPC 调用面（RpcHostService 实现 RpcClientFace） */
    rpc: RpcClientFace;
  }
}

/** rpc host 插件（boot 装配 ①.5——先于骨架域件与通道装载）；wire 经插件闭包传入构造 options */
export function makeRpcHostPlugin(wire: RpcWire) {
  const service = class extends RpcHostService {
    constructor(ctx: Context) {
      super(ctx, wire);
    }
  };
  return clientPlugin({
    name: 'ac-ui-app.rpc-host',
    async apply(ctx: ClientContext) {
      await ctx.plugin(service);
    },
  });
}
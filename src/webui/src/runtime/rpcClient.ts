// ============================================================
// webui/src/runtime/rpcClient.ts —— 宿主 RPC 服务（M27 S3/D7）
//
// ctx.rpc 实现：wireRpc 单例薄壳（ac-client-runtime 契约面
// RpcClientFace 的 webui 宿主实现——行 client 半边 inject 消费，
// 不 import webui 内部模块）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext, type RpcClientFace } from 'ac-client-runtime';
import { wireRpc } from '../api/wire';

export interface RpcClientHostOptions {
  /** 预留（对齐 cordis Service 构造签名形态） */
}

export class RpcClientHostService extends Service {
  constructor(ctx: Context, options: RpcClientHostOptions = {}) {
    super(ctx, 'rpc');
    void options;
  }

  call<T>(method: string, params?: unknown, requestId?: string, timeoutMs?: number): Promise<T> {
    return wireRpc.call<T>(method, params as Record<string, unknown> | undefined, requestId, timeoutMs);
  }

  /** 宿主事件帧直转（D20 运输前置——行 client 域投影刷新面） */
  onEvent(handler: (type: string, args: unknown[]) => void): () => void {
    return wireRpc.onWireEvent(handler);
  }

  /** 连接建立回调（M27.2-2：conversation 核心重连恢复链——RpcClientFace 可选面） */
  onOpen(handler: () => void): () => void {
    return wireRpc.onWireOpen(handler);
  }

  /** RPC ack 帧回调（M27.2-2：conversation 核心在途请求对账——RpcClientFace 可选面） */
  onAck(handler: (ack: unknown) => void): () => void {
    return wireRpc.onWireAck(handler);
  }

  /** 当前连接态（M27.2 conversation 视图半边：连接条初值——注册顺序竞态防线） */
  connected(): boolean {
    return wireRpc.connected;
  }

  /** 连接断开回调（与 onOpen 对偶——RpcClientFace 可选面） */
  onClose(handler: () => void): () => void {
    return wireRpc.onWireClose(handler);
  }
}

declare module 'ac-client-runtime' {
  interface ClientContext {
    /** 宿主 RPC 调用面（本服务实现 RpcClientFace） */
    rpc: RpcClientFace;
  }
}

/** 宿主 RPC 服务插件（装配序列第③步——先于 boot graph 装载的行 client） */
export const rpcHostPlugin = clientPlugin({
  name: 'webui-host-rpc',
  async apply(ctx: ClientContext) {
    await ctx.plugin(RpcClientHostService);
  },
});

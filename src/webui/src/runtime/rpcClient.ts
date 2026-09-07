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

  call<T>(method: string, params?: unknown): Promise<T> {
    return wireRpc.call<T>(method, params as Record<string, unknown> | undefined);
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

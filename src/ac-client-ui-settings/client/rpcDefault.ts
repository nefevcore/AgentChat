// ============================================================
// ac-client-ui-settings/client/rpcDefault.ts —— 缺省 rpc 锚
//
// 包内数据函数的 rpc 缺省（webui wireRpc 的包内等价物）：app 内 =
// clientRuntime 单例的 rpc 契约面（宿主 'rpc' 服务）；未装配（单测
// 孤立面）→ 拒绝桩（调用方 catch 归一）。api.ts 全函数签名
// `rpc = wireRpc` 以 `import { defaultRpc as wireRpc }` 别名复用——
// 零 body 改动随件迁。
// ============================================================
import { clientRuntime, type RpcClientFace } from 'ac-client-runtime';

function noRuntime(): Promise<never> {
  return Promise.reject(new Error('client runtime 未装配（settings 包内缺省 rpc）'));
}

export const defaultRpc: RpcClientFace = {
  call<T>(method: string, params?: unknown, requestId?: string, timeoutMs?: number): Promise<T> {
    const rpc = clientRuntime()?.rpc;
    if (!rpc) return noRuntime();
    return rpc.call<T>(method, params, requestId, timeoutMs);
  },
  onEvent(handler: (type: string, args: unknown[]) => void): () => void {
    return clientRuntime()?.rpc?.onEvent(handler) ?? (() => undefined);
  },
  onOpen(handler: () => void): () => void {
    return clientRuntime()?.rpc?.onOpen?.(handler) ?? (() => undefined);
  },
  onClose(handler: () => void): () => void {
    return clientRuntime()?.rpc?.onClose?.(handler) ?? (() => undefined);
  },
};

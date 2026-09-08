// ============================================================
// ac-client-ui-layout/client/rpcDefault.ts —— 缺省 rpc 锚
//（settings 包同款：clientRuntime 单例委托；未装配 → 拒绝桩）
// ============================================================
import { clientRuntime, type RpcClientFace } from 'ac-client-runtime';

function noRuntime(): Promise<never> {
  return Promise.reject(new Error('client runtime 未装配（layout 包内缺省 rpc）'));
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
};

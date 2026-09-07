// ============================================================
// webui/tests/lib/rpcStub.ts —— 测试用 rpc 服务桩（行 client 半边
// 装载前提：inject ['rpc'] 的数据面契约）
// ============================================================
import type { ClientContext } from 'ac-client-runtime';

export interface RpcStubCalls {
  seen: Array<[string, unknown?]>;
  emit(type: string, ...args: unknown[]): void;
}

/**
 * 提供 'rpc' 服务桩：call 记录并返回空对象（离线空态语义）；
 * onEvent 捕获订阅者——返回 emit() 注入宿主帧（事件驱动面测试口）。
 */
export async function stubRpc(ctx: ClientContext): Promise<RpcStubCalls> {
  const calls: RpcStubCalls['seen'] = [];
  const handlers: Array<(type: string, args: unknown[]) => void> = [];
  await ctx.plugin({
    name: 'test-rpc-stub',
    apply(c: ClientContext) {
      c.provide('rpc', {
        async call<T>(method: string, params?: unknown): Promise<T> {
          calls.push([method, params]);
          return {} as T;
        },
        onEvent(h: (type: string, args: unknown[]) => void): () => void {
          handlers.push(h);
          return () => {
            const i = handlers.indexOf(h);
            if (i >= 0) handlers.splice(i, 1);
          };
        },
      });
    },
  });
  return {
    seen: calls,
    emit(type: string, ...args: unknown[]): void {
      for (const h of [...handlers]) h(type, args);
    },
  };
}

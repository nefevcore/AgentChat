// ============================================================
// webui/src/runtime/wireFace.ts —— wireRpc → RpcClientFace 适配器
//（M27.2-2：conversation 核心等包内消费方经 ac-client-runtime 契约面
// 注入——方法名归一 onEvent/onOpen/onAck）
//
// 独立模块而非 api/wire 内导出的原因：feed/chat 测试族
// vi.mock('../src/api/wire') 的工厂只提供 wireRpc 面——本模块从
// 被替换的 wireRpc 【防御性】适配（缺方法 = noop disposer，单测
// 独立实例不走 wire 事件面——与旧行为等价）。
// ============================================================
import type { RpcClientFace } from 'ac-client-runtime';
import { wireRpc } from '../api/wire';

type WireLike = {
  call<T>(method: string, params?: Record<string, unknown>, requestId?: string, timeoutMs?: number): Promise<T>;
  onWireEvent?(h: (type: string, args: unknown[]) => void): () => void;
  onWireOpen?(h: () => void): () => void;
  onWireClose?(h: () => void): () => void;
  onWireAck?(h: (ack: { requestId: string; kind: string; info?: Record<string, unknown> }) => void): () => void;
  connected?: boolean;
};

const noop = (): void => undefined;
const wire = wireRpc as unknown as WireLike;

export const wireFace: RpcClientFace = {
  call: (method, params, requestId, timeoutMs) =>
    wire.call(method, params as Record<string, unknown> | undefined, requestId, timeoutMs),
  onEvent: (h) => (wire.onWireEvent ? wire.onWireEvent(h) : noop),
  onOpen: (h) => (wire.onWireOpen ? wire.onWireOpen(h) : noop),
  onClose: (h) => (wire.onWireClose ? wire.onWireClose(h) : noop),
  onAck: (h) => (wire.onWireAck ? wire.onWireAck(h) : noop),
  connected: () => wire.connected ?? true,
};

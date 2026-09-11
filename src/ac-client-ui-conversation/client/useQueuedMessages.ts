// ============================================================
// client/useQueuedMessages.ts —— 会话级 next-turn 排队状态（M27.2-2 视图半边自 webui composables/ 迁入；rpc 契约面参数化）
//
// DSH queue 姿势的 Port B 形态（对齐 useTaskTracking）：
//   · 活值经 conversation/queue RPC 拉取（会话切换 watch immediate）
//   · conversation/queue-changed 帧 = 服务端权威全量快照，直接套用
//     （不客户端推导；载荷 conversationId 命中本桶才收）
//   · 行级变更走 RPC：queue-remove（删除）/ queue-steer（插话——原子
//     转移到活跃 run 下一步；窗口已关返回 'requeued'，消息仍在队列）
// 后端不可达/行未装 → 拉取失败静默收敛为空（dock 隐藏）。
// ============================================================

import { ref, shallowRef, toValue, watch, onUnmounted, getCurrentInstance, type Ref, type ShallowRef, type WatchSource } from 'vue';
import { clientRuntime, useClientContext, type RpcClientFace } from 'ac-client-runtime';
import type { StoreSeat } from 'ac-client-slots';

/** 排队条目（conversation/queue-changed 载荷行；与后端 ConversationQueuedItem 同形） */
export interface QueuedMessage {
  id: string;
  preview: string;
  sender: string;
  source: string;
  queuedAt: number;
}

export interface QueuedMessages {
  /** 当前排队条目（顺序 = 投递顺序；空数组 = 无排队） */
  items: Ref<QueuedMessage[]>;
  /** 手动刷新（会话切换/帧触发之外的对账口） */
  refresh: () => Promise<void>;
  /** 删除一条排队消息（已消费条目静默 no-op——以权威快照为准） */
  remove: (id: string) => Promise<void>;
  /** 插话：把排队消息转移到活跃 run 下一步（DSH 严格 steering） */
  steer: (id: string) => Promise<'steered' | 'requeued' | 'not-found' | 'error'>;
  /** 退订 rpc 事件（组件上下文随卸载自动退订；轴实例经 dispose 调用） */
  off: () => void;
}

export function useQueuedMessages(
  agentId: Ref<string | null | undefined>,
  conversationId: Ref<string | null | undefined>,
  /** rpc 契约面（缺省取 clientRuntime 单例——app 内恒在场；测试可注入桩） */
  rpc: RpcClientFace | null = clientRuntime()?.rpc ?? null,
): QueuedMessages {
  const items = ref<QueuedMessage[]>([]);

  async function refresh(): Promise<void> {
    const a = agentId.value;
    const c = conversationId.value;
    if (!a || !c || !rpc) {
      items.value = [];
      return;
    }
    try {
      const r = await rpc.call<{ items?: QueuedMessage[] }>('conversation/queue', {
        agentId: a,
        conversationId: c,
      });
      // 拉取期间会话已切换 → 丢弃过期结果（防串台）
      if (agentId.value !== a || conversationId.value !== c) return;
      items.value = Array.isArray(r.items) ? r.items : [];
    } catch {
      if (agentId.value === a && conversationId.value === c) items.value = [];
    }
  }

  async function remove(id: string): Promise<void> {
    const a = agentId.value;
    const c = conversationId.value;
    if (!a || !c || !rpc) return;
    try {
      await rpc.call('conversation/queue-remove', { agentId: a, conversationId: c, id });
    } catch { /* 已消费/网络失败：权威快照对齐 */ }
    await refresh();
  }

  async function steer(id: string): Promise<'steered' | 'requeued' | 'not-found' | 'error'> {
    const a = agentId.value;
    const c = conversationId.value;
    if (!a || !c || !rpc) return 'error';
    try {
      const r = await rpc.call<{ outcome?: 'steered' | 'requeued' | 'not-found' }>(
        'conversation/queue-steer',
        { agentId: a, conversationId: c, id },
      );
      await refresh();
      return r.outcome ?? 'not-found';
    } catch {
      return 'error';
    }
  }

  watch([agentId, conversationId], () => void refresh(), { immediate: true });

  const off = rpc?.onEvent((type, args) => {
    if (type !== 'conversation/queue-changed') return;
    const c = conversationId.value;
    if (!c) return;
    // 载荷 (agentId, conversationId, handle, items)：按会话键（第 2 位）过滤
    const [, conv, , snapshot] = args as [string, string, string, QueuedMessage[] | undefined];
    if (conv !== c) return; // 他桶快照不收
    items.value = Array.isArray(snapshot) ? snapshot : [];
  }) ?? (() => undefined);
  // 组件作用域内随组件卸载退订；非组件上下文（测试/轴实例）由调用方管理
  if (getCurrentInstance()) onUnmounted(() => off());

  return { items, refresh, remove, steer, off };
}

// ------------------------------------------------------------
// store 座位实例轴（M28 §4.2）：排队 dock 的 per-conversation 核心
// 态——conversation:dock-widget 贡献 entry.store 工厂返回值。axis 键 =
// (slotKey × entryId 'queue' × scopeKey=conversationId)；引用计数
// 归零（切走会话）/ dropScope（会话死）即 dispose（退订 rpc 事件）。
// agentId 由取用方置位（per-scope 恒定：直答 = 对端，single = 会话
// 登记目标）；conversationId = scopeKey 固化。
// ------------------------------------------------------------

/** 排队 dock 轴上实例（entry.store 工厂产物；dispose 由轴回收链执行） */
export interface QueuedDockStore extends QueuedMessages {
  /** 目标 Agent（取用方置位——per-scope 恒定；置位触发首拉） */
  agentId: Ref<string | null>;
  /** 轴实例回收（引用归零/dropScope 时执行——退订 rpc 事件） */
  dispose(): void;
}

/** 轴上实例工厂（scopeKey = conversationId；rpc 缺省取 runtime 单例） */
export function createQueuedDockStore(
  scopeKey: string,
  rpc: RpcClientFace | null = clientRuntime()?.rpc ?? null,
): QueuedDockStore {
  const agentId = ref<string | null>(null);
  const conversationId = ref<string | null>(scopeKey);
  const core = useQueuedMessages(agentId, conversationId, rpc);
  let disposed = false;
  return {
    agentId,
    ...core,
    dispose() {
      if (disposed) return;
      disposed = true;
      core.off();
    },
  };
}

// ------------------------------------------------------------
// useQueueSeat —— 座位取用接线（ConversationView 与 QueueDockHost
// 两个取用方的并源单份）：会话键变化 → 释放旧座位/取新座位（引用计数
// 换发），组件卸载经 onCleanup 释放；agentId per-scope 恒定，取用时
// 置位一次（触发首拉），迟到经第二 watch 兜底（同值幂等写不触发
// 重复拉取）。无 runtime ctx（裸测试环境）→ 恒 null（空队列语义）。
// ------------------------------------------------------------

/**
 * 排队 dock 的轴上取用（同轴同实例：任意取用方经同一 scopeKey 拿到
 * 同一 store——计数/整队列插话与行级动作共享核心态）。
 *
 * @param conversationId 会话桶键源（scopeKey；null = 无归属 → 恒空）
 * @param agentId 目标 Agent 源（直答 = 对端 / single = 会话登记目标）
 * @returns 轴上实例（shallowRef 整值替换——避免深解包摊平 store 内 Refs）
 */
export function useQueueSeat(
  conversationId: WatchSource<string | null>,
  agentId: WatchSource<string | null>,
): Readonly<ShallowRef<QueuedDockStore | null>> {
  const slots = useClientContext()?.slots;
  const store = shallowRef<QueuedDockStore | null>(null);
  let seat: StoreSeat | null = null;
  watch(
    conversationId,
    (conv, prev, onCleanup) => {
      if (conv === prev) return;
      store.value = null;
      seat?.release();
      seat = null;
      if (!conv || !slots) return;
      seat = slots.acquireStore('conversation:dock-widget', 'queue', conv);
      const s = seat.value as QueuedDockStore;
      store.value = s;
      s.agentId.value = toValue(agentId); // per-scope 恒定；置位触发首拉
      onCleanup(() => {
        seat?.release();
        seat = null;
        store.value = null;
      });
    },
    { immediate: true },
  );
  // agentId 迟到兜底（per-scope 恒定——同值幂等写不触发重复拉取）
  watch(agentId, (a) => { if (store.value && a) store.value.agentId.value = a; });
  return store;
}

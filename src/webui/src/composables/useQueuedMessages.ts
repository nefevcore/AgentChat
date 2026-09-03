// ============================================================
// composables/useQueuedMessages.ts —— 会话级 next-turn 排队状态
//
// DSH queue 姿势的 Port B 形态（对齐 useTaskTracking）：
//   · 活值经 conversation/queue RPC 拉取（会话切换 watch immediate）
//   · conversation/queue-changed 帧 = 服务端权威全量快照，直接套用
//     （不客户端推导；载荷 conversationId 命中本桶才收）
//   · 行级变更走 RPC：queue-remove（删除）/ queue-steer（插话——原子
//     转移到活跃 run 下一步；窗口已关返回 'requeued'，消息仍在队列）
// 后端不可达/行未装 → 拉取失败静默收敛为空（dock 隐藏）。
// ============================================================

import { ref, watch, onUnmounted, getCurrentInstance, type Ref } from 'vue';
import { wireRpc } from '../api/wire.ts';

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
}

export function useQueuedMessages(
  agentId: Ref<string | null | undefined>,
  conversationId: Ref<string | null | undefined>,
): QueuedMessages {
  const items = ref<QueuedMessage[]>([]);

  async function refresh(): Promise<void> {
    const a = agentId.value;
    const c = conversationId.value;
    if (!a || !c) {
      items.value = [];
      return;
    }
    try {
      const r = await wireRpc.call<{ items?: QueuedMessage[] }>('conversation/queue', {
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
    if (!a || !c) return;
    try {
      await wireRpc.call('conversation/queue-remove', { agentId: a, conversationId: c, id });
    } catch { /* 已消费/网络失败：权威快照对齐 */ }
    await refresh();
  }

  async function steer(id: string): Promise<'steered' | 'requeued' | 'not-found' | 'error'> {
    const a = agentId.value;
    const c = conversationId.value;
    if (!a || !c) return 'error';
    try {
      const r = await wireRpc.call<{ outcome?: 'steered' | 'requeued' | 'not-found' }>(
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

  const off = wireRpc.onWireEvent((type, args) => {
    if (type !== 'conversation/queue-changed') return;
    const c = conversationId.value;
    if (!c) return;
    // 载荷 (agentId, conversationId, handle, items)：按会话键（第 2 位）过滤
    const [, conv, , snapshot] = args as [string, string, string, QueuedMessage[] | undefined];
    if (conv !== c) return; // 他桶快照不收
    items.value = Array.isArray(snapshot) ? snapshot : [];
  });
  // 组件作用域内随组件卸载退订；非组件上下文（测试）由调用方自行管理
  if (getCurrentInstance()) onUnmounted(() => off());

  return { items, refresh, remove, steer };
}

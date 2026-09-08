<!-- QueueDockHost.vue —— 排队 dock 贡献容器（tracking:dock-widget entry 'queue'）
  M28 §4.2（注记 0b）：排队状态从 DialogView 本地 composable 迁 store 座位
  实例轴——per-conversation 实例（slots.acquireStore × scopeKey=conversationId，
  引用归零即 dispose 退订）；本容器 = 贡献半边（data props = 席位 owner
  透传的会话归属），DialogView = 另一取用方（ChatInput 计数/整队列插话），
  同轴同实例。QueueDock 保持纯展示；行级动作（steer 补气泡 / remove 回退
  排队登记）在此编排——与旧 DialogView 内联实现同款语义。 -->
<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import type { StoreSeat } from 'ac-client-slots';
import { useClientContext } from 'ac-client-runtime';
import { useChatStore } from './chatStore.ts';
import { useFeedStore } from './feedStore.ts';
import QueueDock from './QueueDock.vue';
import { createQueuedDockStore, type QueuedDockStore, type QueuedMessage } from './useQueuedMessages.ts';
import { directDialog, singleDialog, splitAttachmentLines } from './feed.ts';

const props = defineProps<{
  /** 席位 owner 透传（TaskDock data）：会话桶归属 */
  data: { agentId?: string | null; conversationId?: string | null };
}>();

const chatStore = useChatStore();
const feed = useFeedStore();
const slots = useClientContext()?.slots;

/** 当前会话的轴上实例（scopeKey = conversationId；引用随会话切换换发。
 *  shallowRef：整值替换驱动渲染，避免深解包类型摊平 store 内 Refs） */
const store = shallowRef<QueuedDockStore | null>(null);
let seat: StoreSeat | null = null;
watch(
  () => props.data.conversationId ?? null,
  (conv, prev, onCleanup) => {
    if (conv === prev) return;
    store.value = null;
    seat?.release();
    seat = null;
    if (!conv || !slots) return;
    seat = slots.acquireStore('tracking:dock-widget', 'queue', conv);
    const s = seat.value as QueuedDockStore;
    store.value = s;
    s.agentId.value = props.data.agentId ?? null; // per-scope 恒定；置位触发首拉
    onCleanup(() => {
      seat?.release();
      seat = null;
      store.value = null;
    });
  },
  { immediate: true },
);

/** agentId 迟到兜底（per-scope 恒定——同值幂等写不触发重复拉取） */
watch(
  () => props.data.agentId ?? null,
  (a) => { if (store.value && a) store.value.agentId.value = a; },
);

/** 排队条目归属分区（直答 = direct(agent)；single = single(sid)） */
const dialogId = computed(() => {
  const conv = props.data.conversationId;
  if (!conv) return null;
  return conv.includes('~') ? directDialog(props.data.agentId ?? '') : singleDialog(conv);
});

/** 行级插话（⚡ 立即发送）：转移到活跃 run 下一步；'requeued' = 窗口刚关
 *  的收敛竞态——条目留队正常投递，不报失败（DSH 语义） */
async function steerQueuedItem(item: QueuedMessage) {
  const s = store.value;
  if (!s) return;
  if (await s.steer(item.id) === 'steered') chatStore.appendOwnSteered(item.preview);
}

async function removeQueuedItem(id: string) {
  const s = store.value;
  if (!s) return;
  // 条目删除 = 消费回显不再到来——回退排队发送登记（防同文后续回显
  // 经登记命中误补重复气泡）
  const item = s.items.value.find((q) => q.id === id);
  if (item && dialogId.value) {
    feed.dropQueuedSend(dialogId.value, splitAttachmentLines(item.preview).content);
  }
  await s.remove(id);
}
</script>

<template>
  <QueueDock
    :items="store?.items.value ?? []"
    :busy="chatStore.contextBusy"
    :on-steer="steerQueuedItem"
    :on-remove="removeQueuedItem"
  />
</template>

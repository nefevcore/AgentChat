<!-- QueueDockHost.vue —— 排队 dock 贡献容器（conversation:dock-widget entry 'queue'）
  M28 §4.2（注记 0b）：排队状态从视图本地 composable 迁 store 座位
  实例轴——per-conversation 实例（slots.acquireStore × scopeKey=conversationId，
  引用归零即 dispose 退订）；本容器 = 贡献半边（data props = 席位 owner
  透传的会话归属），ConversationView = 另一取用方（ChatInput 计数/整队列插话），
  同轴同实例。QueueDock 保持纯展示；行级动作（steer 补气泡 / remove 回退
  排队登记）在此编排——与旧内联实现同款语义。 -->
<script setup lang="ts">
import { computed } from 'vue';
import { useChatStore } from './chatStore.ts';
import { useFeedStore } from './feedStore.ts';
import QueueDock from './QueueDock.vue';
import { useQueueSeat, type QueuedMessage } from './useQueuedMessages.ts';
import { directDialog, singleDialog, splitAttachmentLines } from './feed.ts';

const props = defineProps<{
  /** 席位 owner 透传（ComposerDock data）：会话桶归属 */
  data: { agentId?: string | null; conversationId?: string | null };
}>();

const chatStore = useChatStore();
const feed = useFeedStore();

/** 当前会话的轴上实例（useQueueSeat 并源接线——与 ConversationView 同轴同实例） */
const store = useQueueSeat(
  () => props.data.conversationId ?? null,
  () => props.data.agentId ?? null,
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

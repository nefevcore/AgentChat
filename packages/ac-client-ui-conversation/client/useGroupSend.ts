// ============================================================
// client/useGroupSend.ts —— 群聊发送路径（group 形态专用）
//（conversation-view-split-plan ④：自 ConversationView 迁入——RPC group/send
//  + 发送锁（10s 兜底解锁）。direct/single 走 ChatInput 默认 store.sendMessage，
//  pair 只读无输入，本路径仅服务群形态。）
// ============================================================

import { ref, onUnmounted, type Ref } from 'vue';
import { VIEWER_ID } from './viewer.ts';
import { useChatStore } from './chatStore.ts';
import { useClientContext } from 'ac-client-runtime';
import type { FileAttachment } from './types.ts';
import type { ConversationViewProps } from './useConversationIdentity.ts';
import type { TranscriptListHandle } from './useConversationHistory.ts';

export function useGroupSend(
  props: ConversationViewProps,
  transcript: Ref<TranscriptListHandle | undefined>,
) {
  const chatStore = useChatStore();
  // rpc 契约面（宿主 'rpc' 服务——wireRpc 薄壳；群发经此）
  const rpc = useClientContext()?.rpc ?? null;

  const groupTurnInProgress = ref(false);
  let groupSendTimer: ReturnType<typeof setTimeout> | null = null;

  function sendGroupMessage(content: string, files?: FileAttachment[]) {
    if (!props.group || (!content.trim() && !files?.length) || !rpc) return;
    groupTurnInProgress.value = true;
    transcript.value?.scrollToBottom();
    // 群聊附件（M4）：文本行合成 + 图片引用旁挂（与直答路径同构——
    // chat store 的 composeContent/imageAttachmentsOf 单源复用）
    const composed = chatStore.composeContent(content, files);
    const attachments = chatStore.imageAttachmentsOf(files);
    // Port B：group/send 受理（rpc result）即解锁；失败同样解锁（10s 兜底保留）
    void rpc.call('group/send', {
      groupId: props.group.group_id,
      from: VIEWER_ID.value,
      content: composed,
      ...(attachments ? { attachments } : {}),
    })
      .then(() => resetGroupTurn())
      .catch(() => resetGroupTurn());
    // 兜底：投递确认/异常未及时到达时，10s 后也解除发送锁（Agent 回复本身经 group/message-posted 事件异步送达）
    if (groupSendTimer) clearTimeout(groupSendTimer);
    groupSendTimer = setTimeout(() => { groupTurnInProgress.value = false; }, 10_000);
  }

  function resetGroupTurn(groupId?: string) {
    if (groupId && props.group?.group_id !== groupId) return;
    groupTurnInProgress.value = false;
    if (groupSendTimer) { clearTimeout(groupSendTimer); groupSendTimer = null; }
  }
  onUnmounted(() => {
    // 发送锁兜底定时器清理（切视角卸载后仍会触发并操作已卸载实例）
    if (groupSendTimer) { clearTimeout(groupSendTimer); groupSendTimer = null; }
  });

  return { groupTurnInProgress, sendGroupMessage };
}
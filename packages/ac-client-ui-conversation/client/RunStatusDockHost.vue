<!-- RunStatusDockHost.vue —— 会话状态 dock 贡献容器（conversation:dock-widget
  entry 'run-status'，cr-744）
  发起会话到前端首输出之间的静默空窗可视化。推导逻辑住 runStatus.ts
  纯函数层；本组件 = 分区路由 + 权威对账轮询 + 纯展示卡。
  权威对账（cr-756）：本地帧点亮（即时性——boot 冷启动窗口只有它知道）+
  conversation/stats 判死（可靠性——shell 内存 ConversationMachine 直读，
  cr-748 shellStatePoller 缓存加速）。活跃期 2s 轮询，空闲停。 -->
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import RunStatusDock from './RunStatusDock.vue';
import { useChatStore } from './chatStore.ts';
import { useFeedStore } from './feedStore.ts';
import { directDialog, singleDialog, type DialogId } from './feed.ts';
import { deriveRunStatus } from './runStatus.ts';

const props = defineProps<{
  /** 席位 owner 透传（ComposerDock data）：会话桶归属 */
  data: { agentId?: string | null; conversationId?: string | null };
}>();

const chatStore = useChatStore();
const feed = useFeedStore();

const dialogId = computed<DialogId | null>(() => {
  const conv = props.data.conversationId;
  if (!conv) return null;
  return conv.includes('~') ? directDialog(props.data.agentId ?? '') : singleDialog(conv);
});

// ── 权威对账轮询（cr-756）：活跃期 2s 拉 conversation/stats，写
//    feed.authoritativeRuns——deriveRunStatus 据此判死（本地帧残留 +
//    权威 miss + 静默超窗 = 死行收束）。空闲停轮询。 ──
let pollTimer: ReturnType<typeof setInterval> | null = null;
const lastPoll = ref(0);

async function pollAuthoritative() {
  const id = dialogId.value;
  if (!id) return;
  lastPoll.value = Date.now();
  try {
    const stats = await feed.rpc.call<{ running?: Array<{ agentId: string; conversationId: string }> }>('conversation/stats');
    const { kind, key } = parseId(id);
    const conv = kind === 'single' ? key : key.split('|').join('~');
    const agent = props.data.agentId ?? '';
    const active = (stats.running ?? []).some((r) => r.agentId === agent && r.conversationId === conv);
    feed.authoritativeRuns[id] = active;
    // 权威判死联动消息行（cr-763）：权威 miss 且状态卡已按「静默超窗」判
    // hidden（deriveRunStatus 组合判据）→ 分区死行，运行态残留一并收口
    //（此前只收状态卡——「状态条消失、工具卡还在转」的割裂形态）。
    if (!active && status.value.kind === 'hidden') feed.settleDeadDialog(id);
  } catch {
    // RPC 失败不定罪（后端不可达与死行不可区分——悬挂探针同口径）
  }
}

function parseId(id: DialogId): { kind: string; key: string } {
  const sep = id.indexOf(':');
  return { kind: id.slice(0, sep), key: id.slice(sep + 1) };
}

const status = computed(() => {
  const d = feed.getDialog(dialogId.value ?? ('' as DialogId));
  // 响应式依赖锚（cr-749）：流式写入部分经非 reactive 载体 Map——
  // bump 每帧经代理更新 lastStreamAt，读它挂上「每帧必变」的依赖；
  // 轮询写 authoritativeRuns 同为代理触发（cr-756）
  void d?.lastStreamAt;
  void feed.authoritativeRuns[dialogId.value ?? ('' as DialogId)];
  void lastPoll.value;
  const s = deriveRunStatus(d, chatStore.busyFeedback, chatStore.busyTone,
    feed.authoritativeRuns[dialogId.value ?? ('' as DialogId)]);
  // 诊断日志（cr-756 subcall 排查临时）：状态 + 关键判据面——console 抓真实链路
  if (s.kind !== 'hidden') {
    const dd = d as any;
    const carrier = dd?.rawMessages?.filter?.((m: any) => m.role === 'agent' && m.isStreaming).at(-1);
    const streamingToolRows = dd?.rawMessages?.filter?.((m: any) => m.role === 'tool' && m.isStreaming).length ?? 0;
    const runningTcs = dd?.rawMessages?.filter?.((m: any) => m.role === 'agent')
      .flatMap((m: any) => m.toolCalls ?? []).filter((t: any) => t?.running === true).length ?? 0;
    console.log('[run-status]', s.kind, {
      streaming: dd?.streaming, runStartAt: dd?.runStartAt != null,
      carrier: carrier ? { contentLen: (carrier.content || '').length, thinkLen: (carrier.thinking || carrier.reasoning_content || '').length, tc: (carrier.toolCalls ?? []).length } : null,
      streamingToolRows, runningTcs,
      auth: feed.authoritativeRuns[dialogId.value ?? ('' as DialogId)],
    });
  }
  return s;
});

// 活跃期轮询：状态卡可见（非 hidden）时 2s 对账，空闲停
watch(() => status.value.kind !== 'hidden', (active) => {
  if (active && !pollTimer) {
    void pollAuthoritative();
    pollTimer = setInterval(() => void pollAuthoritative(), 2000);
  } else if (!active && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}, { immediate: true });
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); });
</script>

<template>
  <RunStatusDock :status="status" />
</template>
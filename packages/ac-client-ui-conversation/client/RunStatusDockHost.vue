<!-- RunStatusDockHost.vue —— 会话状态 dock 贡献容器（conversation:dock-widget
  entry 'run-status'，cr-744）
  发起会话到前端首输出之间的静默空窗可视化。推导逻辑住 runStatus.ts
  纯函数层；本组件 = 分区路由 + 权威对账轮询 + 纯展示卡。
  权威对账（cr-756）：本地帧点亮（即时性——boot 冷启动窗口只有它知道）+
  conversation/stats 判死（可靠性——shell 内存 ConversationMachine 直读，
  cr-748 shellStatePoller 缓存加速）。活跃期 2s 轮询，空闲停。
  waking 细分（cr-840）：wire 断开 → connecting（本地态，onOpen/onClose
  维护）；stats 的 spawning 集（宿主编排面 inflight 拉壳窗）含目标 agent
  → spawning。两信号缺省按无——旧后端/桩环境不细分，行为同前。 -->
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
//    权威 miss + 静默超窗 = 死行收束）。空闲停轮询。
//    同拍顺带回填 spawning 集（cr-840）：宿主编排面正在拉起的壳——
//    无新 RPC、无新轮询节奏，一次往返带两份对账数据。 ──
let pollTimer: ReturnType<typeof setInterval> | null = null;
const lastPoll = ref(0);
/** 宿主正在拉壳的 agent 集（最近成功一拍；RPC 失败不更新——观测失败≠没在拉） */
const spawningAgents = ref<ReadonlySet<string>>(new Set());

async function pollAuthoritative() {
  const id = dialogId.value;
  if (!id) return;
  lastPoll.value = Date.now();
  try {
    const stats = await feed.rpc.call<{ running?: Array<{ agentId: string; conversationId: string }>; spawning?: string[] }>('conversation/stats');
    const { kind, key } = parseId(id);
    const conv = kind === 'single' ? key : key.split('|').join('~');
    const agent = props.data.agentId ?? '';
    const active = (stats.running ?? []).some((r) => r.agentId === agent && r.conversationId === conv);
    feed.authoritativeRuns[id] = active;
    spawningAgents.value = new Set(Array.isArray(stats.spawning) ? stats.spawning : []);
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

// ── wire 连接态（cr-840 connecting 相位）：AppFrame 同款三件套（初值取
//    现态 + onOpen/onClose 维护——桩缺省按已连处理，离线桩不误显断连）。 ──
const wireConnected = ref(feed.rpc.connected?.() ?? true);
const offOpen = feed.rpc.onOpen?.(() => { wireConnected.value = true; }) ?? (() => undefined);
const offClose = feed.rpc.onClose?.(() => { wireConnected.value = false; }) ?? (() => undefined);

const status = computed(() => {
  const d = feed.getDialog(dialogId.value ?? ('' as DialogId));
  // 响应式依赖锚（cr-749）：流式写入部分经非 reactive 载体 Map——
  // bump 每帧经代理更新 lastStreamAt，读它挂上「每帧必变」的依赖；
  // 轮询写 authoritativeRuns 同为代理触发（cr-756）
  void d?.lastStreamAt;
  void feed.authoritativeRuns[dialogId.value ?? ('' as DialogId)];
  void lastPoll.value;
  const s = deriveRunStatus(d, chatStore.busyFeedback, chatStore.busyTone,
    feed.authoritativeRuns[dialogId.value ?? ('' as DialogId)],
    Date.now(),
    {
      wireConnected: wireConnected.value,
      targetAgent: props.data.agentId ?? undefined,
      spawningAgents: spawningAgents.value,
    });
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
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  offOpen();
  offClose();
});
</script>

<template>
  <RunStatusDock :status="status" />
</template>
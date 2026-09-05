<!-- TurnDisplayItem.vue — 统一对话轮次 -->
<!-- 右 = settingsAgentId 的消息；左 = 其他 -->

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useChatStore } from '@/stores/chat';
import { useAgentStore } from '@/stores/agents';
import { useUiStore } from '@/stores/ui';
import { VIEWER_ID } from '@/constants';
import AssistantMessage from './AssistantMessage.vue';
import ToolMessage from './ToolMessage.vue';
import UserMessage from './UserMessage.vue';
import { resolveMessageView, resolveMessageViewRenderer } from '@/core/registry/messageViews';
import { Avatar } from '@/ui';
import ThinkingIcon from '@/ui/ThinkingIcon.vue';
import type { Turn, ChatMessage } from '@/types';

const props = defineProps<{
  turn: Turn; index: number; settingsAgentId: string; showActions?: boolean;
  /** 延续轮：前面仅隔插播 event 的同 agent 轮（run 被 event 分隔切开）——
   *  不再重复头像/名称，内容列对齐原块，读作同一 run 的连续片段 */
  continuation?: boolean;
}>();

const emit = defineEmits<{
  regenerate: [msgId: string];
  deleteMessage: [msgId: string];
  edit: [msgId: string, newContent: string];
  continueGeneration: [];
  previewFile: [payload: { filePath: string; agentId?: string }];
}>();

const chatStore = useChatStore();
const agentStore = useAgentStore();
const ui = useUiStore();

const isSelf = computed(() => props.turn.agent_id === props.settingsAgentId);
const finalMsg = computed<ChatMessage | null>(() => props.turn.final);

/** 纯文本轮（无链）渲染消息：收束后 = final；loop 中 final 悬置（强生命
 *  周期）→ 渲染流式尾步消息（step 即消息本体，位置与收束后一致） */
const plainMsg = computed<ChatMessage | null>(() =>
  finalMsg.value ?? (props.turn.steps.at(-1)?.assistant ?? null));

/** final 消息视图（由 messageViews 注册表解析） */
const finalViewId = computed(() => resolveMessageView(props.turn, finalMsg.value));

/** 插件注册的 final 消息渲染器（message-view slot）；内置 user/assistant 返回 null 走内建分支 */
const finalRenderer = computed(() => {
  const id = finalViewId.value;
  return id ? resolveMessageViewRenderer(id) : null;
});

const meaningfulSteps = computed(() =>
  props.turn.steps.filter(s =>
    (s.assistant.thinking || s.assistant.reasoning_content || '').trim()
    || s.tools.length > 0
  )
);

// ── 思维链全局可见性（会话头部 switch）：关闭时链体（思考文本/工具卡）不
//    渲染，但保留 chain-header 摘要（步数/耗时）+ 流式 dots——隐藏模式下
//    header 是唯一的活动指示（Agent 正在思考/工作）。 ──
const visibleSteps = computed(() => (ui.showThinking ? meaningfulSteps.value : []));

const hasChain = computed(() => visibleSteps.value.length > 0);

const stepCount = computed(() => meaningfulSteps.value.length);

/** 耗时格式：45s / 12m34s / 1h2m5s（时/分为 0 的前导单位隐藏，
 *  数字均不补零——99h59m59s 形态） */
function fmtElapsed(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h${m}m${ss}s`;
  if (m > 0) return `${m}m${ss}s`;
  return `${ss}s`;
}

const chainLabel = computed(() => {
  // 摘要按真实步骤口径（meaningfulSteps）：隐藏模式链体不渲染，但 header
  // 摘要仍须呈现真实步数/耗时（visibleSteps 在隐藏模式下为空）
  const steps = meaningfulSteps.value;
  const cnt = steps.length;
  const first = steps[0];
  const last = steps[cnt - 1];
  const firstTs = first?.assistant?.timestamp ?? first?.tools?.[0]?.timestamp ?? 0;
  const lastTs = last?.assistant?.timestamp ?? last?.tools?.at(-1)?.timestamp ?? 0;
  let elapsed = firstTs && lastTs ? Math.max(0, Math.round((lastTs - firstTs) / 1000)) : 0;
  // 时间戳推导为 0 时，从各 step 的 label（如 "已思考（用时 12 秒）"）中累加
  if (elapsed === 0 && cnt > 0) {
    for (const s of steps) {
      const m = ((s.assistant as any).label || '').match(/用时\s*([\d.]+)\s*秒/);
      if (m) elapsed += parseFloat(m[1]);
    }
  }
  // 形态：思考过程 | X 步 | 用时 99h59m59s（耗时未知时省略末段）
  const parts = [`思考过程 | ${cnt} 步`];
  if (elapsed > 0) parts.push(`用时 ${fmtElapsed(elapsed)}`);
  return parts.join(' | ');
});

const canEdit = computed(() => props.turn.agent_id === VIEWER_ID.value);

/** 重新推理/删除门控：assistant 轮同样允许（此前绑定 isSelf——settingsAgentId
 *  固定为 VIEWER，assistant 轮恒 false → 按钮渲染了但点击永不触发）。
 *  仅排除 system 分隔轮与流式进行中的轮。 */
const canRegenerate = computed(() => props.turn.agent_id !== 'system' && !isStreaming.value);

const senderAvatar = computed(() => {
  const aid = props.turn.agent_id;
  return aid ? agentStore.getAgentAvatar(aid) || `/api/agents/${encodeURIComponent(aid)}/avatar` : null;
});
const senderName = computed(() => {
  const aid = props.turn.agent_id;
  if (!aid) return undefined;
  return agentStore.getAgentName(aid) || aid;
});

const isStreaming = computed(() => props.turn.steps.some(s => s.isStreaming));

/** 思维链隐藏模式：轮内确有链活动（思考/工具步被隐藏）→ 保留 chain-header
 *  摘要 + 流式 dots（活动指示），正文只呈现 final（中间口述不渲染） */
const hiddenChainMode = computed(() => !ui.showThinking && meaningfulSteps.value.length > 0);

/** 纯文本轮 loop 中的尾步流式态（分块渲染路径 + typing indicator）。
 *  final 强生命周期下收束物化时恒非流式——链轮/隐藏轮的流式渲染由
 *  步级 AssistantMessage 的 is-streaming 承担（见模板） */
const finalIsStreaming = computed(() => !hasChain.value && isStreaming.value && !finalMsg.value);
const isExpanded = ref(chatStore.turnInProgress);
const wasStreaming = ref(false);
// 流式过程中保持展开，不随单步结束逐个折叠（避免展开→折叠→展开的闪烁）
// immediate：组件在流式中创建时 isStreaming 初始即为 true，需立即标记 wasStreaming
watch(isStreaming, (v) => {
  if (v) {
    wasStreaming.value = true;
    isExpanded.value = true;
  }
}, { immediate: true });
// 会话整体结束时一次性折叠所有思维链（仅折叠本次会话经历流式的 turn，
// 不影响历史 turn 和用户手动展开的）
watch(() => chatStore.turnInProgress, (v) => {
  if (!v && wasStreaming.value) {
    wasStreaming.value = false;
    isExpanded.value = false;
  }
});


function isThinkingStreamingNow(sIdx: number) {
  if (!isStreaming.value || sIdx !== visibleSteps.value.length - 1) return false;
  return !visibleSteps.value[sIdx].assistant.content?.trim();
}
function toggleExpand() { isExpanded.value = !isExpanded.value; }

/** 折叠栏内步骤的稳定 key（step 身份 = assistant 消息 id + 时间戳）：
 *  外层 turn key 已稳定，此处若沿用数组下标，工具结果前插/步骤重建时
 *  仍会整组重挂载（工具卡片展开态丢失）。 */
function stepKey(step: { assistant: { id: string; timestamp: number } }, sIdx: number): string {
  const a = step.assistant;
  return a.id ? `step-${a.id}` : `step-idx-${a.timestamp}-${sIdx}`;
}
</script>

<template>
  <div class="turn-item" :class="isSelf ? 'turn-right' : 'turn-left'">

    <!-- ═══ 纯文本（思维链隐藏模式除外——另有专属分支）。final 强生命周期：
         loop 中悬置 → 渲染流式尾步（与收束后 final 同位）；收束后 → final ═══ -->
    <template v-if="!hasChain && !hiddenChainMode && plainMsg">
      <!-- 插件 message-view 渲染器优先（仅收束后；内置 user/assistant 无 renderer） -->
      <div v-if="finalRenderer && finalMsg" class="turn-bubble" :class="[isSelf ? 'turn-bubble-right' : 'turn-bubble-left', { 'is-cont': continuation }]">
        <component :is="finalRenderer" :turn="turn" :final="finalMsg" />
      </div>
      <div v-else-if="finalViewId === 'user' && finalMsg" class="turn-bubble turn-bubble-right">
        <UserMessage
          :message="finalMsg" :index="index"
          :sender-avatar="senderAvatar" :sender-name="senderName"
          @edit="canEdit ? (id: any, c: any) => emit('edit', id, c) : undefined"
          @preview-file="(fp: string) => emit('previewFile', { filePath: fp, agentId: props.turn.agent_id })"
        />
      </div>
      <div v-else class="turn-bubble turn-bubble-left" :class="{ 'is-cont': continuation }">
        <AssistantMessage
          :message="plainMsg" :index="index" :is-streaming="finalIsStreaming"
          :sender-avatar="continuation ? null : senderAvatar" :sender-name="continuation ? undefined : senderName"
          :show-actions="showActions"
          @preview-file="(fp: string) => emit('previewFile', { filePath: fp, agentId: props.turn.agent_id })"
          @regenerate="finalMsg && canRegenerate && showActions ? emit('regenerate', finalMsg.id) : undefined"
          @delete-message="finalMsg && canRegenerate && showActions ? emit('deleteMessage', finalMsg.id) : undefined"
        />
      </div>
    </template>

    <!-- ═══ 含折叠栏 ═══ -->
    <template v-if="hasChain">
      <div class="turn-chain-row" :class="{ 'is-cont': continuation }">
        <!-- 左侧头像（延续轮不重复） -->
        <div v-if="!isSelf && senderAvatar && !continuation" class="turn-avatar">
          <Avatar :src="senderAvatar" :name="senderName" :size="32" />
        </div>
        <!-- 右侧列：名称 → 思维链 → 最终回复 -->
        <div class="turn-chain-col">
          <div v-if="!isSelf && senderName && !continuation" class="turn-sender-name">{{ senderName }}</div>

          <div class="chain-header" :class="{ 'chain-streaming': isStreaming, expanded: isExpanded }" @click="toggleExpand">
            <ThinkingIcon :size="14" class="chain-icon" />
            <span class="chain-label">{{ chainLabel }}</span>
        <span v-if="isStreaming" class="streaming-dots">
          <span class="dot" /><span class="dot" /><span class="dot" />
        </span>
        <svg class="collapse-chevron" :class="{ expanded: isExpanded }"
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m9 18 6-6-6-6"/>
        </svg>
      </div>

      <div v-show="isExpanded" class="chain-body">
        <template v-for="(step, sIdx) in visibleSteps" :key="stepKey(step, sIdx)">
          <AssistantMessage
            :message="{ ...step.assistant, content: '', toolCalls: [] }" :index="index + sIdx"
            :is-streaming="isThinkingStreamingNow(sIdx)" :show-copy="false" compact
            @preview-file="(fp: string) => emit('previewFile', { filePath: fp, agentId: props.turn.agent_id })"
          />
          <ToolMessage
            v-for="(tool, tIdx) in step.tools" :key="`${stepKey(step, sIdx)}-tool-${tool.tool_call_id ?? tIdx}`"
            :message="tool" :index="index + sIdx + tIdx + 1"
          />
          <div v-if="step.assistant.content?.trim() && step.assistant.content !== finalMsg?.content" class="chain-step-content">
            <!-- 修复：正文展示以「是否等于 final 气泡正文」为准，而非「是否最后一条 meaningful step」。
                 当 entry 末尾有纯文本消息（如 send_agent 投递）时，最后一条 meaningful step 的正文
                 既不是 final（final=末尾纯文本），也不应被吞掉，需在此展示。
                 loop 中 final 悬置（null）→ 流式正文在链内原位渲染（is-streaming 走分块路径）；
                 收束物化后与 final 同正文的步由此去重 -->
            <AssistantMessage
              :message="{ ...step.assistant, thinking: '', reasoning_content: '', toolCalls: [] }"
              :index="index + sIdx" :show-copy="false" compact
              :is-streaming="!!step.isStreaming"
              @preview-file="(fp: string) => emit('previewFile', { filePath: fp, agentId: props.turn.agent_id })"
            />
          </div>
        </template>
      </div>

          <!-- 空 final（仅以工具调用收尾、无正文）不渲染：空 turn-bubble 会在
               turn-chain-col 的 flex gap 中多出一段空隙（与链内空壳消息同源）；
               插件 message-view renderer 除外（可能渲染自定义卡片） -->
          <div v-if="finalMsg && (finalRenderer || finalMsg.content?.trim())" :class="isSelf ? 'turn-bubble turn-bubble-right' : 'turn-bubble turn-bubble-left'">
            <component v-if="finalRenderer" :is="finalRenderer" :turn="turn" :final="finalMsg" />
            <AssistantMessage
              v-else
              :message="finalMsg" :index="index + stepCount" :is-streaming="finalIsStreaming"
              :show-actions="showActions"
              @preview-file="(fp: string) => emit('previewFile', { filePath: fp, agentId: props.turn.agent_id })"
              @regenerate="canRegenerate && showActions ? emit('regenerate', finalMsg.id) : undefined"
              @delete-message="canRegenerate && showActions ? emit('deleteMessage', finalMsg.id) : undefined"
            />
          </div>
        </div>
      </div>
    </template>

    <!-- ═══ 思维链隐藏：链体（思考/工具/中间口述）一律不渲染，仅保留
         chain-header 摘要（步数/耗时）+ 流式 dots 作活动指示，正文只呈现
         final（loop 中悬置 → 只有 header + dots；收束物化 → final 气泡）═══ -->
    <div v-if="hiddenChainMode" class="turn-chain-row" :class="{ 'is-cont': continuation }">
      <div v-if="!isSelf && senderAvatar && !continuation" class="turn-avatar">
        <Avatar :src="senderAvatar" :name="senderName" :size="32" />
      </div>
      <div class="turn-chain-col">
        <div v-if="!isSelf && senderName && !continuation" class="turn-sender-name">{{ senderName }}</div>
        <div class="chain-header is-static" :class="{ 'chain-streaming': isStreaming }">
          <ThinkingIcon :size="14" class="chain-icon" />
          <span class="chain-label">{{ chainLabel }}</span>
          <span v-if="isStreaming" class="streaming-dots">
            <span class="dot" /><span class="dot" /><span class="dot" />
          </span>
        </div>
        <div v-if="finalMsg && (finalRenderer || finalMsg.content?.trim())" :class="isSelf ? 'turn-bubble turn-bubble-right' : 'turn-bubble turn-bubble-left'">
          <component v-if="finalRenderer" :is="finalRenderer" :turn="turn" :final="finalMsg" />
          <AssistantMessage
            v-else
            :message="finalMsg" :index="index + stepCount" :is-streaming="finalIsStreaming"
            :show-actions="showActions"
            @preview-file="(fp: string) => emit('previewFile', { filePath: fp, agentId: props.turn.agent_id })"
            @regenerate="canRegenerate && showActions ? emit('regenerate', finalMsg.id) : undefined"
            @delete-message="canRegenerate && showActions ? emit('deleteMessage', finalMsg.id) : undefined"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.turn-item { display: flex; flex-direction: column; gap: 8px; max-width: 70%; }
.turn-left  { align-items: flex-start; }
.turn-right { align-items: flex-end;   margin-left: auto; }
.turn-bubble { width: 100%; }







.turn-bubble-right :deep(.message-assistant) { align-items: flex-end !important; }
.turn-bubble-right :deep(.sender-name) { text-align: right !important; }

/* 气泡内文本换行 */
.turn-bubble :deep(.assistant-col) { min-width: 0 !important; }
.turn-bubble :deep(.assistant-bubble) { overflow-wrap: break-word !important; word-break: break-word !important; }

/* 含折叠栏 turn：左右区域（左侧头像 + 右侧列：名称 → 思维链 → 最终回复） */
.turn-chain-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  min-width: 0;
}
/* 延续轮（前仅隔插播 event 的同 agent 轮）：不重复头像/名称，内容列对齐
   原块（头像 32 + 间距 10）——与上一段读作同一 run 的连续片段 */
.turn-chain-row.is-cont, .turn-bubble.is-cont { padding-left: 42px; }
.turn-chain-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.turn-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
}
.turn-sender-name {
  font-size: 12px;
  color: var(--color-text-secondary, rgba(255,255,255,0.55));
  padding: 0 2px;
}

.chain-header {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 500;
  color: var(--color-text-secondary);
  user-select: none; cursor: pointer; padding: 2px 0; transition: color 0.15s;
}
/* 仅展开的思维链：折叠栏吸附在消息区顶部（抵消容器 padding），滚动途中可快速折叠 */
.chain-header.expanded {
  position: sticky;
  top: calc(var(--space-md) * -1);
  z-index: 5;
  background: var(--color-bg-page);
}
.chain-header:hover, .chain-streaming .chain-label { color: var(--color-text-primary); }
.chain-icon, .collapse-chevron { width: 14px; height: 14px; flex-shrink: 0; color: var(--color-text-secondary); }
.chain-label { font-weight: 500; }
.streaming-dots { display: inline-flex; align-items: center; gap: 2px; }
/* 统一琥珀色（思考语义，与 StatusDot thinking 同款）；错相延迟由 nth-child 给出 */
.streaming-dots .dot {
  width: 4px; height: 4px; border-radius: 50%;
  background: var(--warn, #f59e0b);
  animation: dot-pulse 1.4s infinite ease-in-out;
}
.streaming-dots .dot:nth-child(2) { animation-delay: 0.3s; }
.streaming-dots .dot:nth-child(3) { animation-delay: 0.6s; }
@keyframes dot-pulse { 0%,80%,100% { opacity: 0.3; } 40% { opacity: 1; } }
.collapse-chevron { transition: transform 0.2s ease; color: var(--color-text-tertiary, #a8abb2); }
.collapse-chevron.expanded { transform: rotate(90deg); }

.chain-body {
  display: flex; flex-direction: column; gap: 6px;
  border-left: 1px solid var(--color-border-secondary);
  margin-left: 7px; /* 对齐 chain-icon（14px）中心 */
  padding: 0 0 0 14px;
}
.chain-body :deep(.assistant-row) { max-width: 100% !important; }
/* 思维链内的 AI 气泡正文对齐 12px（与思维链内容一致） */
.chain-body :deep(.assistant-bubble .markdown-body) { font-size: 12px; }

/* chain-step-content 在 chain-body 内部，无需额外缩进 */
.chain-step-content {
  display: flex; flex-direction: column; gap: 6px;
}

/* 思维链隐藏模式的静态链栏头部：无折叠目标——指针/悬停反馈不适用 */
.chain-header.is-static { cursor: default; }
.chain-header.is-static:hover { background: transparent; color: var(--color-text-secondary); }
</style>

<!-- TurnDisplayItem.vue — 统一对话轮次 -->
<!-- 右 = settingsAgentId 的消息；左 = 其他 -->

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { VIEWER_ID } from '../viewer.ts';
import AssistantMessage from './AssistantMessage.vue';
import ToolMessage from './ToolMessage.vue';
import UserMessage from './UserMessage.vue';
import { resolveMessageView, resolveMessageViewRenderer } from '../messageViews.ts';
import { fmtElapsed } from '../feed.ts';
import { Avatar, Icon, ThinkingIcon } from '@agentchat/webui-kit';
import type { Turn, ChatMessage } from '../types.ts';

const props = defineProps<{
  turn: Turn; settingsAgentId: string; showActions?: boolean;
  /** 延续轮：前面仅隔插播 event 的同 agent 轮（run 被 event 分隔切开）——
   *  不再重复头像/名称，内容列对齐原块，读作同一 run 的连续片段 */
  continuation?: boolean;
  /** 所在会话键（M32 文件预览工作区推导——single = 会话 id；透传到
   *  previewFile payload，服务端按挂载工作区定位相对路径引用） */
  conversationId?: string;
}>();

const emit = defineEmits<{
  regenerate: [msgId: string];
  deleteMessage: [msgId: string];
  edit: [msgId: string, newContent: string];
  previewFile: [payload: { filePath: string; agentId?: string; conversationId?: string }];
}>();

const roster = useRosterCore();
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
//    渲染，但保留 chain-header 摘要（步数/耗时）+ 行首旋转环——隐藏模式下
//    header 是唯一的活动指示（Agent 正在思考/工作）。 ──
const visibleSteps = computed(() => (ui.showThinking ? meaningfulSteps.value : []));

const hasChain = computed(() => visibleSteps.value.length > 0);

const stepCount = computed(() => meaningfulSteps.value.length);

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
  // 形态（段间统一以「·」连接——与思考行/工具卡同款构造）：
  // 思考过程 · X 步 · 用时 99h59m59s（耗时未知时省略末段）
  const parts = [`思考过程 · ${cnt} 步`];
  if (elapsed > 0) parts.push(`用时 ${fmtElapsed(elapsed)}`);
  return parts.join(' · ');
});

const canEdit = computed(() => props.turn.agent_id === VIEWER_ID.value);

/** 重新推理/删除门控：assistant 轮同样允许（此前绑定 isSelf——settingsAgentId
 *  固定为 VIEWER，assistant 轮恒 false → 按钮渲染了但点击永不触发）。
 *  仅排除 system 分隔轮与流式进行中的轮。 */
const canRegenerate = computed(() => props.turn.agent_id !== 'system' && !isStreaming.value);

const senderAvatar = computed(() => {
  const aid = props.turn.agent_id;
  // 名册单源（预设/未命中 → null → Avatar 首字回退）；不再盲拼
  // /api/agents/:id/avatar 探测——__standard__ 等预设永不进名册，
  // 每条消息都会打一发注定 404 的请求刷控制台
  return aid ? roster.getAgentAvatar(aid) : null;
});
const senderName = computed(() => {
  const aid = props.turn.agent_id;
  if (!aid) return undefined;
  return roster.getAgentName(aid) || aid;
});

const isStreaming = computed(() => props.turn.steps.some(s => s.isStreaming));

/** 思维链隐藏模式：轮内确有链活动（思考/工具步被隐藏）→ 保留 chain-header
 *  摘要 + 流式 dots（活动指示），正文只呈现 final（中间口述不渲染） */
const hiddenChainMode = computed(() => !ui.showThinking && meaningfulSteps.value.length > 0);

/** 纯文本轮 loop 中的尾步流式态（分块渲染路径 + typing indicator）。
 *  final 强生命周期下收束物化时恒非流式——链轮/隐藏轮的流式渲染由
 *  步级 AssistantMessage 的 is-streaming 承担（见模板） */
const finalIsStreaming = computed(() => !hasChain.value && isStreaming.value && !finalMsg.value);
// 折叠不受流式过程控制（整链显隐由全局思维链开关承担）：流式中创建的
// 轮默认展开（实时阅读思考过程——链内工具卡/思考消息各自默认折叠），
// 历史轮默认折叠；此后仅用户手动切换，收束时不再自动折叠。
const isExpanded = ref(isStreaming.value);

// 行首图标位：hover 换折叠方向箭头，平时保持脑电波图标；链活动中且
// 非 hover 时整位让给旋转环（chain-spin-ring，模板 v-if 优先）。
const rowHover = ref(false);
const rowIcon = computed(() => {
  if (rowHover.value) return isExpanded.value ? 'chevron-up' : 'chevron-down';
  return 'chain';
});


function isThinkingStreamingNow(sIdx: number) {
  if (!isStreaming.value || sIdx !== visibleSteps.value.length - 1) return false;
  // 思考相位 = 仅思考文本在流入：正文或工具调用任一到场即思考收束
  // （思考消息 label 转「已思考 · XmYs」、思考计时定格——工具执行窗口
  // 不再被误标为思考中）
  const a = visibleSteps.value[sIdx].assistant;
  return !a.content?.trim() && !a.toolCalls?.length;
}
function toggleExpand() { isExpanded.value = !isExpanded.value; }

/**
 * 步内正文/工具卡的相对渲染序（2026-09-12 顺序反馈）：
 * textBeforeTools = true（正文分片先于工具调用到达——模型先口述再调
 * 工具的偶见形态）→ 正文在前；缺省（工具先行，常见形态）→ 工具卡在
 * 前。思考卡恒定最前，不参与交换。
 */
function stepBodyOrder(step: { assistant: ChatMessage }): Array<'text' | 'tools'> {
  return step.assistant.textBeforeTools === true ? ['text', 'tools'] : ['tools', 'text'];
}

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
          :message="finalMsg"
          :sender-avatar="senderAvatar" :sender-name="senderName"
          @edit="canEdit ? (id: any, c: any) => emit('edit', id, c) : undefined"
          @preview-file="(fp: string) => emit('previewFile', { filePath: fp, agentId: props.turn.agent_id, conversationId: props.conversationId })"
        />
      </div>
      <div v-else class="turn-bubble turn-bubble-left" :class="{ 'is-cont': continuation }">
        <AssistantMessage
          :message="plainMsg" :is-streaming="finalIsStreaming"
          :sender-avatar="continuation ? null : senderAvatar" :sender-name="continuation ? undefined : senderName"
          :show-actions="showActions"
          @preview-file="(fp: string) => emit('previewFile', { filePath: fp, agentId: props.turn.agent_id, conversationId: props.conversationId })"
          @regenerate="finalMsg && canRegenerate && showActions ? emit('regenerate', finalMsg.id) : undefined"
          @delete-message="finalMsg && canRegenerate && showActions ? emit('deleteMessage', finalMsg.id) : undefined"
        />
      </div>
    </template>

    <!-- ═══ 含折叠栏 ═══ -->
    <template v-if="hasChain">
      <div class="turn-chain-row" :class="{ 'is-cont': continuation }">
        <!-- 左侧头像（延续轮不重复；无头像 = 纯 icon 占位，不打 404 探测） -->
        <div v-if="!isSelf && !continuation" class="turn-avatar">
          <Avatar :src="senderAvatar" :name="senderName" :size="32" fallback-icon="bot" plain-fallback />
        </div>
        <!-- 右侧列：名称 → 思维链 → 最终回复 -->
        <div class="turn-chain-col">
          <div v-if="!isSelf && senderName && !continuation" class="turn-sender-name">{{ senderName }}</div>

          <div
            class="chain-header"
            :class="{ 'chain-streaming': isStreaming, expanded: isExpanded }"
            @click="toggleExpand"
            @mouseenter="rowHover = true"
            @mouseleave="rowHover = false"
          >
            <!-- 图标位：链活动中且非 hover → 琥珀旋转环（2026-12 与思考卡/
                 工具卡同款选型，尾部 dots 退役）；hover 显示折叠箭头（交互优先） -->
            <span v-if="isStreaming && !rowHover" class="chain-spin-ring" aria-hidden="true"></span>
            <Icon v-else :name="rowIcon" :size="14" class="chain-icon" />
            <!-- 单行截断（容器窄时尾部省略不换行），title 悬浮看全文 -->
            <span class="chain-label" :title="chainLabel">{{ chainLabel }}</span>
      </div>

      <div v-show="isExpanded" class="chain-body">
        <template v-for="(step, sIdx) in visibleSteps" :key="stepKey(step, sIdx)">
          <AssistantMessage
            :message="{ ...step.assistant, content: '', toolCalls: [] }"
            :is-streaming="isThinkingStreamingNow(sIdx)" :show-copy="false" compact
            @preview-file="(fp: string) => emit('previewFile', { filePath: fp, agentId: props.turn.agent_id, conversationId: props.conversationId })"
          />
          <!-- 步内正文/工具卡相对序：textBeforeTools=true（正文分片先到）→
               正文在前，工具卡随后；缺省（工具先行，常见形态）→ 工具卡在
               前。真实发生顺序与流式到达序一致（2026-09-12 顺序反馈） -->
          <template v-for="seg in stepBodyOrder(step)" :key="`${stepKey(step, sIdx)}-seg-${seg}`">
            <template v-if="seg === 'tools'">
              <ToolMessage
                v-for="(tool, tIdx) in step.tools" :key="`${stepKey(step, sIdx)}-tool-${tool.tool_call_id ?? tIdx}`"
                :message="tool"
                :conversation-id="conversationId"
              />
            </template>
            <div v-else-if="step.assistant.content?.trim() && step.assistant.content !== finalMsg?.content" class="chain-step-content">
              <!-- 修复：正文展示以「是否等于 final 气泡正文」为准，而非「是否最后一条 meaningful step」。
                   当 entry 末尾有纯文本消息（如 send_agent 投递）时，最后一条 meaningful step 的正文
                   既不是 final（final=末尾纯文本），也不应被吞掉，需在此展示。
                   loop 中 final 悬置（null）→ 流式正文在链内原位渲染（is-streaming 走分块路径）；
                   收束物化后与 final 同正文的步由此去重 -->
              <!-- flat：链内中间口述不用气泡包裹——与思考文本同为纯文本流，
                   视觉层级让位给收束后的 final 气泡 -->
              <AssistantMessage
                :message="{ ...step.assistant, thinking: '', reasoning_content: '', toolCalls: [] }"
                :show-copy="false" compact flat
                :is-streaming="!!step.isStreaming"
                @preview-file="(fp: string) => emit('previewFile', { filePath: fp, agentId: props.turn.agent_id, conversationId: props.conversationId })"
              />
            </div>
          </template>
        </template>
      </div>

          <!-- 空 final（仅以工具调用收尾、无正文）不渲染：空 turn-bubble 会在
               turn-chain-col 的 flex gap 中多出一段空隙（与链内空壳消息同源）；
               插件 message-view renderer 除外（可能渲染自定义卡片） -->
          <div v-if="finalMsg && (finalRenderer || finalMsg.content?.trim())" :class="isSelf ? 'turn-bubble turn-bubble-right' : 'turn-bubble turn-bubble-left'">
            <component v-if="finalRenderer" :is="finalRenderer" :turn="turn" :final="finalMsg" />
            <AssistantMessage
              v-else
              :message="finalMsg" :is-streaming="finalIsStreaming"
              :show-actions="showActions"
              @preview-file="(fp: string) => emit('previewFile', { filePath: fp, agentId: props.turn.agent_id, conversationId: props.conversationId })"
              @regenerate="canRegenerate && showActions ? emit('regenerate', finalMsg.id) : undefined"
              @delete-message="canRegenerate && showActions ? emit('deleteMessage', finalMsg.id) : undefined"
            />
          </div>
        </div>
      </div>
    </template>

    <!-- ═══ 思维链隐藏：链体（思考/工具/中间口述）一律不渲染，仅保留
         chain-header 摘要（步数/耗时）+ 行首旋转环作活动指示，正文只呈现
         final（loop 中悬置 → 只有 header + 环；收束物化 → final 气泡）═══ -->
    <div v-if="hiddenChainMode" class="turn-chain-row" :class="{ 'is-cont': continuation }">
      <div v-if="!isSelf && !continuation" class="turn-avatar">
        <Avatar :src="senderAvatar" :name="senderName" :size="32" fallback-icon="bot" plain-fallback />
      </div>
      <div class="turn-chain-col">
        <div v-if="!isSelf && senderName && !continuation" class="turn-sender-name">{{ senderName }}</div>
        <div class="chain-header is-static" :class="{ 'chain-streaming': isStreaming }">
          <!-- 图标位：链活动中 → 琥珀旋转环（静态 header 无折叠语义，无 hover 箭头） -->
          <span v-if="isStreaming" class="chain-spin-ring" aria-hidden="true"></span>
          <ThinkingIcon v-else :size="14" class="chain-icon" />
          <span class="chain-label">{{ chainLabel }}</span>
        </div>
        <div v-if="finalMsg && (finalRenderer || finalMsg.content?.trim())" :class="isSelf ? 'turn-bubble turn-bubble-right' : 'turn-bubble turn-bubble-left'">
          <component v-if="finalRenderer" :is="finalRenderer" :turn="turn" :final="finalMsg" />
          <AssistantMessage
            v-else
            :message="finalMsg" :is-streaming="finalIsStreaming"
            :show-actions="showActions"
            @preview-file="(fp: string) => emit('previewFile', { filePath: fp, agentId: props.turn.agent_id, conversationId: props.conversationId })"
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
  /* 允许随容器收缩（侧边栏压缩会话宽度时），label 单行省略 */
  min-width: 0;
}
/* 仅展开的思维链：折叠栏吸附在消息区顶部（抵消容器 padding），滚动途中可快速折叠 */
.chain-header.expanded {
  position: sticky;
  top: calc(var(--space-md) * -1);
  z-index: 5;
  background: var(--color-bg-page);
}
.chain-header:hover, .chain-streaming .chain-label { color: var(--color-text-primary); }
.chain-icon { width: 14px; height: 14px; flex-shrink: 0; color: var(--color-text-secondary); transition: opacity 0.12s ease; }
/* 链栏 label：单行截断——容器宽度不足时尾部「…」，悬浮 title 看全文 */
.chain-label {
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 链活动旋转环（2026-12 统一选型，替换尾部琥珀 dots）：链级「执行中」
 * 指示——与思考卡 think-spin-ring / 工具卡 tool-spin-ring 同色同款，
 * 全前端"忙"指示统一。环已入 prefers-reduced-motion 豁免清单（main.css）。 */
.chain-spin-ring {
  width: 13px; height: 13px; margin: 0.5px; /* 14px 图标位内居中 */
  border-radius: 50%;
  border: 2px solid var(--color-warning-light, rgba(245,158,11,0.15));
  border-top-color: var(--color-warning, #f59e0b);
  animation: chainSpin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes chainSpin { to { transform: rotate(360deg); } }

.chain-body {
  display: flex; flex-direction: column; gap: 10px;
  border-left: 1px solid var(--color-border-secondary);
  margin-left: 7px; /* 对齐 chain-icon（14px）中心 */
  padding: 0 0 0 14px;
}
.chain-body :deep(.assistant-row) { max-width: 100% !important; }
/* 思维链内的 AI 气泡正文对齐 12px（与思维链内容一致） */
.chain-body :deep(.assistant-bubble .markdown-body) { font-size: 12px; }
/* 内联代码与代码块字号随之联动（默认 0.88em/13px，此处均压到 11px 视觉均衡） */
.chain-body :deep(.assistant-bubble .markdown-body) { --md-inline-fs: 11px; --md-code-fs: 11px; }

/* chain-step-content 在 chain-body 内部，无需额外缩进 */
.chain-step-content {
  display: flex; flex-direction: column; gap: 10px;
}

/* 思维链隐藏模式的静态链栏头部：无折叠目标——指针/悬停反馈不适用 */
.chain-header.is-static { cursor: default; }
.chain-header.is-static:hover { background: transparent; color: var(--color-text-secondary); }
</style>

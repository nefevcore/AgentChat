<!-- AssistantMessage.vue -->
<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { useMarkdown } from '@/composables/useMarkdown';
import { useChunkedMarkdown } from '@/composables/useChunkedMarkdown';
import { useUiStore } from '@/stores/ui';
import { Avatar } from '@/ui';
import ThoughtIcon from '@/ui/ThoughtIcon.vue';
import type { ChatMessage, FileAttachment } from '@/types';

const props = withDefaults(defineProps<{
    message: ChatMessage;
    index: number;
    isStreaming?: boolean;
    showCopy?: boolean;
    /** 是否显示操作按钮（重新推理/删除）；群聊等只读场景传 false */
    showActions?: boolean;
    /** 在 ThinkingToolGroup 内使用时不额外加 padding（由外层提供） */
    compact?: boolean;
    /** 发送者头像 URL */
    senderAvatar?: string | null;
    /** 发送者显示名称 */
    senderName?: string;
}>(), {
    showCopy: true,
    showActions: true,
    compact: false,
});

const emit = defineEmits<{
    downloadFile: [file: FileAttachment];
    previewFile: [filePath: string];
    /** 重新推理（重试） */
    regenerate: [];
    /** 删除此消息 */
    deleteMessage: [];
}>();

const { render, renderPlain } = useMarkdown();

// ── markdown 渲染结果缓存（性能优化核心） ──
// 流式输出每次 token 都会触发重渲染；若直接在 v-html 里调 render()，
// 每条消息每帧都会全量重跑 markdown-it + highlight.js，出字卡顿。
//
// v1（此前）：rAF 合并 + 缓存 HTML —— 每帧只渲染一次，但仍对"全部已累积内容"全量渲染，
//             长消息呈 O(n²)（这就是"逐帧刷新"仍不够流畅的根源）。
// v2（现在）：分块渲染 —— 内容切成"已提交前缀 + 待提交尾部"：
//             已提交部分仅在跨越安全边界（代码围栏外的空行）时增长，HTML 缓存复用；
//             待提交尾部转义后以纯文本追加显示（几乎零成本）。
//             每帧渲染成本 ≈ 增量而非全部内容；思考计时等无关更新命中缓存不再重渲染。
const {
  html: contentHtml,
  pendingText: contentPendingText,
  update: updateContentRender,
  flush: flushContentRender,
} = useChunkedMarkdown(render);
const {
  html: reasoningHtml,
  pendingText: reasoningPendingText,
  update: updateReasoningRender,
  flush: flushReasoningRender,
} = useChunkedMarkdown(renderPlain);

const reasoningText = computed(() => props.message.reasoning_content || props.message.thinking || '');

watch(() => props.message.content, (v) => updateContentRender(v ?? '', !!props.isStreaming), { immediate: true });
watch(reasoningText, (v) => updateReasoningRender(v ?? '', !!props.isStreaming), { immediate: true });
// 流式结束 → 立即全量渲染一次，保证最终输出与完整渲染完全一致
watch(() => props.isStreaming, (v) => {
  if (!v) {
    flushContentRender(props.message.content || '');
    flushReasoningRender(props.message.reasoning_content || props.message.thinking || '');
  }
});

const hasThinking = computed(() => {
    const rc = props.message.reasoning_content || props.message.thinking || '';
    return rc.trim().length > 0;
});

// ── 思维链全局可见性（会话头部 switch）：关闭时思考区整体不渲染 ──
const ui = useUiStore();
const thinkingVisible = computed(() => ui.showThinking);

const hasOnlyThinking = computed(() => {
    return hasThinking.value && (!props.message.content || props.message.content.trim() === '');
});

const hasContent = computed(() => {
    return !!(props.message.content && props.message.content.trim().length > 0);
});

// 思考标签：优先使用后端推送的 label（含耗时），否则使用本地计时
const thinkingLabel = computed(() => {
    if (props.message.label) return props.message.label;
    if (props.isStreaming && hasThinking.value) {
        return `已思考（用时 ${thinkingElapsed.value} 秒）`;
    }
    if (!props.isStreaming && hasThinking.value && thinkingElapsed.value > 0) {
        return `已思考（用时 ${thinkingElapsed.value} 秒）`;
    }
    return '思考过程';
});

// 本地思考计时
const thinkingStartTime = ref<number>(Date.now());
const thinkingElapsed = ref(0);
let thinkingTimer: ReturnType<typeof setInterval> | null = null;

watch(() => props.isStreaming, (val) => {
    if (val && hasThinking.value) {
        thinkingStartTime.value = Date.now();
        thinkingElapsed.value = 0;
        thinkingTimer = setInterval(() => {
            thinkingElapsed.value = Math.floor((Date.now() - thinkingStartTime.value) / 1000);
        }, 500);
    } else {
        if (thinkingTimer) {
            clearInterval(thinkingTimer);
            thinkingTimer = null;
        }
        thinkingElapsed.value = Math.floor((Date.now() - thinkingStartTime.value) / 1000);
    }
}, { immediate: true });

onBeforeUnmount(() => {
    if (thinkingTimer) clearInterval(thinkingTimer);
});

// 代码块复制按钮事件委托
const messageRoot = ref<HTMLElement | null>(null);

function handleCodeBlockClick(e: Event) {
    const target = e.target as HTMLElement;

    // 文件路径链接点击（正则匹配的路径 + <file> 标签）
    const fileLink = target.closest('.file-path-link') as HTMLElement | null
        || target.closest('.file-tag') as HTMLElement | null;
    if (fileLink) {
        const path = fileLink.dataset.filePath;
        if (path) {
            e.preventDefault();
            e.stopPropagation();
            emit('previewFile', path);
            return;
        }
    }

    // "复制" 按钮
    const copyBtn = target.closest('.md-code-block-btn[data-action="copy"]') as HTMLElement | null;
    if (!copyBtn) return;

    const block = copyBtn.closest('.md-code-block');
    const codeEl = block?.querySelector('pre code');
    if (!codeEl) return;

    const text = codeEl.textContent || '';
    navigator.clipboard.writeText(text).then(() => {
        copyBtn.classList.add('copied');
        const textSpan = copyBtn.querySelector('.md-code-block-btn-text');
        if (textSpan) textSpan.textContent = '已复制';
        setTimeout(() => {
            copyBtn.classList.remove('copied');
            if (textSpan) textSpan.textContent = '复制';
        }, 2000);
    }).catch(() => {
        const textSpan = copyBtn.querySelector('.md-code-block-btn-text');
        if (textSpan) textSpan.textContent = '失败';
        setTimeout(() => {
            if (textSpan) textSpan.textContent = '复制';
        }, 1500);
    });
}

watch(messageRoot, (el, oldEl) => {
    // 根节点随 v-if 显隐（空消息不渲染）：元素可能在挂载之后才出现/消失
    // （如 final 气泡先空后出正文），不能只在 onMounted 一次性绑定
    if (oldEl) oldEl.removeEventListener('click', handleCodeBlockClick);
    if (el) el.addEventListener('click', handleCodeBlockClick);
});

// 是否渲染根节点。多步轮次中"仅工具调用、无思考无正文"的 step（以及仅以
// 工具调用收尾的空 final）会得到一个全空壳消息：此前仍渲染占位骨架，
// 在思维链 flex gap 中产生多余空隙（微妙错位）→ 整个节点不渲染。
// （流式活动指示统一由链栏 header 的 dots 承担，本组件不再渲染
//  typing dots/typing indicator）
const shouldRender = computed(() => (hasThinking.value && thinkingVisible.value) || hasContent.value);

// 判断是否为错误消息
const isError = computed(() => props.message.isError === true);

// 复制消息全文
const copyState = ref<'idle' | 'copied' | 'error'>('idle');
let copyTimer: ReturnType<typeof setTimeout> | null = null;

function copyMessageContent() {
    const text = props.message.content || '';
    navigator.clipboard.writeText(text).then(() => {
        copyState.value = 'copied';
        if (copyTimer) clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { copyState.value = 'idle'; }, 2000);
    }).catch(() => {
        copyState.value = 'error';
        if (copyTimer) clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { copyState.value = 'idle'; }, 2000);
    });
}

onBeforeUnmount(() => {
    if (copyTimer) clearTimeout(copyTimer);
});

// 折叠状态：思考内容默认展开（不管是否流式中），用户可手动折叠。
// 曾实现为“思考中展开、结束后折叠”，用户反馈思考内容应默认可见。
const showThinking = ref(true);

watch(() => props.isStreaming, (streaming) => {
  // 流式中始终强制展开（便于实时阅读思考），结束后保留用户当前选择
  if (streaming) showThinking.value = true;
}, { immediate: true });

function isThinkingExpanded(): boolean {
    return showThinking.value || false;
}

function toggleThinking() {
    showThinking.value = !showThinking.value;
}
</script>

<template>
    <div v-if="shouldRender" ref="messageRoot" class="message-item message-assistant">
        <div class="assistant-row">
            <!-- 左侧头像 -->
            <div v-if="senderAvatar" class="msg-avatar">
                <Avatar :src="senderAvatar" :name="senderName" :size="32" />
            </div>

            <!-- 右侧列：名称 → 思维链 → 最终回复 -->
            <div class="assistant-col">
                <!-- ① 名称 -->
                <div v-if="senderName" class="sender-name">{{ senderName }}</div>

                <!-- ② 思考过程（受全局思维链开关控制） -->
                <div v-if="hasThinking && thinkingVisible" class="think-content-section" :class="{ 'in-group': compact, 'no-content-below': hasOnlyThinking && !isStreaming }">
                    <div class="think-content-label" @click="toggleThinking()">
                        <ThoughtIcon :size="14" class="think-icon" />
                        <span>{{ thinkingLabel }}</span>
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                            class="collapse-chevron" :class="{ 'chevron-expanded': isThinkingExpanded() }">
                            <path d="m9 18 6-6-6-6"/>
                        </svg>
                    </div>
                    <div v-show="isThinkingExpanded()" class="think-content-body markdown-body">
                        <div class="think-content-rendered" v-html="reasoningHtml" />
                        <span v-if="reasoningPendingText" class="streaming-pending">{{ reasoningPendingText }}</span>
                    </div>
                </div>

                <!-- ③ AI 回复正文 -->
                <div v-if="hasContent" class="assistant-bubble">
                    <div v-if="isError" class="markdown-body error-message" v-html="contentHtml" />
                    <div v-else class="markdown-body" v-html="contentHtml" />
                    <span v-if="contentPendingText" class="streaming-pending">{{ contentPendingText }}</span>
                </div>

                <div v-if="showCopy !== false && hasContent" class="copy-btn-row">
                    <button
                        class="copy-message-btn"
                        :class="{ copied: copyState === 'copied', error: copyState === 'error' }"
                        @click="copyMessageContent"
                        :title="copyState === 'copied' ? '已复制' : copyState === 'error' ? '复制失败' : '复制全文'"
                    >
                        <svg v-if="copyState === 'idle'" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                        </svg>
                        <svg v-else-if="copyState === 'copied'" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12"/>
                        </svg>
                        <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                    <button
                        v-if="showActions"
                        class="msg-action-btn"
                        :disabled="isStreaming"
                        @click="emit('regenerate')"
                        title="重新推理"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="23 4 23 10 17 10"/>
                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                        </svg>
                    </button>
                    <button
                        v-if="showActions"
                        class="msg-action-btn danger"
                        :disabled="isStreaming"
                        @click="emit('deleteMessage')"
                        title="删除消息"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                            <path d="M10 11v6"/>
                            <path d="M14 11v6"/>
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.message-item {
    display: flex;
    flex-direction: column;
    width: 100%;
}

.message-assistant {
    align-items: flex-start;
}

/* 左右区域：左侧头像 + 右侧列（名称 → 思维链 → 最终回复） */
.assistant-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    /* width 由 TurnDisplayItem 的 .turn-item max-width:70% 统一管控 */
}

.assistant-col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}


.msg-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    overflow: hidden;
    flex-shrink: 0;
    align-self: flex-start;
    display: flex;
    align-items: center;
    justify-content: center;
}
.msg-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    position: relative;
    z-index: 1;
}
.avatar-fallback {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
    font-weight: 600;
    color: var(--color-primary, #4f46e5);
}

.sender-name {
    font-size: 12px;
    color: var(--color-text-secondary, rgba(255,255,255,0.55));
    padding: 0 2px;
    line-height: 1;
}

.assistant-bubble {
    padding: 8px 12px;
    background: var(--color-bg-assistant, rgba(79, 70, 229, 0.04));
    /* 描边与气泡底色一致，视觉上无描边感 */
    border: 1px solid var(--color-bg-assistant, rgba(79, 70, 229, 0.04));
    border-radius: 6px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04);
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
}

/* 流式待提交尾部：转义纯文本，等下一个安全边界并入已提交区 */
.streaming-pending {
    white-space: pre-wrap;
    word-break: break-word;
    opacity: 0.85;
}
.think-content-rendered {
    min-width: 0;
}

.error-message {
    color: var(--color-error);
    background: var(--color-danger-light);
    padding: 12px;
    border-radius: 8px;
    border: 1px solid var(--color-error);
}

/* ===== 思考过程 ===== */
/* 群聊（in-group）思考区必须约束宽度，否则被内部代码块（hljs-string 超长）撑破
   父级 turn-item 的 70% 限制，溢出屏幕（如 impc-dev 群聊 1148px > 容器 589px） */
.think-content-section {
    min-width: 0;
    max-width: 100%;
}
.think-content-section:not(.in-group) {
    /* width 由 TurnDisplayItem 统一管控；头像已移至顶部 header，此处与气泡左对齐 */
    padding: 0;
    margin-bottom: 8px;
}

.think-content-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text-secondary);
    user-select: none;
    cursor: pointer;
    padding: 2px 0;
    transition: color 0.15s;
}

.think-content-label:hover {
    color: var(--color-text-primary);
}

.think-icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--color-text-secondary);
}

.think-content-body {
    font-size: 12px;
    line-height: 1.7;
    color: var(--color-text-secondary);
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: calc(12px * 1.7 + 12px);
    margin-left: 7px;
    border-left: 1px solid var(--color-border-secondary);
    padding-left: 14px;
    /* 防止思考区代码块（含 hljs-string 超长）撑破 */
    min-width: 0;
    max-width: 100%;
}

.think-content-body :deep(p) {
    margin: 6px 0;
}

.think-content-body :deep(p:first-child) {
    margin-top: 0;
}

.think-content-body :deep(p:last-child) {
    margin-bottom: 0;
}

.think-content-body :deep(code) {
    font-size: 11px;
}

.think-content-body :deep(h1),
.think-content-body :deep(h2),
.think-content-body :deep(h3) {
    font-size: 12px;
    font-weight: 600;
    margin: 8px 0 4px;
    color: var(--color-text-secondary);
}

.think-content-body :deep(ul),
.think-content-body :deep(ol) {
    padding-left: 18px;
    margin: 4px 0;
}

.think-content-section.no-content-below {
    margin-bottom: 0;
}

/* ===== 复制按钮 ===== */
.copy-btn-row {
    display: flex;
    justify-content: flex-start;
    margin-top: 4px;
    padding-left: 2px;
    gap: 2px;
}

.copy-message-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    color: var(--color-text-tertiary, #a8abb2);
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: color 0.15s ease;
    line-height: 0;
}

.copy-message-btn:hover {
    color: var(--color-text-secondary);
}

.copy-message-btn.copied {
    color: #22c55e;
}

.copy-message-btn.error {
    color: var(--color-error);
}

.msg-action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    color: var(--color-text-tertiary, #a8abb2);
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: color 0.15s ease;
    line-height: 0;
}

.msg-action-btn:hover:not(:disabled) {
    color: var(--color-text-secondary);
}

.msg-action-btn.danger:hover:not(:disabled) {
    color: var(--color-error, #e74c3c);
}

.msg-action-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

/* 折叠箭头 */
.collapse-chevron {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    transition: transform 0.2s ease;
    color: var(--color-text-tertiary, #a8abb2);
}

.chevron-expanded {
    transform: rotate(90deg);
}

/* ===== 文件路径链接 ===== */
:deep(.file-path-link) {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--color-primary-light, rgba(79,70,229,0.1));
    color: var(--color-primary, #7c7cf8);
    cursor: pointer;
    font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
    font-size: 0.9em;
    text-decoration: none;
    border: 1px solid transparent;
    transition: all 0.15s ease;
    word-break: break-all;
}
:deep(.file-path-link):hover {
    background: var(--color-primary-light, rgba(79,70,229,0.18));
    border-color: var(--color-primary, rgba(124,124,248,0.3));
    color: var(--color-primary-hover, #918cf8);
    text-decoration: underline;
}

/* ===== <file> 标签（带文件图标） ===== */
:deep(.file-tag) {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 8px;
    border-radius: 4px;
    background: var(--color-primary-light, rgba(79,70,229,0.1));
    color: var(--color-primary, #7c7cf8);
    cursor: pointer;
    font-size: 0.9em;
    text-decoration: none;
    border: 1px solid transparent;
    transition: all 0.15s ease;
}
:deep(.file-tag):hover {
    background: var(--color-primary-light, rgba(79,70,229,0.18));
    border-color: var(--color-primary, rgba(124,124,248,0.3));
    color: var(--color-primary-hover, #918cf8);
    text-decoration: underline;
}

</style>

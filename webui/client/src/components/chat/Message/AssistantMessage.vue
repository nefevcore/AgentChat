<!-- AssistantMessage.vue -->
<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useMarkdown } from '@/composables/useMarkdown';
import TypingIndicator from '../shared/TypingIndicator.vue';
import type { ChatMessage, FileAttachment } from '@/types';

const props = withDefaults(defineProps<{
    message: ChatMessage;
    index: number;
    isStreaming?: boolean;
    showCopy?: boolean;
    /** 在 ThinkingToolGroup 内使用时不额外加 padding（由外层提供） */
    compact?: boolean;
    /** 发送者头像 URL */
    senderAvatar?: string | null;
    /** 发送者显示名称 */
    senderName?: string;
}>(), {
    showCopy: true,
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

function renderContent() {
    return render(props.message.content || '');
}
function renderReasoning() {
    const rc = props.message.reasoning_content || props.message.thinking || '';
    if (!rc.trim()) return '';
    return renderPlain(rc);
}

const hasThinking = computed(() => {
    const rc = props.message.reasoning_content || props.message.thinking || '';
    return rc.trim().length > 0;
});

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

const thinkingCompleted = computed(() => {
    return props.message.label?.startsWith('已思考') ?? false;
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

onMounted(() => {
    if (messageRoot.value) {
        messageRoot.value.addEventListener('click', handleCodeBlockClick);
    }
});

onBeforeUnmount(() => {
    if (messageRoot.value) {
        messageRoot.value.removeEventListener('click', handleCodeBlockClick);
    }
});

// 判断是否应该显示 typing indicator
const shouldShowTyping = computed(() => {
    if (!props.isStreaming) return false;
    if (hasContent.value) return false;
    return true;
});

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

// 折叠状态：思考中默认展开，结束后默认折叠
const showThinking = ref(false);

watch(() => props.isStreaming, (streaming) => {
    showThinking.value = streaming;
}, { immediate: true });

function isThinkingExpanded(): boolean {
    return showThinking.value || false;
}

function toggleThinking() {
    showThinking.value = !showThinking.value;
}
</script>

<template>
    <div ref="messageRoot" class="message-item message-assistant">
        <!-- ① 思考过程 -->
        <div v-if="hasThinking" class="think-content-section" :class="{ 'in-group': compact, 'no-content-below': hasOnlyThinking && !isStreaming, 'has-avatar': !!senderAvatar }">
            <div class="think-content-label" @click="toggleThinking()">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                    class="think-icon">
                    <path d="M12 2a6 6 0 0 1 6 6c0 2.5-1.8 5.5-3.4 6.4a2.5 2.5 0 0 0-1.6 1.6A7 7 0 0 1 12 22a7 7 0 0 1-1-13.9A6 6 0 0 1 12 2z"/>
                    <path d="M12 16v4"/><path d="M8 16v4"/><path d="M10 18h4"/>
                </svg>
                <span>{{ thinkingLabel }}</span>
                <span v-if="isStreaming && !thinkingCompleted" class="streaming-dots">
                    <span class="dot dot-red"></span>
                    <span class="dot dot-gray"></span>
                    <span class="dot dot-gray"></span>
                </span>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                    class="collapse-chevron" :class="{ 'chevron-expanded': isThinkingExpanded() }">
                    <path d="m9 18 6-6-6-6"/>
                </svg>
            </div>
            <div v-show="isThinkingExpanded()" class="think-content-body markdown-body" v-html="renderReasoning()" />
        </div>

        <!-- ② AI 回复正文 -->
        <div v-if="hasContent" class="assistant-message">
            <div class="msg-avatar" v-if="senderAvatar">
                <img :src="senderAvatar" :alt="senderName || ''" @load="($event.target as HTMLImageElement).style.display=''" @error="($event.target as HTMLImageElement).style.display='none'" />
                <div class="avatar-fallback">{{ (senderName || '?').charAt(0).toUpperCase() }}</div>
            </div>
            <div class="assistant-content">
                <div class="sender-name" v-if="senderName">{{ senderName }}</div>
                <div class="assistant-bubble">
                    <div v-if="isError" class="markdown-body error-message" v-html="renderContent()" />
                    <div v-else class="markdown-body" v-html="renderContent()" />
                </div>
                <div v-if="showCopy !== false" class="copy-btn-row">
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

        <!-- 只在没有内容且正在流式时显示 typing indicator -->
        <div v-if="shouldShowTyping" class="assistant-message">
            <TypingIndicator />
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

.assistant-message {
    display: flex;
    gap: 10px;
    /* width 由 TurnDisplayItem 的 .turn-item max-width:70% 统一管控 */
}


.msg-avatar {
    width: 36px;
    height: 36px;
    border-radius: 6px;
    overflow: hidden;
    flex-shrink: 0;
    align-self: flex-start;
    position: relative;
    background: var(--color-primary-light, rgba(79,70,229,0.12));
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
    margin-bottom: 4px;
    padding: 0 2px;
}

.assistant-content {
    flex: 1;
    min-width: 0;
}

.assistant-bubble {
    padding: 8px 12px;
    background: var(--color-bg-assistant, rgba(79, 70, 229, 0.04));
    border-radius: 6px;
}

.error-message {
    color: var(--color-error);
    background: var(--color-danger-light);
    padding: 12px;
    border-radius: 8px;
    border: 1px solid var(--color-error);
}

/* ===== 思考过程 ===== */
.think-content-section:not(.in-group) {
    /* width 由 TurnDisplayItem 统一管控 */
    padding: 0 16px;
    margin-bottom: 8px;
}

/* 有头像时，思考区域左边缘需与聊天气泡对齐（头像 36px + gap 10px = 46px） */
.think-content-section.has-avatar:not(.in-group) {
    padding-left: 46px;
}


.think-content-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
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
    font-size: 13px;
    line-height: 1.7;
    color: var(--color-text-secondary);
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: calc(13px * 1.7 + 12px);
    margin-left: 7px;
    border-left: 1px solid var(--color-border-secondary);
    padding-left: 14px;
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
    font-size: 12px;
}

.think-content-body :deep(h1),
.think-content-body :deep(h2),
.think-content-body :deep(h3) {
    font-size: 13px;
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

/* 流式动画点 */
.streaming-dots {
    display: inline-flex;
    align-items: center;
    gap: 2px;
}

.streaming-dots .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    animation: dot-pulse 1.4s infinite ease-in-out;
}

.dot-red {
    background: #e74c3c;
    animation-delay: 0s;
}

.dot-gray {
    background: #a8abb2;
    animation-delay: 0.3s;
}

.dot-gray:last-child {
    animation-delay: 0.6s;
}

@keyframes dot-pulse {
    0%, 80%, 100% { opacity: 0.3; }
    40% { opacity: 1; }
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

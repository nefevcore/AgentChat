<!-- UserMessage.vue -->
<script setup lang="ts">
import { ref, nextTick } from 'vue';
import type { ChatMessage } from '@/types';

const props = defineProps<{
    message: ChatMessage;
    index: number;
    senderAvatar?: string | null;
    senderName?: string;
}>();

const emit = defineEmits<{
    edit: [msgId: string, newContent: string];
}>();

const editing = ref(false);
const editText = ref('');
const editInput = ref<HTMLTextAreaElement | null>(null);

function startEdit() {
    editText.value = props.message.content;
    editing.value = true;
    nextTick(() => editInput.value?.focus());
}

function confirmEdit() {
    const trimmed = editText.value.trim();
    if (!trimmed || trimmed === props.message.content) {
        editing.value = false;
        return;
    }
    emit('edit', props.message.id, trimmed);
    editing.value = false;
}

function cancelEdit() {
    editing.value = false;
}

function onEditKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        confirmEdit();
    }
    if (e.key === 'Escape') {
        cancelEdit();
    }
}

const copyState = ref<'idle' | 'copied' | 'error'>('idle');
let copyTimer: ReturnType<typeof setTimeout> | null = null;

function copyContent() {
    navigator.clipboard.writeText(props.message.content).then(() => {
        copyState.value = 'copied';
        if (copyTimer) clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { copyState.value = 'idle'; }, 2000);
    }).catch(() => {
        copyState.value = 'error';
        if (copyTimer) clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { copyState.value = 'idle'; }, 2000);
    });
}
</script>

<template>
    <div class="message-item message-user">
        <div class="user-message">
            <div class="user-msg-body">
                <div class="user-bubble">
                    <!-- 编辑模式 -->
                    <div v-if="editing" class="edit-area">
                        <textarea
                            ref="editInput"
                            v-model="editText"
                            class="edit-input"
                            rows="2"
                            @keydown="onEditKeydown"
                        />
                        <div class="edit-actions">
                            <span class="edit-hint">Enter 确认 · Esc 取消</span>
                            <button class="edit-btn confirm" @click="confirmEdit">确认</button>
                            <button class="edit-btn cancel" @click="cancelEdit">取消</button>
                        </div>
                    </div>
                    <!-- 正常显示 -->
                    <p v-else class="user-text">{{ message.content }}</p>
                </div>
            <div v-if="!editing" class="user-btn-row">
                <button
                    class="user-msg-btn"
                    :class="{ copied: copyState === 'copied', error: copyState === 'error' }"
                    @click="copyContent"
                    :title="copyState === 'copied' ? '已复制' : copyState === 'error' ? '复制失败' : '复制'"
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
                    class="user-msg-btn"
                    @click="startEdit"
                    title="修改"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                </button>
            </div>
            </div>
            <div class="msg-avatar" v-if="senderAvatar">
                <img :src="senderAvatar" :alt="senderName || ''" @load="($event.target as HTMLImageElement).style.display=''" @error="($event.target as HTMLImageElement).style.display='none'" />
                <div class="avatar-fallback">{{ (senderName || '?').charAt(0).toUpperCase() }}</div>
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

.message-user {
    align-items: flex-end;
}

.user-message {
    display: flex;
    justify-content: flex-end;
    align-items: flex-start;
    gap: 10px;
    max-width: 60%;
}

/* 阶梯宽度：不同界面大小下消息气泡宽度不同 */
@media (max-width: 900px) {
    .user-message {
        max-width: 70%;
    }
}

@media (max-width: 640px) {
    .user-message {
        max-width: 85%;
    }
}

.user-msg-body {
    order: -1;
}

.user-bubble {
    background: var(--color-bg-user-container);
    border-radius: 6px;
    padding: 8px 12px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.user-text {
    font-size: 14px;
    line-height: 1.5;
    color: var(--color-text-primary);
    white-space: pre-wrap;
    word-break: break-word;
}

.msg-avatar {
    width: 36px;
    height: 36px;
    border-radius: 6px;
    overflow: hidden;
    flex-shrink: 0;
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

/* ===== 按钮行 ===== */
.user-btn-row {
    display: flex;
    justify-content: flex-end;
    margin-top: 4px;
    gap: 2px;
    padding-right: 2px;
}

.user-msg-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 3px;
    color: var(--color-text-tertiary, #a8abb2);
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: color 0.15s ease;
    line-height: 0;
}

.user-msg-btn:hover {
    color: var(--color-text-secondary);
}

.user-msg-btn.copied {
    color: #22c55e;
}

.user-msg-btn.error {
    color: var(--color-error, #e74c3c);
}

/* ===== 编辑模式 ===== */
.edit-area {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.edit-input {
    width: 100%;
    min-width: 200px;
    padding: 6px 8px;
    font-size: 14px;
    line-height: 1.5;
    color: var(--color-text-primary);
    background: var(--color-bg-page);
    border: 1px solid var(--color-border-primary, #d0d0d0);
    border-radius: 4px;
    resize: vertical;
    font-family: inherit;
    outline: none;
}

.edit-input:focus {
    border-color: var(--color-primary, #4f46e5);
}

.edit-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
}

.edit-hint {
    font-size: 11px;
    color: var(--color-text-tertiary);
    margin-right: auto;
}

.edit-btn {
    padding: 2px 8px;
    font-size: 12px;
    border-radius: 4px;
    border: none;
    cursor: pointer;
    transition: background 0.15s;
}

.edit-btn.confirm {
    background: var(--color-primary, #4f46e5);
    color: #fff;
}

.edit-btn.confirm:hover {
    opacity: 0.85;
}

.edit-btn.cancel {
    background: transparent;
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border-primary);
}

.edit-btn.cancel:hover {
    background: var(--color-bg-surface, rgba(0,0,0,0.05));
}
</style>

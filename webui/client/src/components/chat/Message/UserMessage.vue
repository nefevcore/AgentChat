<!-- UserMessage.vue -->
<script setup lang="ts">
import type { ChatMessage } from '@/types';

defineProps<{
    message: ChatMessage;
    index: number;
    senderAvatar?: string | null;
    senderName?: string;
}>();
</script>

<template>
    <div class="message-item message-user">
        <div class="user-message">
            <div class="user-bubble">
                <p class="user-text">{{ message.content }}</p>
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

.user-bubble {
    background: var(--color-bg-user-container);
    border-radius: 6px;
    padding: 8px 12px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
    order: -1;
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
</style>

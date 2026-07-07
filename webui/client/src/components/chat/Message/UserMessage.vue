<!-- UserMessage.vue -->
<script setup lang="ts">
import type { ChatMessage } from '@/types';

defineProps<{
    message: ChatMessage;
    index: number;
}>();
</script>

<template>
    <div class="message-item message-user">
        <div class="user-message">
            <div class="user-bubble">
                <p class="user-text">{{ message.content }}</p>
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
    max-width: 70%;
}

.user-bubble {
    background: var(--color-bg-user-container);
    border-radius: 16px 16px 4px 16px;
    padding: 12px 16px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.user-text {
    font-size: 14px;
    line-height: 1.6;
    color: var(--color-text-primary);
    white-space: pre-wrap;
    word-break: break-word;
}

@media (max-width: 768px) {
    .user-message {
        max-width: 85%;
    }
}
</style>

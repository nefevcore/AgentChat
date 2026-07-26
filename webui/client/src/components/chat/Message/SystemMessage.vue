<!-- SystemMessage.vue - trigger 系统消息渲染 -->
<script setup lang="ts">
import { computed } from 'vue';
import type { ChatMessage } from '@/types';

const props = defineProps<{
    message: ChatMessage;
    index: number;
}>();

/** 提取 <trigger>...</trigger> 内部的纯文本内容 */
const triggerContent = computed(() => {
    const c = props.message.content;
    if (typeof c !== 'string') return c;
    const match = c.match(/^<trigger>([\s\S]*)<\/trigger>$/);
    return match ? match[1].trim() : c;
});
</script>

<template>
    <div class="message-item message-system">
        <span class="system-text">{{ triggerContent }}</span>
    </div>
</template>

<style scoped>
.message-system {
    display: flex;
    justify-content: center;
    padding: 4px 16px;
    margin: 2px 0;
}

.system-text {
    font-size: 13px;
    line-height: 1.7;
    color: var(--color-text-secondary, #8b8b8b);
    text-align: center;
    max-width: 70%;
}
</style>

<!-- TriggerMessage.vue —— 系统触发分隔符 -->
<script setup lang="ts">
import type { ChatMessage } from '@/domain/types';

defineProps<{ message: ChatMessage; index: number }>();
</script>

<template>
  <div class="trigger-message">
    <span class="trigger-text">{{ message.content }}</span>
  </div>
</template>

<style scoped>
.trigger-message {
  display: flex;
  justify-content: center;
  margin: 4px 0;
}
.trigger-text {
  font-size: 12px;
  color: var(--color-text-tertiary, #a8abb2);
  background: var(--color-bg-panel, #1e1e22);
  border: 1px dashed var(--color-border, rgba(255, 255, 255, 0.15));
  padding: 4px 14px;
  border-radius: 8px;
}
</style>

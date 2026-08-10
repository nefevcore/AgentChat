<!-- InteractionBar.vue —— ask_questions 决策选项条 -->
<script setup lang="ts">
import { useChatStore } from '@/stores/chat';

const chatStore = useChatStore();
</script>

<template>
  <Transition name="interaction">
    <div v-if="chatStore.interaction" class="interaction-bar">
      <div class="interaction-question">{{ chatStore.interaction.question }}</div>
      <div class="interaction-options">
        <button
          v-for="opt in chatStore.interaction.options"
          :key="opt"
          class="interaction-option"
          @click="chatStore.respondInteraction(opt)"
        >
          {{ opt }}
        </button>
        <button class="interaction-option dismiss" @click="chatStore.dismissInteraction()">取消</button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.interaction-bar {
  margin-bottom: 8px;
  padding: 10px 12px;
  border: 1px solid var(--color-primary, #6366f1);
  border-radius: 8px;
  background: var(--color-primary-soft, rgba(99, 102, 241, 0.08));
}
.interaction-question { font-size: 13px; color: var(--color-text-primary); margin-bottom: 8px; }
.interaction-options { display: flex; flex-wrap: wrap; gap: 6px; }
.interaction-option {
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.15));
  background: var(--color-bg-panel, #1e1e22);
  color: var(--color-text-primary);
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.interaction-option:hover { border-color: var(--color-primary, #6366f1); }
.interaction-option.dismiss { color: var(--color-text-tertiary, #a8abb2); }
.interaction-enter-active, .interaction-leave-active { transition: all 0.2s; }
.interaction-enter-from, .interaction-leave-to { opacity: 0; transform: translateY(-6px); }
</style>

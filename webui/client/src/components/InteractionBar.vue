<!-- InteractionBar.vue —— ask_user 决策选项列表（内嵌在输入框上方）
  Agent 通过 ask_user 工具请求用户决策时，在输入框上方显示选项列表。
  点击选项 → 直接作为回复发送；最后一项为输入框，用于输入自定义其他选项。 -->
<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { useChatStore } from '../stores/chat';

const chatStore = useChatStore();
const interaction = computed(() => chatStore.interaction);
const customInput = ref('');

// 超时自动关闭：后端超时后选项残留会"点了没反应"
let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
watch(interaction, (val) => {
  if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
  customInput.value = '';
  if (val?.timeout_ms) {
    timeoutTimer = setTimeout(() => {
      if (chatStore.interaction?.interaction_id === val.interaction_id) {
        chatStore.dismissInteraction();
      }
    }, val.timeout_ms);
  }
});
onUnmounted(() => { if (timeoutTimer) clearTimeout(timeoutTimer); });

/** 点击选项 → 作为回复发送 */
function choose(option: string) {
  chatStore.respondInteraction(option);
}

/** 提交自定义文本 */
function submitCustom() {
  const text = customInput.value.trim();
  if (text) chatStore.respondInteraction(text);
}
</script>

<template>
  <div v-if="interaction" class="interaction-bar">
    <div class="ib-header">
      <span class="ib-asker">{{ interaction.agent_id }}</span>
      <span class="ib-question">{{ interaction.question }}</span>
    </div>
    <div class="ib-list">
      <button
        v-for="(opt, i) in interaction.options"
        :key="i"
        class="ib-item"
        @click="choose(opt)"
      >
        <span class="ib-item-text">{{ opt }}</span>
        <span class="ib-item-arrow">›</span>
      </button>
      <!-- 最后一项：输入框提供其他选项 -->
      <div class="ib-item ib-item-custom">
        <input
          v-model="customInput"
          class="ib-custom-input"
          placeholder="输入其他选项…"
          @keyup.enter="submitCustom"
        />
        <button class="ib-custom-send" :disabled="!customInput.trim()" @click="submitCustom">回复</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.interaction-bar {
  border: 1px solid var(--color-primary-light, rgba(79, 70, 229, 0.3));
  border-radius: 10px;
  background: var(--color-primary-light, rgba(79, 70, 229, 0.05));
  padding: 10px 12px;
  margin-bottom: 8px;
}
.ib-header {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 8px;
}
.ib-asker {
  font-size: 12px; font-weight: 600;
  color: var(--color-primary, #6366f1);
  background: var(--color-primary-light, rgba(79, 70, 229, 0.12));
  padding: 2px 8px; border-radius: 10px;
  flex-shrink: 0;
}
.ib-question { font-size: 13px; color: var(--color-text-primary); }

/* 列表项选择 */
.ib-list {
  display: flex; flex-direction: column;
  gap: 2px;
  border: 1px solid var(--color-border-secondary, #e8e8e8);
  border-radius: 8px;
  overflow: hidden;
  background: var(--color-bg-page, #fff);
}
.ib-item {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px;
  padding: 9px 12px;
  border: none;
  border-bottom: 1px solid var(--color-border-secondary, #f0f0f0);
  background: transparent;
  color: var(--color-text-primary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s;
}
.ib-item:last-child { border-bottom: none; }
.ib-item:hover { background: var(--color-bg-surface, #f5f5f5); }
.ib-item:active { background: var(--color-primary-light, rgba(79, 70, 229, 0.08)); }
.ib-item-arrow { color: var(--color-text-muted); font-size: 14px; flex-shrink: 0; }

/* 自定义输入项 */
.ib-item-custom {
  display: flex; align-items: center; gap: 6px;
  background: var(--color-bg-surface, #fafafa);
  cursor: default;
  padding: 6px 8px;
}
.ib-item-custom:hover { background: var(--color-bg-surface, #fafafa); }
.ib-custom-input {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 6px;
  font-size: 13px;
  background: var(--color-bg-page, #fff);
  color: var(--color-text-primary);
  outline: none;
  transition: border-color 0.15s;
}
.ib-custom-input:focus { border-color: var(--color-primary, #6366f1); }
.ib-custom-send {
  padding: 6px 14px;
  border: none; border-radius: 6px;
  background: var(--color-primary, #6366f1);
  color: #fff; font-size: 13px;
  cursor: pointer;
  transition: opacity 0.15s;
}
.ib-custom-send:disabled { opacity: 0.4; cursor: not-allowed; }
</style>

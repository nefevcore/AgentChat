<!-- InteractionModal.vue —— ask_user 决策弹窗
  Agent 通过 ask_user 工具请求用户决策时弹出，用户选择后回传后端 -->
<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { useChatStore } from '../stores/chat';

const chatStore = useChatStore();
const interaction = computed(() => chatStore.interaction);
const customInput = ref('');
const showCustom = ref(false);

// 超时自动关闭：后端超时（默认 120s）后 pending 已删，弹窗残留会"点了没反应"
let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
watch(interaction, (val) => {
  if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
  if (val?.timeout_ms) {
    timeoutTimer = setTimeout(() => {
      if (chatStore.interaction?.interaction_id === val.interaction_id) {
        chatStore.dismissInteraction();
      }
    }, val.timeout_ms);
  }
});
onUnmounted(() => { if (timeoutTimer) clearTimeout(timeoutTimer); });

function choose(option: string) {
  chatStore.respondInteraction(option);
}

function submitCustom() {
  if (customInput.value.trim()) {
    chatStore.respondInteraction(customInput.value.trim());
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="interact-fade">
      <div v-if="interaction" class="interact-overlay">
        <div class="interact-modal">
          <div class="interact-header">
            <span class="interact-title">❓ {{ interaction.agent_id }} 需要你决策</span>
          </div>
          <div class="interact-question">{{ interaction.question }}</div>
          <div class="interact-options">
            <button
              v-for="(opt, i) in interaction.options"
              :key="i"
              class="interact-option"
              @click="choose(opt)"
            >{{ opt }}</button>
            <button
              v-if="interaction.allow_custom && !showCustom"
              class="interact-option interact-custom-toggle"
              @click="showCustom = true"
            >✏️ 自定义回答…</button>
          </div>
          <div v-if="showCustom" class="interact-custom">
            <input
              v-model="customInput"
              class="interact-custom-input"
              placeholder="输入你的回答…"
              @keyup.enter="submitCustom"
            />
            <button class="interact-custom-submit" @click="submitCustom">提交</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.interact-overlay {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0, 0, 0, 0.4);
  display: flex; align-items: center; justify-content: center;
}
.interact-modal {
  width: 420px; max-width: 90vw;
  background: var(--color-bg-page, #fff);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  padding: 20px 24px;
}
.interact-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.interact-title { font-size: 13px; font-weight: 600; color: var(--color-text-secondary); }
.interact-question {
  font-size: 15px; font-weight: 500; color: var(--color-text-primary);
  line-height: 1.6; margin-bottom: 16px; word-break: break-word;
}
.interact-options { display: flex; flex-direction: column; gap: 8px; }
.interact-option {
  padding: 10px 14px;
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 8px;
  background: var(--color-bg-surface, #fafafa);
  color: var(--color-text-primary);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.interact-option:hover {
  border-color: var(--color-primary, #6366f1);
  background: var(--color-primary-light, rgba(79, 70, 229, 0.06));
}
.interact-custom-toggle { border-style: dashed; color: var(--color-text-secondary); }
.interact-custom { display: flex; gap: 8px; margin-top: 12px; }
.interact-custom-input {
  flex: 1; padding: 8px 12px;
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 8px; font-size: 14px;
  background: var(--color-bg-page, #fff);
  color: var(--color-text-primary);
}
.interact-custom-submit {
  padding: 8px 16px;
  border: none; border-radius: 8px;
  background: var(--color-primary, #6366f1);
  color: #fff; font-size: 14px; cursor: pointer;
}
.interact-fade-enter-active, .interact-fade-leave-active { transition: opacity 0.2s; }
.interact-fade-enter-from, .interact-fade-leave-to { opacity: 0; }
</style>

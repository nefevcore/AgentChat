<!-- InteractionBar.vue —— ask_user 决策选项条（内嵌在输入框上方）
  Agent 通过 ask_user 工具请求用户决策时，在输入框上方显示选项。
  点击选项 → 直接作为回复发送；默认含"其他"选项用于输入自定义文本。 -->
<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { useChatStore } from '../stores/chat';

const chatStore = useChatStore();
const interaction = computed(() => chatStore.interaction);
const customInput = ref('');
const showCustom = ref(false);

// 超时自动关闭：后端超时后弹窗残留会"点了没反应"
let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
watch(interaction, (val) => {
  if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
  showCustom.value = false;
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
      <span class="ib-tip">（点击选项直接回复，或输入自定义）</span>
    </div>
    <div class="ib-options">
      <button
        v-for="(opt, i) in interaction.options"
        :key="i"
        class="ib-option"
        @click="choose(opt)"
      >{{ opt }}</button>
      <button
        v-if="!showCustom && (interaction.allow_custom || true)"
        class="ib-option ib-other"
        @click="showCustom = true"
      >✏️ 其他…</button>
    </div>
    <div v-if="showCustom" class="ib-custom">
      <input
        v-model="customInput"
        class="ib-custom-input"
        placeholder="输入自定义回复…"
        @keyup.enter="submitCustom"
      />
      <button class="ib-custom-submit" @click="submitCustom">回复</button>
      <button class="ib-custom-cancel" @click="showCustom = false">取消</button>
    </div>
  </div>
</template>

<style scoped>
.interaction-bar {
  border: 1px solid var(--color-primary-light, rgba(79, 70, 229, 0.3));
  border-radius: 10px;
  background: var(--color-primary-light, rgba(79, 70, 229, 0.06));
  padding: 10px 12px;
  margin-bottom: 8px;
}
.ib-header {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-bottom: 8px;
}
.ib-asker {
  font-size: 12px; font-weight: 600;
  color: var(--color-primary, #6366f1);
  background: var(--color-primary-light, rgba(79, 70, 229, 0.12));
  padding: 2px 8px; border-radius: 10px;
}
.ib-question { font-size: 13px; color: var(--color-text-primary); }
.ib-tip { font-size: 11px; color: var(--color-text-muted); }
.ib-options { display: flex; flex-wrap: wrap; gap: 6px; }
.ib-option {
  padding: 5px 12px;
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 14px;
  background: var(--color-bg-page, #fff);
  color: var(--color-text-primary);
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.ib-option:hover {
  border-color: var(--color-primary, #6366f1);
  background: var(--color-primary-light, rgba(79, 70, 229, 0.08));
}
.ib-other { border-style: dashed; color: var(--color-text-secondary); }
.ib-custom { display: flex; gap: 6px; margin-top: 8px; }
.ib-custom-input {
  flex: 1; padding: 6px 10px;
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 8px; font-size: 13px;
  background: var(--color-bg-page, #fff);
  color: var(--color-text-primary);
}
.ib-custom-submit {
  padding: 6px 14px; border: none; border-radius: 8px;
  background: var(--color-primary, #6366f1); color: #fff;
  font-size: 13px; cursor: pointer;
}
.ib-custom-cancel {
  padding: 6px 10px; border: none; border-radius: 8px;
  background: transparent; color: var(--color-text-secondary);
  font-size: 13px; cursor: pointer;
}
</style>

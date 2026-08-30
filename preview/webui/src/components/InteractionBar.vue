<!-- InteractionBar.vue —— ask_questions 决策弹窗（紧凑触发器 + 弹出菜单组）
  Agent 通过 ask_questions 工具请求用户决策时，输入框上方显示紧凑触发器（药丸，
  类似"更多"按钮的入口）；点击展开非全宽的弹出菜单组（下拉样式），选项即选即发，
  末尾为自定义输入框；点击外部 / 作答 / 超时自动关闭。 -->
<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useChatStore } from '../stores/chat';

const chatStore = useChatStore();
const interaction = computed(() => chatStore.interaction);
const customInput = ref('');
const menuOpen = ref(false);

/** 会话归属门控：interaction 是全局单槽（store 级），A 会话的决策弹窗会在
 *  用户切到 B 会话时照样弹出（跨会话串台；作答 choice 也会发到 A 的流程里，
 *  但 UI 上用户以为在回答 B）。仅当问题属于当前上下文的 Agent 时显示；
 *  无 agent_id 的旧载荷放行（兼容）。 */
const visible = computed(() => {
  const it = interaction.value;
  if (!it) return false;
  if (!it.agent_id) return true;
  return it.agent_id === (chatStore.resolveContext()?.agentId ?? '');
});

// 超时自动关闭：后端超时后选项残留会"点了没反应"
let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
watch(interaction, (val) => {
  if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
  customInput.value = '';
  if (!val) { menuOpen.value = false; return; }
  // 新交互到达自动展开一次（随后由用户开关 / 点击外部关闭）
  menuOpen.value = true;
  if (val.timeout_ms) {
    timeoutTimer = setTimeout(() => {
      if (chatStore.interaction?.interaction_id === val.interaction_id) {
        chatStore.dismissInteraction();
      }
    }, val.timeout_ms);
  }
});
onMounted(() => document.addEventListener('click', onDocClick));
onUnmounted(() => {
  document.removeEventListener('click', onDocClick);
  if (timeoutTimer) clearTimeout(timeoutTimer);
});
function onDocClick() { menuOpen.value = false; }

function toggle() { menuOpen.value = !menuOpen.value; }

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
  <div v-if="interaction && visible" class="interaction-bar">
    <!-- 紧凑触发器（类似"更多"按钮的入口；question 溢出省略） -->
    <button
      class="ib-trigger"
      :class="{ open: menuOpen }"
      @click.stop="toggle"
      :title="interaction.question"
    >
      <span class="ib-trigger-dot">●</span>
      <span class="ib-trigger-text">{{ interaction.question }}</span>
      <span class="ib-trigger-caret">▾</span>
    </button>

    <!-- 弹出菜单组（非全宽，宽度随内容；点击外部关闭） -->
    <Transition name="dropdown">
      <div v-if="menuOpen" class="ib-menu" @click.stop>
        <div class="ib-menu-header">
          <span class="ib-asker">{{ interaction.agent_id }}</span>
          <span class="ib-question">{{ interaction.question }}</span>
        </div>
        <button
          v-for="(opt, i) in interaction.options"
          :key="i"
          class="ib-item"
          @click="choose(opt)"
        >
          <span class="ib-item-text">{{ opt }}</span>
          <span class="ib-item-arrow">›</span>
        </button>
        <!-- 末尾：输入框提供其他选项 -->
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
    </Transition>
  </div>
</template>

<style scoped>
.interaction-bar {
  position: relative;
  display: flex;
  justify-content: flex-start;
  margin-bottom: 8px;
}

/* ── 紧凑触发器（药丸，非全宽） ── */
.ib-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 5px 12px;
  border: 1px solid var(--color-primary-light, rgba(79, 70, 229, 0.35));
  border-radius: 999px;
  background: var(--color-primary-light, rgba(79, 70, 229, 0.08));
  color: var(--color-primary, #6366f1);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.ib-trigger:hover { background: var(--color-primary-light, rgba(79, 70, 229, 0.14)); }
.ib-trigger.open {
  background: var(--color-primary-light, rgba(79, 70, 229, 0.16));
  border-color: var(--color-primary, #6366f1);
}
.ib-trigger-dot { font-size: 8px; flex-shrink: 0; }
.ib-trigger-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}
.ib-trigger-caret { font-size: 10px; flex-shrink: 0; opacity: 0.7; }

/* ── 弹出菜单组（非全宽：min 240 / max 340，宽度随内容） ── */
.ib-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  width: max-content;
  min-width: 240px;
  max-width: min(340px, 82vw);
  background: var(--bg-raised, var(--color-bg-page));
  border: 1px solid var(--line, var(--color-border-secondary));
  border-radius: 10px;
  box-shadow: var(--shadow-pop, 0 4px 16px rgba(0, 0, 0, 0.12));
  padding: 4px;
  z-index: 300;
}
.ib-menu-header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px 6px;
}
.ib-asker {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-primary, #6366f1);
  background: var(--color-primary-light, rgba(79, 70, 229, 0.12));
  padding: 1px 8px;
  border-radius: 999px;
  flex-shrink: 0;
  margin-top: 1px;
}
.ib-question {
  font-size: 13px;
  line-height: 1.45;
  color: var(--color-text-primary);
  word-break: break-word;
}

/* ── 选项（菜单项样式，对齐全站 dropdown-item） ── */
.ib-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--color-text-primary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.ib-item:hover { background: var(--role-hover-bg, var(--bg-hover)); }
.ib-item:active { background: var(--color-primary-light, rgba(79, 70, 229, 0.1)); }
.ib-item-arrow { color: var(--color-text-muted); font-size: 14px; flex-shrink: 0; }

/* ── 自定义输入项 ── */
.ib-item-custom {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: default;
  padding: 6px 8px;
}
.ib-item-custom:hover { background: none; }
.ib-custom-input {
  flex: 1;
  min-width: 0;
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
  padding: 6px 12px;
  border: none;
  border-radius: 6px;
  background: var(--color-primary, #6366f1);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 0.15s;
}
.ib-custom-send:disabled { opacity: 0.4; cursor: not-allowed; }

/* ── 弹出过渡（对齐全站 dropdown/menu-fade） ── */
.dropdown-enter-active, .dropdown-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.dropdown-enter-from, .dropdown-leave-to { opacity: 0; transform: translateY(-4px); }
</style>

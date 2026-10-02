<!--
  webui-kit/src/base/Button.vue —— 基础按钮（令牌驱动，双主题自适应）
  variant: primary / soft（**已定案收编进 ghost**，见下）/ ghost / danger
  size: sm / md（高度取 --ctl-h-sm/md，勿再写裸 px）

  soft 收编说明（cr-121）：全仓 soft 仅 2 处显式使用（ghost 26 处），提案
  判为「同 recipe 双源」。执行顺序须为「先全仓 codemod → 再删变体」，且默认
  值当前是 soft（17 个文件走默认），故本批只登记 deprecation、不动渲染——
  改渲染必须与 P1 批次的视觉对照同时做。
-->
<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  /** @deprecated 收编进 'ghost'（P1 批次执行删除；新代码直接用 ghost） */
  variant?: 'primary' | 'soft' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  icon?: string;
  disabled?: boolean;
  loading?: boolean;
}>(), { variant: 'soft', size: 'md', disabled: false, loading: false });

const classes = computed(() => [
  'ui-btn',
  `ui-btn--${props.variant}`,
  `ui-btn--${props.size}`,
]);
</script>

<template>
  <button
    class="ui-btn"
    :class="classes"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <span v-if="loading" class="ui-btn-spinner" />
    <Icon v-else-if="icon" :name="icon" :size="size === 'sm' ? 14 : 16" />
    <span v-if="$slots.default" class="ui-btn-label"><slot /></span>
  </button>
</template>

<style scoped>
.ui-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: 0; cursor: pointer; border-radius: var(--r-md);
  font-family: var(--font-ui); font-size: var(--fs-md); font-weight: 500;
  color: var(--text-2); background: transparent;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast), box-shadow var(--dur-fast), transform var(--dur-fast) var(--ease-out);
  white-space: nowrap; user-select: none;
}
.ui-btn--sm { height: var(--ctl-h-sm); padding: 0 10px; font-size: var(--fs-sm); }
.ui-btn--md { height: var(--ctl-h-md); padding: 0 14px; }
.ui-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.ui-btn--primary { color: var(--on-primary); background: var(--primary); border-radius: var(--r-md); box-shadow: var(--shadow-pop); }
.ui-btn--primary:hover:not(:disabled) { background: var(--primary-strong); box-shadow: var(--shadow-primary-hover); }
.ui-btn--primary:active:not(:disabled) { transform: scale(0.97); }

.ui-btn--soft { background: var(--bg-hover); color: var(--text-1); }
.ui-btn--soft:hover:not(:disabled) { background: var(--bg-hover); color: var(--primary); }

.ui-btn--ghost:hover:not(:disabled) { background: var(--bg-hover); color: var(--primary); }

.ui-btn--danger { background: rgba(var(--err-rgb), 0.14); color: var(--err); }
.ui-btn--danger:hover:not(:disabled) { background: rgba(var(--err-rgb), 0.24); }

.ui-btn-spinner {
  width: 12px; height: 12px; border-radius: var(--r-full);
  /* 回退（cr-32）：currentColor 无法派生 RGB 三元组（任意色上下文），
     故轨道环用中性灰——仅 ◯ 弧（border-top-color: currentColor）是主视觉 */
  border: 2px solid rgba(var(--text-3-rgb), 0.32);
  border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
  border-top-color: currentColor; animation: ui-spin calc(0.7s * var(--motion-scale)) linear infinite;
}
@keyframes ui-spin { to { transform: rotate(360deg); } }
</style>

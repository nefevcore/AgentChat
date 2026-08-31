<!--
  ui/Button.vue —— 基础按钮（令牌驱动，双主题自适应）
  variant: primary（渐变发光）/ soft（浅色底）/ ghost（透明）/ danger
  size: sm / md
-->
<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
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
  font-family: var(--font-ui); font-size: 13px; font-weight: 500;
  color: var(--text-2); background: transparent;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast), box-shadow var(--dur-fast), transform var(--dur-fast) var(--ease-out);
  white-space: nowrap; user-select: none;
}
.ui-btn--sm { height: 28px; padding: 0 10px; font-size: 12px; }
.ui-btn--md { height: 32px; padding: 0 14px; }
.ui-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.ui-btn--primary { color: #fff; background: var(--primary); border-radius: var(--r-md); box-shadow: var(--shadow-primary); }
.ui-btn--primary:hover:not(:disabled) { background: var(--primary-strong); box-shadow: 0 6px 22px rgba(99, 102, 241, 0.32); }
.ui-btn--primary:active:not(:disabled) { transform: scale(0.97); }

.ui-btn--soft { background: var(--bg-hover); color: var(--text-1); }
.ui-btn--soft:hover:not(:disabled) { background: var(--bg-hover); color: var(--primary); }

.ui-btn--ghost:hover:not(:disabled) { background: var(--bg-hover); color: var(--primary); }

.ui-btn--danger { background: color-mix(in srgb, var(--err) 14%, transparent); color: var(--err); }
.ui-btn--danger:hover:not(:disabled) { background: color-mix(in srgb, var(--err) 24%, transparent); }

.ui-btn-spinner {
  width: 12px; height: 12px; border-radius: var(--r-full);
  border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
  border-top-color: currentColor; animation: ui-spin 0.7s linear infinite;
}
@keyframes ui-spin { to { transform: rotate(360deg); } }
</style>

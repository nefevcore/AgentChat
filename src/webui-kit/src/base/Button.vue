<!--
  webui-kit/src/base/Button.vue —— 基础按钮（令牌驱动，双主题自适应）
  variant: primary / ghost / danger
  size: sm / md（高度取 --ctl-h-sm/md，勿再写裸 px）

  soft 变体已收编进 ghost（cr-121 定案，cr-179 落地）：全仓 19 处调用
  codemod 至 ghost 后删型删配方——soft 与 ghost 唯一差异是常态底色
  （bg-hover vs 透明），hover 态本就一致。
-->
<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  icon?: string;
  disabled?: boolean;
  loading?: boolean;
}>(), { variant: 'ghost', size: 'md', disabled: false, loading: false });

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

.ui-btn--ghost:hover:not(:disabled) { background: var(--bg-hover); color: var(--primary); }

.ui-btn--danger { background: rgba(var(--err-rgb), 0.14); color: var(--err); }
.ui-btn--danger:hover:not(:disabled) { background: rgba(var(--err-rgb), 0.24); }

.ui-btn-spinner {
  width: 12px; height: 12px; border-radius: var(--r-full);
  /* 回退（cr-32）：currentColor 无法派生 RGB 三元组（任意色上下文），
     故轨道环用中性灰——仅 ◯ 弧（border-top-color: currentColor）是主视觉 */
  border: 2px solid rgba(var(--text-3-rgb), 0.32);
  border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
  /* cr-161：loading 是功能语义（承 cr-149 BusyRing 先例）——不经 --motion-scale，
     系统「减少动态」下仍旋转（静止的环被读作卡死） */
  border-top-color: currentColor; animation: ui-spin 0.7s linear infinite;
}
@keyframes ui-spin { to { transform: rotate(360deg); } }
</style>

<!--
  webui-kit/src/base/IconAction.vue —— 小图标动作钮（cr-157）
  归一：9 处自建关闭钮（fpp-tab-close / wsp-tab-close / chip-x / drawer-close-btn /
  modal 内嵌 x 等）与 Tab 尾随 chevron 触发。视觉 16px、透明覆盖层撑命中区到 --hit-min。
-->
<script setup lang="ts">
import Icon from './Icon.vue';

withDefaults(defineProps<{
  icon?: string; // 图标名（icons.ts 注册名）
  label: string; // 无文本钮必须有 aria-label（title 见 suppressTitle）
  size?: number;
  suppressTitle?: boolean; // 外层 kit Tooltip 已供视觉提示时置 true——去掉原生 title 防双显；aria-label 恒保留
}>(), { icon: 'x', size: 14, suppressTitle: false });

const emit = defineEmits<{ click: [] }>();
</script>

<template>
  <button
    type="button" class="ui-icon-action"
    :aria-label="label" :title="suppressTitle ? undefined : label"
    @click.stop="emit('click')"
  >
    <Icon :name="icon" :size="size" />
  </button>
</template>

<style scoped>
.ui-icon-action {
  position: relative; display: grid; place-items: center;
  width: 22px; height: 22px; border: none; background: none;
  border-radius: var(--r-sm); color: var(--text-3); cursor: pointer; flex-shrink: 0;
}
.ui-icon-action::after { content: ''; position: absolute; inset: -1px; border-radius: var(--r-sm); }
.ui-icon-action:hover { background: var(--bg-hover); color: var(--text-1); }
.ui-icon-action:focus-visible { outline: var(--focus-ring-width) solid var(--focus-ring); outline-offset: var(--focus-ring-offset); }
</style>
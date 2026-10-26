<!--
  webui-kit/src/base/Chip.vue —— 可移除标签胶囊（cr-157）
  归一：ChatInput .file-chip（输入区附件）与 UserMessage .user-file-chip（消息内附件）。
  dim 态 = 中性（消息内）；默认态 = 主色 tint（输入区）。
-->
<script setup lang="ts">
import Icon from './Icon.vue';

withDefaults(defineProps<{
  icon?: string;
  /** 中性形态（消息内附件）；缺省主色 tint（输入区附件） */
  dim?: boolean;
  removable?: boolean;
}>(), { dim: false, removable: false });

const emit = defineEmits<{ remove: [] }>();
</script>

<template>
  <span class="ui-chip" :class="{ dim }">
    <Icon v-if="icon" :name="icon" :size="12" />
    <span class="ui-chip-label"><slot /></span>
    <button v-if="removable" type="button" class="ui-chip-x" aria-label="移除" @click.stop="emit('remove')">
      <Icon name="x" :size="10" />
    </button>
  </span>
</template>

<style scoped>
.ui-chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  padding: 4px 6px 4px 10px; border-radius: var(--r-full);
  border: 1px solid var(--primary-border);
  background: var(--primary-light);
  font-size: var(--fs-sm); color: var(--text-1);
}
.ui-chip.dim { border-color: var(--line); background: var(--bg-raised); }
.ui-chip.dim:hover { border-color: var(--primary); }
.ui-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-chip-x {
  position: relative; display: grid; place-items: center;
  width: 16px; height: 16px; border: none; background: none;
  border-radius: 50%; color: var(--text-3); cursor: pointer; flex-shrink: 0;
}
.ui-chip-x::after { content: ''; position: absolute; inset: -4px; } /* 命中区撑到 --hit-min */
.ui-chip-x:hover { background: rgba(var(--text-3-rgb), 0.15); color: var(--text-1); }
</style>
<!--
  webui-kit/src/base/ConfirmBody.vue —— 确认弹体（Modal 内容件，cr-157）
  归一：AgentHeaderActions / SingleHeaderActions / GroupDrawer .delete-dialog（三份同 recipe
  居中排版）与 StorageHost .confirm-body（左对齐表单式）。居中形态用于破坏性确认；
  左对齐经 align=left（表单提交确认）。
-->
<script setup lang="ts">
import Button from './Button.vue';

withDefaults(defineProps<{
  title: string;
  text?: string;
  confirmText?: string;
  cancelText?: string;
  /** 破坏性确认（确认钮 danger） */
  danger?: boolean;
  /** 左对齐表单式（缺省居中） */
  align?: 'center' | 'left';
  busy?: boolean;
}>(), { confirmText: '确认', cancelText: '取消', danger: false, align: 'center', busy: false });

const emit = defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
  <div class="ui-confirm" :class="align">
    <h4>{{ title }}</h4>
    <p v-if="text">{{ text }}</p>
    <slot />
    <div class="ui-confirm-act">
      <Button variant="ghost" size="sm" :disabled="busy" @click="emit('cancel')">{{ cancelText }}</Button>
      <Button variant="danger" size="sm" :loading="busy" @click="emit('confirm')">{{ confirmText }}</Button>
    </div>
  </div>
</template>

<style scoped>
.ui-confirm.center { padding: 28px 24px 20px; text-align: center; display: flex; flex-direction: column; gap: 0; }
.ui-confirm.left { padding: 6px 20px 2px; text-align: left; display: flex; flex-direction: column; gap: var(--space-2); }
.ui-confirm h4 { margin: 0 0 8px; font-size: var(--fs-lg); font-weight: 600; color: var(--text-1); }
.ui-confirm p { margin: 0 0 4px; font-size: var(--fs-md); color: var(--text-2); line-height: var(--lh-base); }
.ui-confirm-act { display: flex; justify-content: center; gap: 10px; margin-top: 14px; }
.ui-confirm.left .ui-confirm-act { justify-content: flex-end; }
</style>
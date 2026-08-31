<script setup lang="ts">
// ============================================================
// ConfirmDialog.vue —— 通用确认弹窗（替代原生 confirm，基于 ui/Modal 统一外壳）
// 用法：<ConfirmDialog ref="confirmRef" />；const ok = await confirmRef.ask({...})
// ============================================================
import { ref } from 'vue';
import { Modal, Button } from '@/ui';

interface ConfirmOpts {
  title: string;
  message: string;
  confirmLabel?: string;
  /** 危险操作：主按钮红色（如删除/放弃更改） */
  danger?: boolean;
}

const state = ref<(ConfirmOpts & { confirmLabel: string }) | null>(null);
let resolveFn: ((v: boolean) => void) | null = null;

/** 弹出确认框，返回 Promise<boolean>（确认 true / 取消或关闭 false） */
function ask(opts: ConfirmOpts): Promise<boolean> {
  state.value = { ...opts, confirmLabel: opts.confirmLabel ?? '确定' };
  return new Promise((res) => { resolveFn = res; });
}
function settle(v: boolean): void {
  resolveFn?.(v);
  resolveFn = null;
  state.value = null;
}
defineExpose({ ask });
</script>

<template>
  <Modal :visible="!!state" :title="state?.title ?? ''" :width="440" :z-index="1200" @close="settle(false)">
    <div class="cd-body"><div class="cd-msg">{{ state?.message }}</div></div>
    <template #footer>
      <Button variant="ghost" @click="settle(false)">取消</Button>
      <Button :variant="state?.danger ? 'danger' : 'primary'" @click="settle(true)">{{ state?.confirmLabel }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.cd-body { padding: 14px 20px; }
.cd-msg { font-size: 13px; line-height: 1.6; color: var(--text-1); white-space: pre-line; }
</style>

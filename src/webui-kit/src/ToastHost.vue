<!-- ToastHost.vue —— 全局 Toast 栈渲染半件（AppFrame 挂载一次）
  消费 toast.ts 单例栈：右下角浮层栈。图标/配色按 tone 派生（与
  FeedbackNotice 同轴：ok=check-circle/success · error=alert-circle/
  error · info=info/弱化 · busy=loader-circle 旋转/primary）。hover
  暂停由 toast.ts pause/resume 承担。z-index 9500：低于更多菜单
  (9999) 与 FilePreview(10000)，盖过其余内容与设置域弹窗(1200)——
  全局反馈须对任何面板可见，但不与全屏预览/菜单抢顶层。 -->
<script setup lang="ts">
import { toasts, dismissToast, pauseToast, resumeToast } from './toast.ts';
import Icon from './Icon.vue';

const TONE_ICON = { ok: 'check-circle', error: 'alert-circle', info: 'info', busy: 'loader-circle' } as const;
</script>

<template>
  <Teleport to="body">
    <div class="toast-stack" role="status" aria-live="polite">
      <TransitionGroup name="toast">
        <div
          v-for="t in toasts"
          :key="t.id"
          class="toast-item"
          :class="`is-${t.tone}`"
          @mouseenter="pauseToast(t.id)"
          @mouseleave="resumeToast(t.id)"
        >
          <Icon :name="TONE_ICON[t.tone]" :size="14" class="toast-icon" />
          <span class="toast-text">{{ t.text }}</span>
          <button class="toast-close" title="关闭" @click="dismissToast(t.id)"><Icon name="x" :size="12" /></button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 9500;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none; /* 栈容器不拦交互；条目自身恢复 */
}

.toast-item {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: min(420px, calc(100vw - 32px));
  padding: 8px 10px;
  border-radius: var(--r-lg);
  background: var(--bg-raised);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-panel);
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-1);
}

.toast-icon { flex-shrink: 0; margin-top: 1px; }
.toast-text { min-width: 0; word-break: break-word; }

.toast-close {
  flex-shrink: 0;
  border: 0;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: var(--r-sm);
  margin: -1px -2px 0 0;
}
.toast-close:hover { background: var(--bg-hover, rgba(127, 127, 127, 0.12)); color: var(--text-1); }

/* 语义配色（左缘描边 + 图标着色——文本恒主色保证可读） */
.is-ok .toast-icon { color: var(--ok, #10b981); }
.is-error .toast-icon { color: var(--err, #ef4444); }
.is-info .toast-icon { color: var(--text-3); }
.is-busy .toast-icon { color: var(--primary, #6366f1); animation: toast-spin 0.8s linear infinite; }

.is-ok { border-left: 3px solid var(--ok, #10b981); }
.is-error { border-left: 3px solid var(--err, #ef4444); }
.is-info { border-left: 3px solid var(--line-strong); }
.is-busy { border-left: 3px solid var(--primary, #6366f1); }

.toast-enter-active, .toast-leave-active { transition: all 0.18s var(--ease-out); }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(12px); }

@keyframes toast-spin { to { transform: rotate(360deg); } }
</style>

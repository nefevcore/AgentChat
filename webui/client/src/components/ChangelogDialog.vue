<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const loading = ref(false);
const content = ref('');
const error = ref('');

watch(() => props.visible, async (v) => {
  if (!v) return;
  if (content.value) return; // 已加载过，不重复请求
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/version/changelog');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    content.value = data.content || '';
  } catch (err: any) {
    error.value = err.message || '加载失败';
  } finally {
    loading.value = false;
  }
});

/** 将 Markdown # ## ### 转为 HTML 的简易渲染 */
function renderChangelog(md: string): string {
  return md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // 标题
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    // 列表项
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    // 包裹相邻 <li> 在 <ul> 中
    .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
    // 段落
    .replace(/^(?!<[hul/])(.+)$/gm, '<p>$1</p>')
    // bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // 清理空行
    .replace(/\n{2,}/g, '\n');
}
</script>

<template>
  <Transition name="modal">
    <div v-if="visible" class="changelog-overlay" @mousedown.self="emit('close')">
      <div class="changelog-panel" @click.stop>
        <div class="panel-header">
          <h3>更新日志</h3>
          <button class="close-btn" @click="emit('close')" title="关闭">×</button>
        </div>
        <div class="panel-body">
          <div v-if="loading" class="status-msg">加载中...</div>
          <div v-else-if="error" class="status-msg error">{{ error }}</div>
          <div
            v-else
            class="changelog-content"
            v-html="renderChangelog(content)"
          />
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.changelog-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.3);
  display: flex; align-items: center; justify-content: center;
  z-index: 1001;
}
.changelog-panel {
  background: var(--color-bg-page, #fff);
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 10px;
  width: 600px;
  max-width: 90vw;
  max-height: 75vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0,0,0,0.12);
}
.panel-header {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--color-border-secondary, #e0e0e0);
  flex-shrink: 0;
}
.panel-header h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--color-text-primary, #2c3e50); }
.close-btn { margin-left: auto; background: none; border: none; color: var(--color-text-secondary, #7f8c8d); font-size: 18px; cursor: pointer; padding: 0 4px; line-height: 1; }
.close-btn:hover { color: var(--color-text-primary, #2c3e50); }
.panel-body { flex: 1; overflow-y: auto; padding: 16px 20px; }
.status-msg { text-align: center; padding: 32px; color: var(--color-text-secondary, #999); font-size: 14px; }
.status-msg.error { color: #e74c3c; }

.changelog-content {
  font-size: 14px;
  line-height: 1.7;
  color: var(--color-text-primary, #2c3e50);
}
.changelog-content :deep(h2) {
  font-size: 18px; font-weight: 700;
  margin: 12px 0 8px;
  border-bottom: 1px solid var(--color-border-secondary, #e0e0e0);
  padding-bottom: 4px;
}
.changelog-content :deep(h3) {
  font-size: 15px; font-weight: 600;
  margin: 16px 0 6px;
  color: var(--color-primary, #6366f1);
}
.changelog-content :deep(h4) {
  font-size: 13px; font-weight: 600;
  margin: 10px 0 4px;
  color: var(--color-text-secondary, #7f8c8d);
}
.changelog-content :deep(ul) {
  margin: 4px 0 8px;
  padding-left: 20px;
}
.changelog-content :deep(li) {
  margin: 2px 0;
}
.changelog-content :deep(p) {
  margin: 4px 0;
}
.changelog-content :deep(code) {
  background: var(--color-bg-surface, #f5f5f5);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 13px;
}
.changelog-content :deep(strong) {
  font-weight: 600;
}

/* Transition */
.modal-enter-active, .modal-leave-active {
  transition: opacity 0.2s ease;
}
.modal-enter-active .changelog-panel, .modal-leave-active .changelog-panel {
  transition: transform 0.2s ease;
}
.modal-enter-from, .modal-leave-to {
  opacity: 0;
}
.modal-enter-from .changelog-panel {
  transform: scale(0.95);
}
.modal-leave-to .changelog-panel {
  transform: scale(0.95);
}
</style>

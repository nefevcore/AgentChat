<script setup lang="ts">
import ScrollableViewport from '@/components/chat/ScrollableViewport.vue';
import { ref } from 'vue';

const props = defineProps<{ data: Record<string, unknown> }>();

const filePath = String(props.data.path || '');
const fileName = filePath.split(/[/\\]/).pop() || filePath;
const showModal = ref(false);
const content = ref('');
const loading = ref(false);
const error = ref('');

function open() {
  showModal.value = true;
  if (content.value || error.value) return;
  loading.value = true;
  fetch(`/api/browse/read-file?path=${encodeURIComponent(filePath)}`)
    .then(r => r.json())
    .then(json => {
      if (json.success) content.value = json.content;
      else error.value = json.error || '读取失败';
    })
    .catch((e: any) => { error.value = e.message; })
    .finally(() => { loading.value = false; });
}

defineExpose({ open });
</script>

<template>
  <!-- 内联文件名链接（在 ToolMessage body 中展示） -->
  <span class="write-link" @click.stop="open" :title="filePath">{{ fileName }}</span>

  <!-- 全屏弹窗 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="showModal" class="dialog-overlay" @mousedown.self="showModal = false">
        <div class="write-dialog" @click.stop>
          <!-- 头部 -->
          <div class="write-dialog-header">
            <div class="write-dialog-title-row">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="file-icon">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
              </svg>
              <span class="write-dialog-path">{{ filePath }}</span>
            </div>
            <button class="write-dialog-close" @click="showModal = false" title="关闭">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <!-- 正文 -->
          <div class="write-dialog-body">
            <div v-if="loading" class="write-dialog-msg">加载中...</div>
            <div v-else-if="error" class="write-dialog-msg write-dialog-err">{{ error }}</div>
            <ScrollableViewport v-else max-height="calc(85vh - 100px)">
              <pre><code>{{ content }}</code></pre>
            </ScrollableViewport>
          </div>

          <!-- 底部 -->
          <div class="write-dialog-footer">
            <span class="write-dialog-info">{{ content ? `${content.length.toLocaleString()} 字符` : '' }}</span>
            <button class="write-dialog-btn" @click="showModal = false">关闭</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 内联链接 */
.write-link {
  font-size: 13px; color: var(--color-accent, #4a90d9); cursor: pointer;
  font-family: 'SF Mono', 'Consolas', monospace;
  text-decoration: underline; text-underline-offset: 2px;
}
.write-link:hover { opacity: 0.8; }

/* ═══ 弹窗 — 对齐系统 dialog-overlay 风格 ═══ */
.dialog-overlay {
  position: fixed; inset: 0; z-index: 600;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.35);
}
.write-dialog {
  background: var(--color-bg-page); border-radius: 12px;
  width: min(92vw, 960px); max-height: 90vh;
  display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 12px 48px rgba(0,0,0,0.18);
}
.write-dialog-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--color-border-secondary);
  flex-shrink: 0; gap: 12px;
}
.write-dialog-title-row {
  display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;
}
.file-icon {
  flex-shrink: 0; color: var(--color-text-tertiary);
}
.write-dialog-path {
  font-size: 13px; font-family: 'SF Mono', 'Consolas', monospace;
  color: var(--color-text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.write-dialog-close {
  display: flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border: none; border-radius: 6px;
  background: none; color: var(--color-text-tertiary); cursor: pointer; flex-shrink: 0;
}
.write-dialog-close:hover { background: var(--color-bg-hover); color: var(--color-text-primary); }

.write-dialog-body { padding: 16px 18px; overflow: auto; flex: 1; }
.write-dialog-body pre {
  margin: 0; font-size: 13px; line-height: 1.7;
  white-space: pre-wrap; word-break: break-word;
  font-family: 'SF Mono', 'Consolas', monospace;
  color: var(--color-text-primary);
}
.write-dialog-msg { font-size: 13px; color: var(--color-text-secondary); padding: 8px 0; }
.write-dialog-err { color: var(--color-error, #e74c3c); }

.write-dialog-footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 18px; border-top: 1px solid var(--color-border-secondary);
  flex-shrink: 0;
}
.write-dialog-info { font-size: 11px; color: var(--color-text-tertiary); }
.write-dialog-btn {
  padding: 6px 16px; border: 1px solid var(--color-border-secondary); border-radius: 6px;
  background: var(--color-bg-page); color: var(--color-text-secondary); font-size: 12px; cursor: pointer;
}
.write-dialog-btn:hover { background: var(--color-bg-surface); color: var(--color-text-primary); }

/* Transition */
.modal-enter-active, .modal-leave-active { transition: opacity 0.15s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>

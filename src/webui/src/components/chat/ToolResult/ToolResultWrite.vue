<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMarkdown } from '@/composables/useMarkdown';
import { Modal } from '@/ui';
import { browseReadFile } from '../../../api/files';

const props = defineProps<{ data: Record<string, unknown>; loading?: boolean }>();

// 响应式：props.data 流式期间会被替换（此前一次性常量取不到后续到达的 path）
const filePath = computed(() => String(props.data.path || props.data.filePath || ''));
const fileName = computed(() => filePath.value.split(/[/\\]/).pop() || filePath.value);
const showModal = ref(false);
const content = ref('');
const loading = ref(false);
const error = ref('');

// ── 语言检测 ──
const lang = computed(() => {
  const ext = filePath.value.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    py: 'python', ts: 'typescript', js: 'javascript', jsx: 'javascript',
    vue: 'html', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    html: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
    md: 'markdown', sh: 'bash', bash: 'bash', ps1: 'powershell',
    xml: 'xml', sql: 'sql', rs: 'rust', go: 'go', java: 'java',
    cpp: 'cpp', cxx: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
    txt: 'text', log: 'text', cfg: 'ini', ini: 'ini',
    env: 'bash', dockerfile: 'dockerfile', makefile: 'makefile',
    bat: 'dos', cmd: 'dos',
  };
  return map[ext || ''] || '';
});

const langDisplay = computed(() => {
  const display: Record<string, string> = {
    python: 'Python', typescript: 'TypeScript', javascript: 'JavaScript',
    html: 'Vue/HTML', json: 'JSON', yaml: 'YAML', toml: 'TOML',
    css: 'CSS', scss: 'SCSS', markdown: 'Markdown', bash: 'Bash',
    powershell: 'PowerShell', xml: 'XML', sql: 'SQL', rust: 'Rust',
    go: 'Go', java: 'Java', cpp: 'C++', c: 'C', ruby: 'Ruby',
    php: 'PHP', swift: 'Swift', kotlin: 'Kotlin',
    text: '纯文本', dockerfile: 'Dockerfile', ini: 'INI', dos: 'Batch',
  };
  return display[lang.value] || lang.value.toUpperCase() || '纯文本';
});

// ── 语法高亮渲染 ──
const { render } = useMarkdown();
/** 动态围栏：内容含 ``` 时升级更长的围栏（读 .md 文件内嵌 fence 必现截断错乱） */
function fenceOf(code: string): string {
  let fence = '```';
  while (code.includes(fence)) fence += '`';
  return fence;
}
const renderedContent = computed(() => {
  if (!content.value) return '';
  const fence = fenceOf(content.value);
  return render(`${fence}${lang.value || ''}\n${content.value}\n${fence}`);
});

// ── 复制 ──
const copyState = ref<'idle' | 'copied'>('idle');
let copyTimer: ReturnType<typeof setTimeout> | null = null;
async function copyContent() {
  try {
    await navigator.clipboard.writeText(content.value);
    copyState.value = 'copied';
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copyState.value = 'idle'; }, 2000);
  } catch { /* ignore */ }
}

// ── 加载 ──
function open() {
  showModal.value = true;
  if (content.value || loading.value) return;
  // 失败后允许重试（此前 error 非空即短路，失败一次永远无法再打开）
  error.value = '';
  loading.value = true;
  browseReadFile(filePath.value)
    .then(json => {
      if (json.content) content.value = json.content;
      else error.value = json.error || '读取失败';
    })
    .catch((e: any) => { error.value = e.message; })
    .finally(() => { loading.value = false; });
}

defineExpose({ open });
</script>

<template>
  <span class="write-link" @click.stop="open" :title="filePath">{{ fileName }}</span>

  <Modal :visible="showModal" :width="1000" @close="showModal = false">
    <div class="write-dialog">
          <!-- 头部 -->
          <div class="code-header">
            <div class="code-header-left">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="code-file-icon">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              <span class="code-file-name">{{ filePath }}</span>
              <span v-if="lang" class="code-lang-badge">{{ langDisplay }}</span>
            </div>
            <div class="code-header-right">
              <span v-if="content" class="code-meta-badge">{{ content.length.toLocaleString() }} 字符</span>
              <button class="code-copy-btn" :class="{ copied: copyState === 'copied' }" @click="copyContent" :disabled="!content" title="复制全部内容">
                <svg v-if="copyState !== 'copied'" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                <span>{{ copyState === 'copied' ? '已复制' : '复制' }}</span>
              </button>
              <button class="write-dialog-close" @click="showModal = false" title="关闭">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>

          <!-- 正文 -->
          <div class="write-dialog-body">
            <div v-if="loading" class="write-dialog-msg">加载中...</div>
            <div v-else-if="error" class="write-dialog-msg write-dialog-err">{{ error }}</div>
            <div v-else class="code-area" v-html="renderedContent" />
          </div>
      </div>
    </Modal>
</template>

<style scoped>
.write-link {
  font-size: 12px; color: var(--color-accent, #4a90d9); cursor: pointer;
  font-family: 'SF Mono', 'Consolas', monospace;
  text-decoration: underline; text-underline-offset: 2px;
}
.write-link:hover { opacity: 0.8; }

.write-dialog {
  max-height: 90vh;
  display: flex; flex-direction: column; overflow: hidden;
}

.code-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px; gap: 12px; flex-shrink: 0;
  background: var(--color-bg-surface);
  border-bottom: 1px solid var(--color-border-secondary);
}
.code-header-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.code-header-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.code-file-icon { color: var(--color-text-tertiary); flex-shrink: 0; }
.code-file-name {
  font-size: 12px; font-weight: 600;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.code-lang-badge {
  font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
  padding: 2px 7px; border-radius: 4px; background: var(--color-primary); color: #fff;
  flex-shrink: 0; opacity: 0.85;
}
.code-meta-badge {
  font-size: 11px; color: var(--color-text-tertiary); padding: 2px 6px;
  border-radius: 4px; background: var(--color-bg-page);
  border: 1px solid var(--color-border-secondary); white-space: nowrap;
}
.code-copy-btn {
  display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px;
  font-size: 11px; font-weight: 500; color: var(--color-text-secondary);
  background: var(--color-bg-page); border: 1px solid var(--color-border-secondary);
  border-radius: 5px; cursor: pointer; transition: all 0.15s; white-space: nowrap;
}
.code-copy-btn:hover { color: var(--color-text-primary); background: var(--color-bg-surface); }
.code-copy-btn:disabled { opacity: 0.4; cursor: default; }
.code-copy-btn.copied { color: #22c55e; border-color: #22c55e; background: rgba(34,197,94,0.08); }

.write-dialog-close {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: none; border-radius: 6px;
  background: none; color: var(--color-text-tertiary); cursor: pointer; flex-shrink: 0;
}
.write-dialog-close:hover { background: var(--color-bg-hover); color: var(--color-text-primary); }

.write-dialog-body { flex: 1; overflow: auto; background: var(--color-code-bg, #1e1e2e); }
.write-dialog-msg { font-size: 12px; color: var(--color-text-secondary); padding: 20px; }
.write-dialog-err { color: var(--color-error, #e74c3c); }

.code-area :deep(.md-code-block) { margin: 0; border-radius: 0; background: transparent; }
.code-area :deep(.md-code-block-banner) { display: none; }
.code-area :deep(.md-code-block pre) {
  margin: 0; border-radius: 0; padding: 20px 24px;
  background: var(--color-code-bg, #1e1e2e);
}
.code-area :deep(.md-code-block pre code) {
  font-size: 12px; line-height: 1.65;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
}

.modal-enter-active, .modal-leave-active { transition: opacity 0.15s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>

<!-- FilePreviewModal.vue —— 工作区文件预览弹窗 -->
<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useMarkdown } from '@/composables/useMarkdown';
import hljs from 'highlight.js';
import { fetchWorkspaceFile } from '../../core/api/endpoints/workspace';

interface FileData {
  path: string;
  content: string;
  contentType: string;
  size: number;
  binary: boolean;
  base64?: boolean;
}

const props = defineProps<{
  visible: boolean;
  filePath: string;
  /** 说话者 Agent ID：原路径 404 时 fallback 到 files/<fallbackAgentId>/<path> */
  fallbackAgentId?: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const { render } = useMarkdown();

const loading = ref(false);
const error = ref('');
const fileData = ref<FileData | null>(null);

// 文件扩展名
const ext = computed(() => {
  const parts = props.filePath.split('.');
  return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
});

const fileName = computed(() => {
  return props.filePath.split(/[/\\]/).pop() || props.filePath;
});

// 是否为 HTML 文件
const isHtml = computed(() => ['html', 'htm'].includes(ext.value));

// 是否为图片
const isImage = computed(() => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext.value));

// 是否为 Markdown
const isMarkdown = computed(() => ext.value === 'md');

// 显示语言标签
const langLabel = computed(() => {
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', mjs: 'JavaScript',
    py: 'Python', java: 'Java', rs: 'Rust', go: 'Go', rb: 'Ruby',
    php: 'PHP', swift: 'Swift', kt: 'Kotlin', cs: 'C#', scala: 'Scala',
    c: 'C', cpp: 'C++', cxx: 'C++', h: 'C/C++ Header', hpp: 'C++ Header',
    html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less',
    json: 'JSON', xml: 'XML', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
    md: 'Markdown', sql: 'SQL', sh: 'Bash', bash: 'Bash', ps1: 'PowerShell',
    abap: 'ABAP', vue: 'Vue', svelte: 'Svelte', txt: 'Text', log: 'Log',
    ini: 'INI', cfg: 'Config', env: 'Env', bat: 'Batch', cmd: 'Batch',
  };
  return map[ext.value] || ext.value.toUpperCase() || 'Text';
});

// 图片 src
const imageSrc = computed(() => {
  if (!fileData.value) return '';
  const d = fileData.value;
  if (d.binary && d.base64) {
    return `data:${d.contentType};base64,${d.content}`;
  }
  // SVG 是文本格式（binary=false），后端不返回 base64：将 XML 文本编码为 data URL
  if (ext.value === 'svg' && !d.binary) {
    try {
      const bytes = new TextEncoder().encode(d.content);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return `data:image/svg+xml;base64,${btoa(bin)}`;
    } catch {
      return `data:image/svg+xml;utf8,${encodeURIComponent(d.content)}`;
    }
  }
  return '';
});

// 代码高亮
const highlightedCode = computed(() => {
  if (!fileData.value || fileData.value.binary || isHtml.value || isImage.value) return '';
  const lang = ext.value;
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(fileData.value.content, { language: lang }).value;
    } catch { /* fallthrough */ }
  }
  // 转义 HTML
  return fileData.value.content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
});

// Markdown 渲染
const renderedMarkdown = computed(() => {
  if (!fileData.value || !isMarkdown.value) return '';
  return render(fileData.value.content);
});

// 行号
const codeLines = computed(() => {
  if (!fileData.value || fileData.value.binary) return [];
  return fileData.value.content.split('\n');
});

// 文件大小格式化
const sizeDisplay = computed(() => {
  if (!fileData.value) return '';
  const bytes = fileData.value.size;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
});

// 加载文件（请求序号守卫：快速连点两个文件预览时，A 的慢响应后到会把
// B 的内容覆盖成 A（标题 B、正文 A 的"内容错位"）
let loadSeq = 0;
async function loadFile() {
  if (!props.visible || !props.filePath) return;
  const seq = ++loadSeq;
  loading.value = true;
  error.value = '';
  fileData.value = null;
  // 候选路径：原路径；404 且未带 files/ 前缀时 fallback 到 files/<fallbackAgentId>/<path>
  // （Agent 回复常写 note/xxx.md 之类不带工作区前缀的相对路径）
  const candidates = [props.filePath];
  if (props.fallbackAgentId && !/^files[/\\]/i.test(props.filePath)) {
    candidates.push(`files/${props.fallbackAgentId}/${props.filePath}`);
  }
  for (let i = 0; i < candidates.length; i++) {
    try {
      const data = await fetchWorkspaceFile(candidates[i]);
      if (seq !== loadSeq) return; // 已切换到别的文件：丢弃过期响应
      fileData.value = data as unknown as FileData;
      loading.value = false;
      return;
    } catch (err: any) {
      if (seq !== loadSeq) return;
      if (i === candidates.length - 1) {
        error.value = `加载失败: ${err.message}`;
      }
    }
  }
  if (seq === loadSeq) loading.value = false;
}

// 监听 visible 和 filePath 变化
watch(() => [props.visible, props.filePath], () => {
  if (props.visible && props.filePath) {
    loadFile();
  } else {
    loadSeq++; // 关闭时作废在途请求（防止迟到响应写入已关闭的弹窗）
    fileData.value = null;
    error.value = '';
  }
});

// 复制内容
const copyState = ref<'idle' | 'copied' | 'error'>('idle');
let copyTimer: ReturnType<typeof setTimeout> | null = null;

function copyContent() {
  if (!fileData.value) return;
  navigator.clipboard.writeText(fileData.value.content).then(() => {
    copyState.value = 'copied';
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copyState.value = 'idle'; }, 2000);
  }).catch(() => {
    copyState.value = 'error';
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copyState.value = 'idle'; }, 2000);
  });
}

function close() {
  emit('close');
}

// ESC 关闭
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close();
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  if (copyTimer) clearTimeout(copyTimer);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="file-preview-overlay" @click.self="close">
      <div class="file-preview-modal">
        <!-- 头部 -->
        <div class="fp-header">
          <div class="fp-header-left">
            <svg class="fp-file-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span class="fp-filename">{{ fileName }}</span>
            <span class="fp-lang-tag">{{ langLabel }}</span>
            <span v-if="sizeDisplay" class="fp-size">{{ sizeDisplay }}</span>
          </div>
          <div class="fp-header-right">
            <button
              v-if="fileData && !fileData.binary"
              class="fp-btn"
              :class="{ copied: copyState === 'copied', error: copyState === 'error' }"
              @click="copyContent"
              :title="copyState === 'copied' ? '已复制' : '复制内容'"
            >
              <svg v-if="copyState === 'idle'" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
              <svg v-else-if="copyState === 'copied'" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <span>复制</span>
            </button>
            <a
              v-if="isHtml"
              :href="`/api/workspace/raw?path=${encodeURIComponent(filePath)}`"
              target="_blank"
              class="fp-btn fp-btn-open"
              title="在新窗口打开"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              <span>新窗口打开</span>
            </a>
            <button class="fp-btn fp-btn-close" @click="close" title="关闭">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        <!-- 内容区 -->
        <div class="fp-body">
          <!-- 加载中 -->
          <div v-if="loading" class="fp-loading">
            <div class="fp-spinner"></div>
            <span>加载中...</span>
          </div>

          <!-- 错误 -->
          <div v-else-if="error" class="fp-error">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>{{ error }}</span>
          </div>

          <!-- HTML 预览（sandbox 仅 allow-scripts：去掉 allow-same-origin，防止恶意 HTML 触达父页面 DOM/存储） -->
          <iframe
            v-else-if="isHtml && fileData"
            class="fp-iframe"
            :srcdoc="fileData.content"
            sandbox="allow-scripts"
          ></iframe>

          <!-- 图片预览 -->
          <div v-else-if="isImage && imageSrc" class="fp-image-wrap">
            <img :src="imageSrc" :alt="fileName" class="fp-image" />
          </div>

          <!-- Markdown 预览 -->
          <div v-else-if="isMarkdown && fileData" class="fp-markdown markdown-body" v-html="renderedMarkdown"></div>

          <!-- 代码文件 -->
          <div v-else-if="fileData && !fileData.binary" class="fp-code-wrap">
            <div class="fp-code-container">
              <!-- 行号 -->
              <div class="fp-line-numbers">
                <span v-for="(_, i) in codeLines" :key="i" class="fp-line-num">{{ i + 1 }}</span>
              </div>
              <!-- 代码 -->
              <pre class="fp-code"><code v-html="highlightedCode"></code></pre>
            </div>
          </div>
        </div>

        <!-- 底部 -->
        <div class="fp-footer">
          <span class="fp-path">{{ filePath }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ===== 遮罩层 ===== */
.file-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  backdrop-filter: blur(2px);
}

/* ===== 弹窗 ===== */
.file-preview-modal {
  width: 100%;
  max-width: 960px;
  max-height: 90vh;
  background: var(--color-bg-page, #1e1e2e);
  border: 1px solid var(--color-border, rgba(255,255,255,0.08));
  border-radius: 10px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ===== 头部 ===== */
.fp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border, rgba(255,255,255,0.06));
  background: var(--color-bg-surface, rgba(255,255,255,0.03));
  flex-shrink: 0;
}
.fp-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.fp-file-icon {
  color: var(--color-text-secondary, rgba(255,255,255,0.5));
  flex-shrink: 0;
}
.fp-filename {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary, #e0e0e0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fp-lang-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--color-primary-light, rgba(79,70,229,0.15));
  color: var(--color-primary, #7c7cf8);
  white-space: nowrap;
  flex-shrink: 0;
}
.fp-size {
  font-size: 11px;
  color: var(--color-text-tertiary, rgba(255,255,255,0.35));
  white-space: nowrap;
  flex-shrink: 0;
}
.fp-header-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.fp-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 5px;
  border: 1px solid var(--color-border, rgba(255,255,255,0.08));
  background: var(--color-bg-surface, rgba(255,255,255,0.04));
  color: var(--color-text-secondary, rgba(255,255,255,0.6));
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
  text-decoration: none;
  white-space: nowrap;
}
.fp-btn:hover {
  background: var(--color-bg-hover, rgba(255,255,255,0.08));
  color: var(--color-text-primary, #e0e0e0);
}
.fp-btn.copied {
  color: #4caf50;
  border-color: rgba(76,175,80,0.3);
}
.fp-btn.error {
  color: #f44336;
}
.fp-btn-open {
  color: var(--color-primary, #7c7cf8) !important;
}
.fp-btn-close {
  padding: 4px 6px;
}

/* ===== 内容区 ===== */
.fp-body {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

/* 加载 */
.fp-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  gap: 12px;
  color: var(--color-text-secondary, rgba(255,255,255,0.5));
  font-size: 13px;
}
.fp-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--color-border, rgba(255,255,255,0.1));
  border-top-color: var(--color-primary, #7c7cf8);
  border-radius: 50%;
  animation: fp-spin 0.8s linear infinite;
}
@keyframes fp-spin { to { transform: rotate(360deg); } }

/* 错误 */
.fp-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  gap: 10px;
  color: var(--color-error, #f44336);
  font-size: 13px;
}

/* iframe */
.fp-iframe {
  width: 100%;
  height: 70vh;
  border: none;
  background: #fff;
}

/* 图片 */
.fp-image-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  min-height: 200px;
  background: repeating-conic-gradient(rgba(255,255,255,0.03) 0% 25%, transparent 0% 50%) 50% / 20px 20px;
}
.fp-image {
  max-width: 100%;
  max-height: 70vh;
  object-fit: contain;
  border-radius: 4px;
}

/* Markdown */
.fp-markdown {
  padding: 20px 24px;
}

/* 代码 */
.fp-code-wrap {
  overflow: auto;
}
.fp-code-container {
  display: flex;
  min-width: max-content;
}
.fp-line-numbers {
  display: flex;
  flex-direction: column;
  padding: 12px 8px 12px 16px;
  background: var(--color-bg-surface, rgba(0,0,0,0.15));
  border-right: 1px solid var(--color-border, rgba(255,255,255,0.06));
  user-select: none;
  text-align: right;
  flex-shrink: 0;
}
.fp-line-num {
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-tertiary, rgba(255,255,255,0.25));
  min-width: 2.5em;
}
.fp-code {
  margin: 0;
  padding: 12px 16px;
  font-size: 13px;
  line-height: 1.6;
  font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
  color: var(--color-text-primary, #e0e0e0);
  flex: 1;
}
.fp-code code {
  font-family: inherit;
  font-size: inherit;
}

/* ===== 底部 ===== */
.fp-footer {
  padding: 6px 16px;
  border-top: 1px solid var(--color-border, rgba(255,255,255,0.06));
  flex-shrink: 0;
}
.fp-path {
  font-size: 11px;
  color: var(--color-text-tertiary, rgba(255,255,255,0.3));
  font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
}

/* ===== 暗色模式适配 ===== */
:global(:root.dark) .file-preview-modal {
  background: #1a1a2e;
}
:global(:root.light) .file-preview-modal {
  background: #ffffff;
  border-color: rgba(0,0,0,0.08);
}
:global(:root.light) .fp-header {
  background: #f8f8fa;
  border-color: rgba(0,0,0,0.06);
}
:global(:root.light) .fp-btn {
  background: #f0f0f3;
  border-color: rgba(0,0,0,0.08);
  color: #555;
}
:global(:root.light) .fp-btn:hover {
  background: #e8e8ec;
  color: #222;
}
:global(:root.light) .fp-code {
  color: #333;
}
:global(:root.light) .fp-line-numbers {
  background: #f4f4f6;
  border-color: rgba(0,0,0,0.06);
}
:global(:root.light) .fp-iframe {
  background: #fff;
}
:global(:root.light) .fp-filename {
  color: #222;
}
</style>

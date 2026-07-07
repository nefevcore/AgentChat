<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMarkdown } from '@/composables/useMarkdown';

const props = defineProps<{
  data: Record<string, unknown>;
  toolName?: string;
}>();

interface DirItem {
  name: string;
  type: 'file' | 'directory';
}

const { render } = useMarkdown();

const isSkillRead = computed(() => props.toolName === 'skill_read');
const isDirectory = computed(() => props.data.type === 'directory');

// ---- 文件名（从路径提取） ----
const fileName = computed(() => {
  const p = String(props.data.path || props.data.name || '');
  return p.split(/[/\\]/).pop() || p;
});

const lang = computed(() => {
  if (isSkillRead.value) return '';
  const path = String(props.data.path || '');
  const ext = path.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    py: 'python', ts: 'typescript', js: 'javascript', vue: 'html',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    html: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
    md: 'markdown', sh: 'bash', bash: 'bash', ps1: 'powershell',
    xml: 'xml', sql: 'sql', rs: 'rust', go: 'go', java: 'java',
    cpp: 'cpp', cxx: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
    abap: 'abap', txt: 'text', log: 'text', cfg: 'ini', ini: 'ini',
    env: 'bash', dockerfile: 'dockerfile', makefile: 'makefile',
    cmake: 'cmake', gradle: 'groovy', groovy: 'groovy',
  };
  return map[ext || ''] || '';
});

// ---- 语言显示名 ----
const langDisplay = computed(() => {
  const display: Record<string, string> = {
    python: 'Python', typescript: 'TypeScript', javascript: 'JavaScript',
    html: 'Vue/HTML', json: 'JSON', yaml: 'YAML', toml: 'TOML',
    css: 'CSS', scss: 'SCSS', markdown: 'Markdown', bash: 'Bash',
    powershell: 'PowerShell', xml: 'XML', sql: 'SQL', rust: 'Rust',
    go: 'Go', java: 'Java', cpp: 'C++', c: 'C', ruby: 'Ruby',
    php: 'PHP', swift: 'Swift', kotlin: 'Kotlin', abap: 'ABAP',
    text: '纯文本', dockerfile: 'Dockerfile', ini: 'INI',
    groovy: 'Groovy', cmake: 'CMake', makefile: 'Makefile',
  };
  return display[lang.value] || lang.value.toUpperCase() || '纯文本';
});

// ---- 目录 ----
const dirItems = computed<DirItem[]>(() => {
  if (!isDirectory.value) return [];
  const items = props.data.items;
  if (!Array.isArray(items)) return [];
  return items as DirItem[];
});

const dirCount = computed(() => Number(props.data.count || dirItems.value.length));
const dirFileCount = computed(() => dirItems.value.filter(d => d.type === 'file').length);
const dirFolderCount = computed(() => dirItems.value.filter(d => d.type === 'directory').length);

// ---- 内容 ----
const content = computed(() => String(props.data.content || ''));
const truncated = computed(() => Boolean(props.data.truncated));
const totalBytes = computed(() => Number(props.data.total_bytes || 0));
const totalLines = computed(() => Number(props.data.total_lines || 0));
const startLine = computed(() => Number(props.data.start_line || 0));
const endLine = computed(() => Number(props.data.end_line || 0));
const isRange = computed(() => startLine.value > 0 && endLine.value > 0);

const lineCount = computed(() => {
  // 用实际返回内容的行数作为折叠判断依据（范围读取时内容行数 < total_lines）
  return content.value ? content.value.split('\n').length : 0;
});

// ---- 展开/折叠 ----
const LINE_COLLAPSE_THRESHOLD = 200;
const isLongFile = computed(() => lineCount.value > LINE_COLLAPSE_THRESHOLD);
const codeExpanded = ref(false);
// 当内容变化时重置展开状态
watch(content, () => { codeExpanded.value = false; });

function expandCode() {
  codeExpanded.value = true;
}
function collapseCode() {
  codeExpanded.value = false;
}

const displayContent = computed(() => {
  if (isLongFile.value && !codeExpanded.value) {
    const lines = content.value.split('\n');
    return lines.slice(0, LINE_COLLAPSE_THRESHOLD).join('\n');
  }
  return content.value;
});

const hiddenLines = computed(() => {
  if (!isLongFile.value || codeExpanded.value) return 0;
  return lineCount.value - LINE_COLLAPSE_THRESHOLD;
});

// ---- 复制 ----
const copyState = ref<'idle' | 'copied'>('idle');
async function copyContent() {
  try {
    await navigator.clipboard.writeText(content.value);
    copyState.value = 'copied';
    setTimeout(() => { copyState.value = 'idle'; }, 2000);
  } catch { /* ignore */ }
}

// ---- Markdown 渲染 ----
const renderedContent = computed(() => {
  if (isSkillRead.value) {
    return render(displayContent.value);
  }
  const code = displayContent.value;
  const fence = '```' + (lang.value || '');
  return render(`${fence}\n${code}\n\`\`\``);
});

// ---- 尺寸格式化 ----
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- 元信息行 ----
const metaItems = computed(() => {
  const items: string[] = [];
  const sz = Number(props.data.size);
  if (sz > 0) items.push(formatSize(sz));
  if (totalLines.value > 0) items.push(`${totalLines.value} 行`);
  if (isRange.value) items.push(`L${startLine.value}-L${endLine.value}`);
  if (props.data.version) items.push(`v${props.data.version}`);
  if (props.data.author) items.push(`作者: ${props.data.author}`);
  return items;
});
</script>

<template>
  <div class="tool-result-code">
    <!-- ==================== 目录清单 ==================== -->
    <template v-if="isDirectory">
      <div class="code-header code-header-dir">
        <div class="code-header-left">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="code-file-icon dir-icon-color">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <span class="code-file-name">{{ fileName }}</span>
        </div>
        <div class="code-header-meta">
          <span class="code-meta-badge">{{ dirCount }} 项</span>
          <span v-if="dirFolderCount" class="code-meta-badge code-meta-dim">{{ dirFolderCount }} 目录</span>
          <span v-if="dirFileCount" class="code-meta-badge code-meta-dim">{{ dirFileCount }} 文件</span>
        </div>
      </div>
      <div class="dir-list">
        <div
          v-for="item in dirItems"
          :key="item.name"
          class="dir-item"
        >
          <svg v-if="item.type === 'directory'"
            xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="item-icon icon-dir">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <svg v-else
            xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="item-icon icon-file">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
          <span class="item-name" :class="{ 'name-dir': item.type === 'directory' }">
            {{ item.name }}{{ item.type === 'directory' ? '/' : '' }}
          </span>
        </div>
      </div>
    </template>

    <!-- ==================== 文件内容 ==================== -->
    <template v-else>
      <!-- 头部信息栏 -->
      <div class="code-header">
        <div class="code-header-left">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="code-file-icon">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <span class="code-file-name">{{ fileName }}</span>
          <span v-if="lang && !isSkillRead" class="code-lang-badge">{{ langDisplay }}</span>
        </div>
        <div class="code-header-right">
          <span v-for="item in metaItems" :key="item" class="code-meta-badge">{{ item }}</span>
          <button
            class="code-copy-btn"
            :class="{ copied: copyState === 'copied' }"
            @click="copyContent"
            title="复制全部内容"
          >
            <svg v-if="copyState !== 'copied'" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span>{{ copyState === 'copied' ? '已复制' : '复制' }}</span>
          </button>
        </div>
      </div>

      <!-- 区域提示 -->
      <div v-if="isRange" class="code-range-hint">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
          <line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/>
          <line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
        </svg>
        显示 L{{ startLine }} – L{{ endLine }}（共 {{ totalLines }} 行）
      </div>

      <!-- 代码正文 -->
      <div class="code-viewport">
        <template v-if="isSkillRead">
          <div class="code-body-md" v-html="renderedContent" />
        </template>
        <template v-else>
          <div class="code-area-wrapper">
            <div class="code-area" v-html="renderedContent" />
          </div>
        </template>

        <!-- 折叠提示 & 按钮 -->
        <div v-if="isLongFile && !codeExpanded" class="code-fold-bar">
          <div class="code-fold-gradient"></div>
          <button class="code-fold-btn" @click.stop="expandCode">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
            展开全部 {{ hiddenLines }} 行
          </button>
        </div>
        <button v-if="isLongFile && codeExpanded" class="code-fold-btn code-fold-collapse" @click.stop="collapseCode">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="18 15 12 9 6 15"/>
          </svg>
          收起
        </button>
      </div>

      <!-- 截断提示 -->
      <div v-if="truncated" class="code-truncated-banner">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <span>内容已截断，仅显示前 {{ formatSize(content.length) }}（原始 {{ formatSize(totalBytes) }}）</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tool-result-code {
  padding: 0;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--color-border-light, #e5e7eb);
  background: var(--color-bg-primary);
}

/* ==============================
   头部信息栏
   ============================== */
.code-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border-light, #e5e7eb);
  gap: 8px;
  flex-wrap: wrap;
}
.code-header-dir {
  border-bottom: none;
}

.code-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.code-header-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.code-file-icon {
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}
.dir-icon-color {
  color: #e6a817;
}

.code-file-name {
  font-size: 13px;
  font-weight: 600;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.code-lang-badge {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--color-primary);
  color: #fff;
  flex-shrink: 0;
  opacity: 0.85;
}

.code-meta-badge {
  font-size: 11px;
  color: var(--color-text-tertiary);
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-light, #e5e7eb);
  white-space: nowrap;
}
.code-meta-dim {
  opacity: 0.7;
}

/* 复制按钮 */
.code-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-secondary);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-light, #e5e7eb);
  border-radius: 5px;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.code-copy-btn:hover {
  color: var(--color-text-primary);
  border-color: var(--color-border-secondary);
  background: var(--color-bg-secondary);
}
.code-copy-btn.copied {
  color: #22c55e;
  border-color: #22c55e;
  background: rgba(34, 197, 94, 0.08);
}

/* ==============================
   区域提示
   ============================== */
.code-range-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  font-size: 11px;
  color: var(--color-text-tertiary);
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border-light, #e5e7eb);
}

/* ==============================
   代码视口
   ============================== */
.code-viewport {
  position: relative;
  background: var(--color-code-bg);
}

.code-area-wrapper {
  overflow-x: auto;
}

/* 覆盖 markdown 代码块样式：去掉嵌套圆角，与外部卡片融为一体 */
.code-area :deep(.md-code-block) {
  margin: 0;
  border-radius: 0;
  background: transparent;
}
.code-area :deep(.md-code-block-banner) {
  display: none;
}
.code-area :deep(.md-code-block pre) {
  margin: 0;
  border-radius: 0;
  padding: 16px 20px;
  background: var(--color-code-bg);
}
.code-area :deep(.md-code-block pre code) {
  font-size: 13px;
  line-height: 1.65;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
}

/* Markdown 模式（skill_read） */
.code-body-md {
  padding: 16px 18px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--color-text-primary);
  background: var(--color-bg-primary);
}

/* ==============================
   折叠栏
   ============================== */
.code-fold-bar {
  position: relative;
}
.code-fold-gradient {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  height: 60px;
  background: linear-gradient(to bottom, transparent, var(--color-code-bg));
  pointer-events: none;
}
.code-fold-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 500;
  color: #58a6ff;
  background: rgba(88, 166, 255, 0.04);
  border: none;
  border-top: 1px solid rgba(48, 54, 61, 0.6);
  cursor: pointer;
  transition: background 0.15s;
}
.code-fold-btn:hover {
  background: rgba(88, 166, 255, 0.1);
}
.code-fold-collapse {
  color: var(--color-text-tertiary);
  background: rgba(128, 128, 128, 0.04);
}
.code-fold-collapse:hover {
  background: rgba(128, 128, 128, 0.1);
}

/* ==============================
   截断横幅
   ============================== */
.code-truncated-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  font-size: 12px;
  color: #d2991d;
  background: rgba(210, 153, 29, 0.08);
  border-top: 1px solid rgba(210, 153, 29, 0.2);
}

/* ==============================
   目录清单
   ============================== */
.dir-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 8px;
}
.dir-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 13px;
  transition: background 0.1s;
}
.dir-item:hover {
  background: var(--color-bg-secondary);
}
.item-icon {
  flex-shrink: 0;
}
.icon-dir {
  color: #e6a817;
}
.icon-file {
  color: var(--color-text-tertiary);
}
.item-name {
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  font-size: 13px;
}
.name-dir {
  color: #e6a817;
  font-weight: 500;
}
</style>

<script setup lang="ts">
import { computed } from 'vue';
import ScrollableViewport from 'ac-client-ui-renderer/client/ScrollableViewport.vue';
import { BusyRing, Tooltip } from '@agentchat/webui-kit';
import CodeCard from 'ac-client-ui-renderer/client/CodeCard.vue';

// ---- 语言检测（fs Code 卡专属词条：扩展名 → fence 语言名/显示名） ----
const EXT_LANGS: Record<string, string> = {
  py: 'python', ts: 'typescript', js: 'javascript', jsx: 'javascript',
  vue: 'html', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  html: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  md: 'markdown', sh: 'bash', bash: 'bash', ps1: 'powershell',
  xml: 'xml', sql: 'sql', rs: 'rust', go: 'go', java: 'java',
  cpp: 'cpp', cxx: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
  rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
  abap: 'abap', txt: 'text', log: 'text', cfg: 'ini', ini: 'ini',
  env: 'bash', dockerfile: 'dockerfile', makefile: 'makefile',
  bat: 'dos', cmd: 'dos',
  cmake: 'cmake', gradle: 'groovy', groovy: 'groovy',
};
const LANG_DISPLAY: Record<string, string> = {
  python: 'Python', typescript: 'TypeScript', javascript: 'JavaScript',
  html: 'Vue/HTML', json: 'JSON', yaml: 'YAML', toml: 'TOML',
  css: 'CSS', scss: 'SCSS', markdown: 'Markdown', bash: 'Bash',
  powershell: 'PowerShell', xml: 'XML', sql: 'SQL', rust: 'Rust',
  go: 'Go', java: 'Java', cpp: 'C++', c: 'C', ruby: 'Ruby',
  php: 'PHP', swift: 'Swift', kotlin: 'Kotlin', abap: 'ABAP',
  text: '纯文本', dockerfile: 'Dockerfile', ini: 'INI', dos: 'Batch',
  groovy: 'Groovy', cmake: 'CMake', makefile: 'Makefile',
};
/** 字节数格式化（B/KB/MB） */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const props = defineProps<{
  data: Record<string, unknown>;
  toolName?: string;
  loading?: boolean;
}>();

interface DirItem {
  name: string;
  type: 'file' | 'directory';
}

const isDirectory = computed(() => props.data.type === 'directory');

// ---- 文件名（从路径提取；调用阶段参数里即有 path/filePath/file_path——
// src 工具参数名是 file_path，缺失时调用中卡片的文件名一栏为空） ----
const fileName = computed(() => {
  const p = String(props.data.path || props.data.name || props.data.filePath || props.data.file_path || '');
  return p.split(/[/\\]/).pop() || p;
});

const lang = computed(() => EXT_LANGS[String(props.data.path || '').split('.').pop()?.toLowerCase() || ''] || '');
const langDisplay = computed(() => LANG_DISPLAY[lang.value] || lang.value.toUpperCase() || '纯文本');

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

// ---- 卡头补充 meta（cr-765 #17A：并进 CodeCard 头；行数 CodeCard 自带） ----
const metaText = computed(() => {
  const items: string[] = [];
  const sz = Number(props.data.size);
  if (sz > 0) items.push(formatSize(sz));
  if (isRange.value) items.push(`L${startLine.value}-L${endLine.value}`);
  if (props.data.version) items.push(`v${props.data.version}`);
  if (props.data.author) items.push(`作者: ${props.data.author}`);
  return items.join(' · ');
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
          <span class="ui-badge dim code-meta-badge">{{ dirCount }} 项</span>
          <span v-if="dirFolderCount" class="ui-badge dim code-meta-badge code-meta-dim">{{ dirFolderCount }} 目录</span>
          <span v-if="dirFileCount" class="ui-badge dim code-meta-badge code-meta-dim">{{ dirFileCount }} 文件</span>
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

    <!-- ==================== 文件内容（cr-765 #17A：CodeCard 统一形态） ==================== -->
    <template v-else>
      <!-- 执行中：文件已定位，内容未返回 -->
      <div v-if="loading && !content" class="code-loading">
        <BusyRing :size="13" />
        <span class="code-loading-text">正在读取...</span>
      </div>

      <!-- 代码卡（卡头标题/语言徽记/行数/meta + wrap 开关 + 复制 + 截断徽章控件） -->
      <CodeCard v-else :code="content" :lang="lang" :title="fileName" :meta-text="metaText" :line-numbers="isRange" :start-line="startLine || 1">
        <template #controls>
          <span v-if="truncated" class="ui-badge warn cc-truncated-badge" title="内容已截断，仅显示前 {{ formatSize(content.length) }}（原始 {{ formatSize(totalBytes) }}）">已截断</span>
        </template>
      </CodeCard>
    </template>
  </div>
</template>

<style scoped>
.tool-result-code {
  /* 文件类型分类色（非语义状态色——与 --warn 不同轴）：目录琥珀。cr-129 保留理由：
     类型身份色，非结果态语义；单源声明，勿在规则内散写色值。 */
  --ft-dir: #e6a817;
  padding: 0;
  border-radius: var(--r-md);
  overflow: hidden;
  border: 1px solid var(--line);
  background: var(--bg-base);
}

/* ==============================
   头部信息栏
   ============================== */
.code-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--line);
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
  color: var(--text-3);
  flex-shrink: 0;
}
.dir-icon-color {
  color: var(--ft-dir);
}

.code-file-name {
  font-size: 12px;
  font-weight: 600;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* cr-129 R3：语言徽记 = ui-badge kind（形状/配色归 kit 徽章族，此处只留排版修饰） */
.code-lang-badge {
  text-transform: uppercase;
  letter-spacing: 0.3px;
  flex-shrink: 0;
}

/* cr-129 R3：元信息徽章 = ui-badge dim（同上） */
.code-meta-badge {
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
  color: var(--text-2);
  background: var(--bg-base);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.code-copy-btn:hover {
  color: var(--text-1);
  border-color: var(--line);
  background: var(--bg-surface);
}
.code-copy-btn.copied {
  color: var(--ok);
  border-color: var(--ok);
  background: rgba(var(--ok-rgb), 0.08);
}


/* ==============================
   代码视口
   ============================== */
.code-viewport {
  position: relative;
  background: var(--code-bg);
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
  background: var(--code-bg);
}
.code-area :deep(.md-code-block pre code) {
  font-size: 12px;
  line-height: 1.65;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
}

.code-truncated-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  font-size: 12px;
  color: var(--warn);
  background: rgba(var(--warn-rgb), 0.08);
  border-top: 1px solid rgba(var(--warn-rgb), 0.2);
}

/* ---- 执行中 loading ---- */
.code-loading {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 14px 16px;
  font-size: 12px;
  color: var(--text-2);
}
/* cr-129 R2：自建忙指示（三点脉冲）→ BusyRing（忙指示唯一源；
   reduced-motion 归一由组件自带，main.css 同名豁免项随之作废） */
.code-loading-text { margin-left: 2px; }

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
  border-radius: var(--r-sm);
  font-size: 12px;
  transition: background 0.1s;
}
.dir-item:hover {
  background: var(--bg-surface);
}
.item-icon {
  flex-shrink: 0;
}
.icon-dir {
  color: var(--ft-dir);
}
.icon-file {
  color: var(--text-3);
}
.item-name {
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  font-size: 12px;
}
.name-dir {
  color: var(--ft-dir);
  font-weight: 500;
}
</style>

<!-- FilePreviewModal.vue —— 工作区文件预览弹窗（P1 起为移动端/窄屏形态：
     宽屏走 aux 预览选区多 tab 面板；本 Modal 保留 ≤768 全屏形态）。
     内容逻辑自 filePreviewContent.ts composable 共用（与 pane 单一逻辑源） -->
<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { Icon, Tooltip } from '@agentchat/webui-kit';
import {
  useFilePreviewContent,
  previewModeOptions,
  resolveViewKind,
  PREVIEW_MODE_LABELS,
  type PreviewViewMode,
} from './filePreviewContent.ts';
import { useModeMenu } from './useModeMenu.ts';
import { openLocalFile } from './fileApi.ts';
import { useClientContext } from 'ac-client-runtime';

const props = defineProps<{
  visible: boolean;
  filePath: string;
  /** 说话者 Agent ID：原路径 404 时 fallback 到 files/<fallbackAgentId>/<path> */
  fallbackAgentId?: string;
  /** 会话键（M32）：服务端按挂载工作区推导相对引用 */
  conversationId?: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

// 内容逻辑（共用 composable；visible 作为 enabled 门——关闭期间不发请求）
const {
  loading, error, fileData, fileName, langLabel, isHtml, isImage, isMarkdown,
  imageSrc, highlightedCode, renderedMarkdown, codeLines, sizeDisplay,
} = useFilePreviewContent(
  () => props.filePath,
  () => ({ agentId: props.fallbackAgentId ?? '', conversationId: props.conversationId ?? '' }),
  () => props.visible,
);

// ── 视图模式（下拉框，本地态——Modal 单文件形态不做跨开记忆）──
const viewMode = ref<PreviewViewMode>('auto');
watch(() => props.filePath, () => { viewMode.value = 'auto'; }); // 切文件回自动

const modeOptions = computed(() => previewModeOptions(props.filePath));
const showModeSelect = computed(() => modeOptions.value.length > 1);

const MODE_LABELS = PREVIEW_MODE_LABELS;

// ── 下拉弹层（自绘 Listbox：与 pane 共用 useModeMenu 状态机；Teleport 到 body）──
const { open: modeMenuOpen, triggerEl: modeTriggerEl, style: menuStyle, toggle: toggleModeMenu } = useModeMenu('fp-mode-menu', 130);

function pickMode(m: PreviewViewMode) {
  viewMode.value = m;
  modeMenuOpen.value = false;
}

/** Modal 关闭时收起弹层 */
watch(() => props.visible, (v) => { if (!v) modeMenuOpen.value = false; });

/** 实际渲染分支（auto 落到具体格式；binary 网关 + 合法性回落） */
const viewKind = computed(() =>
  resolveViewKind(viewMode.value, props.filePath, !!fileData.value?.binary));

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

// ── 本地打开（系统默认程序；错误就地短暂反馈）──
const rpc = useClientContext()?.rpc ?? null;
const openLocalState = ref<'idle' | 'opening' | 'error'>('idle');
const openLocalMsg = ref('');
let openLocalTimer: ReturnType<typeof setTimeout> | null = null;

async function openLocally() {
  if (!rpc || openLocalState.value === 'opening') return;
  openLocalState.value = 'opening';
  try {
    const r = await openLocalFile(props.filePath, {
      agentId: props.fallbackAgentId || undefined,
      conversationId: props.conversationId || undefined,
    }, rpc);
    openLocalState.value = r.error ? 'error' : 'idle';
    openLocalMsg.value = r.error ?? '';
  } catch (err: any) {
    openLocalState.value = 'error';
    openLocalMsg.value = err?.message ?? String(err);
  }
  if (openLocalState.value === 'error' && openLocalTimer) {
    clearTimeout(openLocalTimer);
    openLocalTimer = setTimeout(() => { openLocalState.value = 'idle'; }, 3000);
  }
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
  if (openLocalTimer) clearTimeout(openLocalTimer);
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
            <!-- 格式选择（自绘下拉：触发器 + Teleport 弹层） -->
            <div v-if="showModeSelect" class="fp-mode-select" title="选择预览格式">
              <button
                ref="modeTriggerEl"
                type="button"
                class="fp-mode-trigger"
                aria-haspopup="listbox"
                :aria-expanded="modeMenuOpen"
                @click="toggleModeMenu"
              >
                <Icon name="file-text" :size="13" class="fp-mode-icon" />
                <span class="fp-mode-label">{{ MODE_LABELS[viewMode] }}</span>
                <Icon name="chevron-down" :size="13" class="fp-mode-caret" :class="{ open: modeMenuOpen }" />
              </button>
            </div>
            <Teleport to="body">
              <div
                v-if="modeMenuOpen"
                class="fp-mode-menu"
                role="listbox"
                aria-label="预览格式"
                :style="menuStyle"
              >
                <button
                  v-for="m in modeOptions"
                  :key="m"
                  type="button"
                  role="option"
                  class="fp-mode-option"
                  :class="{ active: m === viewMode }"
                  :aria-selected="m === viewMode"
                  @click="pickMode(m)"
                >
                  <span class="fp-mode-option-label">{{ MODE_LABELS[m] }}</span>
                  <Icon v-if="m === viewMode" name="check" :size="13" class="fp-mode-option-check" />
                </button>
              </div>
            </Teleport>
            <Tooltip v-if="fileData && !fileData.binary" :text="copyState === 'copied' ? '已复制' : copyState === 'error' ? '复制失败' : '复制内容'" placement="bottom">
              <button
                class="fp-icon-btn"
                :class="{ copied: copyState === 'copied', error: copyState === 'error' }"
                @click="copyContent"
              >
                <Icon v-if="copyState === 'copied'" name="check" :size="15" />
                <Icon v-else-if="copyState === 'error'" name="alert-circle" :size="15" />
                <Icon v-else name="copy" :size="15" />
              </button>
            </Tooltip>
            <!-- 本地打开（系统默认程序；icon 按钮 + tooltip） -->
            <Tooltip
              v-if="openLocalState !== 'error'"
              :text="openLocalState === 'opening' ? '打开中…' : '本地打开（系统默认程序）'"
              placement="bottom"
            >
              <button
                class="fp-icon-btn"
                :disabled="openLocalState === 'opening'"
                @click="openLocally"
              >
                <Icon v-if="openLocalState === 'opening'" name="loader-circle" :size="15" class="fp-spin" />
                <Icon v-else name="external-link" :size="15" />
              </button>
            </Tooltip>
            <button
              v-else
              class="fp-icon-btn error"
              :title="openLocalMsg"
              @click="openLocally"
            ><Icon name="alert-circle" :size="15" /></button>
            <Tooltip v-if="isHtml" text="在新窗口打开" placement="bottom">
              <a
                :href="`/api/workspace/raw?path=${encodeURIComponent(filePath)}`"
                target="_blank"
                class="fp-icon-btn"
              >
                <Icon name="external-link" :size="15" />
              </a>
            </Tooltip>
            <Tooltip text="关闭" placement="bottom">
              <button class="fp-icon-btn fp-btn-close" @click="close">
                <Icon name="x" :size="16" />
              </button>
            </Tooltip>
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
            v-else-if="viewKind === 'html' && fileData"
            class="fp-iframe"
            :srcdoc="fileData.content"
            sandbox="allow-scripts"
          ></iframe>

          <!-- 图片预览 -->
          <div v-else-if="viewKind === 'image' && imageSrc" class="fp-image-wrap">
            <img :src="imageSrc" :alt="fileName" class="fp-image" />
          </div>

          <!-- Markdown 预览 -->
          <div v-else-if="viewKind === 'markdown' && fileData" class="fp-markdown markdown-body" v-html="renderedMarkdown"></div>

          <!-- 代码 / 纯文本 -->
          <div v-else-if="fileData && !fileData.binary" class="fp-code-wrap">
            <div class="fp-code-container">
              <!-- 行号列（空行 &nbsp; 占位防塌陷——两列逐行等高对齐） -->
              <div class="fp-line-numbers" aria-hidden="true">
                <span v-for="(l, i) in codeLines" :key="i" class="fp-line-num">{{ i + 1 }}{{ l === '' ? '\u00A0' : '' }}</span>
              </div>
              <!-- 代码（code 模式高亮；text 模式原文插值安全渲染） -->
              <pre v-if="viewKind === 'code'" class="fp-code"><code v-html="highlightedCode"></code></pre>
              <pre v-else class="fp-code fp-code-plain"><code>{{ fileData.content }}</code></pre>
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
  border-radius: var(--radius-sm);
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
/* ── 格式选择下拉（自绘 Listbox：触发器 + Teleport 弹层〔样式在下方
      非 scoped 块〕）── */
.fp-mode-select {
  display: inline-flex;
  align-items: center;
}
.fp-mode-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 7px 0 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border, rgba(255,255,255,0.08));
  background: var(--color-bg-surface, rgba(255,255,255,0.04));
  color: var(--color-text-secondary, rgba(255,255,255,0.75));
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.fp-mode-trigger:hover {
  border-color: var(--color-border, rgba(255,255,255,0.16));
  background: var(--color-bg-hover, rgba(255,255,255,0.08));
  color: var(--color-text-primary, #e0e0e0);
}
.fp-mode-trigger:focus-visible {
  outline: 2px solid var(--color-primary, #7c7cf8);
  outline-offset: 1px;
}
.fp-mode-icon { color: var(--color-text-tertiary, rgba(255,255,255,0.4)); flex-shrink: 0; }
.fp-mode-label { min-width: 30px; text-align: left; }
.fp-mode-caret {
  color: var(--color-text-tertiary, rgba(255,255,255,0.4));
  flex-shrink: 0;
  transition: transform 0.15s;
}
.fp-mode-caret.open { transform: rotate(180deg); }

/* ── icon 动作按钮 ── */
.fp-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 26px;
  padding: 0;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-secondary, rgba(255,255,255,0.55));
  cursor: pointer;
  transition: all 0.15s;
  text-decoration: none;
  flex-shrink: 0;
}
.fp-icon-btn:hover {
  background: var(--color-bg-hover, rgba(255,255,255,0.1));
  color: var(--color-text-primary, #e0e0e0);
}
.fp-icon-btn:disabled { opacity: 0.6; cursor: default; }
.fp-icon-btn.copied { color: #4caf50; }
.fp-icon-btn.error { color: #f44336; }
.fp-btn-close {
  padding: 0;
}
/* 打开中 spinner 旋转 */
.fp-spin { animation: fp-rotate 0.8s linear infinite; }
@keyframes fp-rotate { to { transform: rotate(360deg); } }

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
  border-radius: var(--radius-sm);
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
  font-size: 13px;        /* 与 .fp-code 同字号同字族——行高基准一致 */
  line-height: 1.6;
  color: var(--color-text-tertiary, rgba(255,255,255,0.25));
  min-width: 2.5em;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Monaco', 'Consolas', monospace;
}
.fp-code {
  margin: 0;
  padding: 12px 16px;
  font-size: 13px;
  line-height: 1.6;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Monaco', 'Consolas', monospace;
  color: var(--color-text-primary, #e0e0e0);
  flex: 1;
}
.fp-code code {
  font-family: inherit;
  font-size: inherit;
}
/* 纯文本模式：无衬线字体 */
.fp-code-plain {
  font-family: inherit;
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
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Monaco', 'Consolas', monospace;
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
:global(:root.light) .fp-mode-select .fp-mode-trigger {
  background: #f0f0f3;
  border-color: rgba(0,0,0,0.08);
}
:global(:root.light) .fp-mode-select .fp-mode-trigger:hover { background: #e8e8ec; }
:global(:root.light) .fp-icon-btn:hover {
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

<!-- 弹层样式（非 scoped：弹层经 Teleport 落在 body 下——类名 fp- 前缀隔离） -->
<style>
.fp-mode-menu {
  position: fixed;
  z-index: 10050; /* 高于本 Modal 遮罩（10000）与 Tooltip（700）层 */
  min-width: 130px;
  padding: 4px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border, rgba(255,255,255,0.1));
  background: var(--color-bg-surface, #262633);
  box-shadow: 0 8px 28px rgba(0,0,0,0.38);
  display: flex;
  flex-direction: column;
  gap: 1px;
  animation: fp-menu-in 0.12s ease-out;
}
@keyframes fp-menu-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
.fp-mode-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary, rgba(255,255,255,0.72));
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.fp-mode-option:hover {
  background: var(--color-bg-hover, rgba(255,255,255,0.08));
  color: var(--color-text-primary, #e0e0e0);
}
.fp-mode-option.active {
  color: var(--color-primary, #7c7cf8);
  background: var(--color-primary-light, rgba(99,102,241,0.12));
  font-weight: 500;
}
.fp-mode-option-check { flex-shrink: 0; }
/* 亮色模式 */
:root.light .fp-mode-menu {
  background: #ffffff;
  border-color: rgba(0,0,0,0.08);
  box-shadow: 0 8px 24px rgba(15,23,42,0.14);
}
:root.light .fp-mode-option { color: #444; }
:root.light .fp-mode-option:hover { background: #f0f0f3; color: #222; }
:root.light .fp-mode-option.active { color: #4f46e5; background: rgba(79,70,229,0.08); }
</style>

<!-- FilePreviewTabPane.vue —— 多 tab 预览的单 pane（一 tab 一文件）
  内容逻辑 = filePreviewContent.ts composable（与 Modal 单一逻辑源）。
  pane 常驻 v-show（保活——切 tab 不丢滚动/展开态）；enabled 门 =
  面板展开 && 本 pane 激活（首次激活才取数；已取数不重复请求）。
  头部动作（复制/本地打开）在各 pane 顶栏——tab 级动作随内容走。
  视图模式 = 下拉框选择格式（auto/markdown/代码/纯文本/图片/网页）：
  可选项由 previewModeOptions 能力检查先行过滤（该文件不允许的格式
  不出现在下拉里）。 -->
<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue';
import { BusyRing, Icon, IconAction, Select, Tooltip, toastError } from '@agentchat/webui-kit';
import {
  useFilePreviewContent,
  previewModeOptions,
  resolveViewKind,
  PREVIEW_MODE_LABELS,
  type PreviewViewMode,
} from './filePreviewContent.ts';
import { openLocalFile } from './fileApi.ts';
import OfficeView from './OfficeView.vue';
import { useClientContext } from 'ac-client-runtime';

const props = defineProps<{
  /** tab 键 = 请求路径（pane 生命周期内不变） */
  path: string;
  fallbackAgentId: string;
  /** 会话键快照（M32：服务端按挂载工作区推导相对引用） */
  conversationId: string;
  /** 本 pane 是否激活（v-show 由外层控制；enabled 门在此） */
  active: boolean;
  /** 面板是否展开（收起期间不发/不留请求） */
  panelOpen: boolean;
  /** 自动换行（per-tab 偏好——代码/文本类视图生效） */
  wrap: boolean;
  /** 视图模式：'auto' 按扩展名分派 / 显式格式（markdown/code/text/image/html） */
  viewMode: PreviewViewMode;
  /** 偏好变更动作（向上写回 tab 对象——pane 无 tab 写权） */
  onToggleWrap: () => void;
  onSetViewMode: (mode: PreviewViewMode) => void;
}>();

const {
  loading, error, fileData, fileName, langLabel, isHtml, isImage, isMarkdown, isOffice,
  imageSrc, officeSrc, highlightedLines, previewHtml, previewMarkdownDoc, codeLines, sizeDisplay, displayPath, invalidate, reload,
} = useFilePreviewContent(
  () => props.path,
  () => ({ agentId: props.fallbackAgentId, conversationId: props.conversationId }),
  () => props.active && props.panelOpen,
);

// ── 视图模式（下拉框）：能力检查 + 分派 ──
/** 可选格式（路径能力检查——选项集外的格式不进下拉；空 = 隐藏下拉） */
const modeOptions = computed(() => previewModeOptions(props.path));
/** 下拉显隐：多于一项才有切换意义；loading 前即就位（纯路径推导） */
const showModeSelect = computed(() => modeOptions.value.length > 1);

const MODE_LABELS = PREVIEW_MODE_LABELS;

// ── 格式下拉（kit Select——cr-192 归一：弹层/选中态/键盘可达单源）──
const modeSelectOptions = computed(() =>
  modeOptions.value.map((m) => ({ value: m, label: MODE_LABELS[m] }))
);

/** 实际渲染分支（auto 落到具体格式；binary 网关 + 合法性回落） */
const viewKind = computed(() =>
  resolveViewKind(props.viewMode, props.path, !!fileData.value?.binary));

/** 换行开关适用分支（代码/文本视图） */
const wrapApplies = computed(() => viewKind.value === 'code' || viewKind.value === 'text');

/** 是否展示代码视图（源码模式强制；或 auto 态的普通代码文件） */
const showCodeView = computed(() => !!fileData.value && !fileData.value.binary
  && (viewKind.value === 'code' || viewKind.value === 'text'));

// 复制内容（tab 级动作，状态随 pane）
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

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer);
  invalidate(); // 作废在途请求
});

// ── 本地打开（系统默认程序）──
const rpc = useClientContext()?.rpc ?? null;
const openLocalState = ref<'idle' | 'opening' | 'error'>('idle');

/** 失败经全局 toast 呈现（错误按钮仅标记位，title 兜底） */
function flashOpenLocalError(msg: string) {
  openLocalState.value = 'error';
  toastError(`本地打开失败：${msg}`, { key: 'open-local', duration: 4000 });
}

async function openLocally() {
  if (!rpc || openLocalState.value === 'opening') return;
  openLocalState.value = 'opening';
  try {
    const r = await openLocalFile(props.path, {
      agentId: props.fallbackAgentId || undefined,
      conversationId: props.conversationId || undefined,
    }, rpc);
    if (r.error) flashOpenLocalError(r.error);
    else openLocalState.value = 'idle';
  } catch (err: any) {
    flashOpenLocalError(err?.message ?? String(err));
  }
}

onBeforeUnmount(() => {
  invalidate(); // 作废在途请求
});
</script>

<template>
  <div class="fpt-pane">
    <!-- pane 头部：文件名 + 语言 + 大小 + 动作 -->
    <div class="fpt-head">
      <div class="fpt-head-info">
        <span class="fpt-name" :title="displayPath">{{ fileName }}</span>
        <span class="fpt-lang">{{ langLabel }}</span>
        <span v-if="sizeDisplay" class="fpt-size">{{ sizeDisplay }}</span>
      </div>
      <div class="fpt-head-actions">
        <!-- 格式选择（kit Select——cr-192；选项 = 该文件允许的格式，
             previewModeOptions 能力检查先行过滤） -->
        <Select
          v-if="showModeSelect"
          class="fpt-mode-select"
          :options="modeSelectOptions"
          :model-value="viewMode"
          title="选择预览格式"
          @update:model-value="(v) => props.onSetViewMode(v as PreviewViewMode)"
        />
        <!-- 刷新（重新拉取文件内容；加载中转圈禁点——错误态点击即重试） -->
        <Tooltip text="刷新" placement="bottom">
          <IconAction :icon="loading ? 'loader-circle' : 'refresh-cw'" label="刷新" :size="14" suppress-title :class="{ spin: loading }" :disabled="loading" @click="reload" />
        </Tooltip>
        <!-- 自动换行（代码/文本类视图生效；icon 开关 + on 态高亮） -->
        <Tooltip v-if="wrapApplies" :text="wrap ? '自动换行：开 · 点击关闭' : '自动换行：关 · 点击开启'" placement="bottom">
          <IconAction icon="wrap-text" label="自动换行" :size="14" suppress-title :class="{ on: wrap }" @click="onToggleWrap" />
        </Tooltip>
        <!-- 本地打开（系统默认程序；icon 按钮 + tooltip；失败经全局
             toast 呈现，此处仅错误标记位） -->
        <Tooltip
          v-if="openLocalState !== 'error'"
          :text="openLocalState === 'opening' ? '打开中…' : '本地打开（系统默认程序）'"
          placement="bottom"
        >
          <IconAction
            :icon="openLocalState === 'opening' ? 'loader-circle' : 'external-link'"
            label="本地打开（系统默认程序）"
            :size="14"
            suppress-title
            :class="{ spin: openLocalState === 'opening' }"
            :disabled="openLocalState === 'opening'"
            @click="openLocally"
          />
        </Tooltip>
        <IconAction
          v-else
          icon="alert-circle"
          label="本地打开失败（详见全局提示）"
          :size="14"
          class="error"
          @click="openLocally"
        />
        <Tooltip v-if="fileData && !fileData.binary" :text="copyState === 'copied' ? '已复制' : copyState === 'error' ? '复制失败' : '复制内容'" placement="bottom">
          <IconAction
            :icon="copyState === 'copied' ? 'check' : copyState === 'error' ? 'alert-circle' : 'copy'"
            label="复制内容"
            :size="14"
            suppress-title
            :class="{ ok: copyState === 'copied', error: copyState === 'error' }"
            @click="copyContent"
          />
        </Tooltip>
        <Tooltip v-if="isHtml" text="在新窗口打开" placement="bottom">
          <a
            :href="`/api/workspace/raw?path=${encodeURIComponent(path)}`"
            target="_blank"
            class="ui-icon-action"
            aria-label="在新窗口打开"
          ><Icon name="external-link" :size="14" /></a>
        </Tooltip>
      </div>
    </div>

    <!-- 内容区 -->
    <div class="fpt-body">
      <div v-if="loading" class="fpt-loading">
        <BusyRing :size="18" />
        <span>加载中...</span>
      </div>

      <div v-else-if="error" class="fpt-error">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>{{ error }}</span>
        <button class="fpt-error-retry" @click="reload">重试</button>
      </div>

      <!-- HTML 预览（sandbox 仅 allow-scripts——同 Modal 安全基线；previewHtml = 相对引用
           改 raw 直链 + base target 注入，srcdoc 原文无法定位） -->
      <iframe
        v-else-if="viewKind === 'html' && fileData"
        class="fpt-iframe"
        :srcdoc="previewHtml"
        sandbox="allow-scripts"
      ></iframe>

      <!-- Office 文档预览（@vue-office 前端渲染：docx/xlsx/pptx 家族；
           组件内按扩展名选解析器 + 懒加载，失败走组件内错误态） -->
      <OfficeView
        v-else-if="viewKind === 'office' && officeSrc"
        :name="fileName"
        :src="officeSrc"
      />

      <!-- 图片预览（v-else-if 链：html/office 之后、markdown 之前——Office
           改动曾整段替换掉本分支，此处补回；imageSrc 为空（非图片/无载荷）
           时不渲染，链继续向后兜底） -->
      <div v-else-if="viewKind === 'image' && imageSrc" class="fpt-image-wrap">
        <img :src="imageSrc" :alt="fileName" class="fpt-image" />
      </div>

      <!-- Markdown 预览（沙箱 iframe：raw HTML 放行受信渲染 + 相对图片 raw 直链——
           不进应用 DOM，与 HTML 预览同一安全基线） -->
      <iframe
        v-else-if="viewKind === 'markdown' && fileData"
        class="fpt-iframe fpt-iframe-markdown"
        :srcdoc="previewMarkdownDoc"
        sandbox="allow-scripts"
      ></iframe>

      <!-- 代码视图（代码高亮 / 纯文本共用行式布局；text 模式无高亮、
           无衬线渲染）——每行 = [行号][代码] 同格（wrap 态折行行高
           自然增长，行号恒与代码对齐；nowrap 态行内 white-space:pre +
           容器横向滚动） -->
      <div v-else-if="showCodeView" class="fpt-code-wrap" :class="{ 'fpt-wrap': wrap, 'fpt-plain': viewKind === 'text' }">
        <div v-for="(l, i) in codeLines" :key="i" class="fpt-code-row">
          <span class="fpt-line-num" aria-hidden="true">{{ i + 1 }}{{ l === '' ? '\u00A0' : '' }}</span>
          <code v-if="viewKind === 'code'" class="fpt-code-line" v-html="highlightedLines[i] ?? ''"></code>
          <code v-else class="fpt-code-line">{{ l }}</code>
        </div>
      </div>
    </div>

    <!-- 底部路径（实际命中路径——工作区推导命中时为绝对路径） -->
    <div class="fpt-foot">
      <span class="fpt-path">{{ displayPath }}</span>
    </div>
  </div>
</template>

<style scoped>
.fpt-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  overflow: hidden;
}

/* ── pane 头部 ── */
.fpt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}
.fpt-head-info {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.fpt-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fpt-lang {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--primary-light);
  color: var(--primary);
  white-space: nowrap;
  flex-shrink: 0;
}
.fpt-size {
  font-size: 10px;
  color: var(--text-3);
  white-space: nowrap;
  flex-shrink: 0;
}
.fpt-head-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
/* ── 格式下拉 + icon 动作钮已迁 kit Select/IconAction（cr-192）；
      此处仅留宿主态修饰（选中/错误/开启色 + 紧凑尺寸）── */
/* Select 紧凑档：头部工具行高度 22px 档 */
.fpt-head-actions :deep(.ui-sel-trigger) { height: 22px; padding: 0 6px; font-size: var(--fs-xs); }
.fpt-head-actions :deep(.ui-sel-value) { min-width: 28px; }
/* IconAction 态色：copied=ok、error=err、on（换行开）=primary 高亮 */
.fpt-head-actions :deep(.ui-icon-action.ok) { color: var(--ok); }
.fpt-head-actions :deep(.ui-icon-action.error) { color: var(--err); }
.fpt-head-actions :deep(.ui-icon-action.on) { color: var(--primary); background: var(--primary-light); }
/* loading 转圈（loader-circle 随 .spin 旋转——kit Icon 无内建旋转态） */
.fpt-head-actions :deep(.ui-icon-action.spin) .ui-icon svg { animation: fpt-spin 0.9s linear infinite; }
@keyframes fpt-spin { to { transform: rotate(360deg); } }

/* 错误区重试按钮（保留文字按钮形态——大点击目标） */
.fpt-error-retry {
  display: inline-flex;
  align-items: center;
  padding: 3px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-surface);
  color: var(--text-2);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
}
.fpt-error-retry:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

/* ── 内容区 ── */
.fpt-body {
  flex: 1;
  overflow: auto;
  min-height: 0;
}
.fpt-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  gap: 10px;
  color: var(--text-2);
  font-size: 12px;
}
/* 内容区等待位归 kit BusyRing（独立等待位 :size="18"，相邻文案承担语义） */
.fpt-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  gap: 10px;
  color: var(--err);
  font-size: 12px;
}
.fpt-iframe {
  display: block; /* inline 基线空隙（~7px descender）会撑出 body 溢出——双滚动条根源之一 */
  width: 100%;
  height: 100%;
  min-height: 300px;
  border: none;
  /* iframe 画布底色 = Web 默认白：HTML 预览页自带底色时不可见，且不作为
     主题底（主题底由沙箱文档自身调色板给）——非主题色常量，cr-127 保留 */
  background: #fff;
}
.fpt-image-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  min-height: 200px;
  background: repeating-conic-gradient(rgba(255,255,255,0.03) 0% 25%, transparent 0% 50%) 50% / 20px 20px;
}
.fpt-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--radius-sm);
}
/* ── 代码视图（行式布局）：每行 = [行号][代码] 同格 ──
   wrap 态：行内折行，行高随折行数增长——行号钉在行首恒对齐；
   nowrap 态：行 white-space:pre 不折，fpt-body 横向滚动（行号列
   sticky 跟随视口左缘——长行滚动时行号可见）。
   滚动收归 fpt-body 单容器：本层无高度约束，overflow:auto 会与
   body 嵌套出双滚动条（纵滚两根 + 横滚条挂在内容底部随滚出视口） */
.fpt-code-wrap {
  overflow: visible;
  padding: 10px 0;
  /* 字族/字号与聊天代码块（markdown.css .md-code-block）对齐 */
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Monaco', 'Consolas', monospace;
  font-size: 13px;
  line-height: 1.6;
}
.fpt-code-row {
  display: flex;
  align-items: flex-start;
}
.fpt-line-num {
  flex-shrink: 0;
  min-width: 3.5em;
  padding: 0 8px 0 12px;
  text-align: right;
  color: var(--text-3);
  user-select: none;
  position: sticky;
  left: 0;
  background: var(--bg-base); /* 遮盖横滚下穿行的代码 */
}
.fpt-code-line {
  flex: 1;
  min-width: 0;
  padding-right: 12px;
  color: var(--text-1);
  white-space: pre; /* nowrap 态：行不折（容器横滚）；wrap 态下行内覆盖 */
  /* code 元素被 UA 样式表显式声明 font-family: monospace，会盖过容器继承——
     显式 inherit 才能用上 .fpt-code-wrap 的字体栈（同 Modal 的 .fp-code code） */
  font-family: inherit;
  font-size: inherit;
}
/* wrap 态：代码行折行（首行与行号顶对齐，续行缩进对齐行号右侧） */
.fpt-wrap .fpt-code-line {
  white-space: pre-wrap;
  word-break: break-all;
  overflow-wrap: anywhere;
  text-indent: 0;
  padding-left: 4px;
}

/* 纯文本视图：无衬线字体（区别于代码视图的等宽栈） */
.fpt-code-wrap.fpt-plain {
  font-family: inherit;
  font-size: 13px;
}
.fpt-code-wrap.fpt-plain .fpt-code-line {
  font-family: inherit;
}

/* ── 底部路径 ── */
.fpt-foot {
  padding: 4px 10px;
  border-top: 1px solid var(--line);
  flex-shrink: 0;
}
.fpt-path {
  font-size: 10px;
  color: var(--text-3);
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Monaco', 'Consolas', monospace;
  word-break: break-all;
}

/* 亮色硬编码覆盖层已退役（cr-127）：pane 头分界/墨色/件底/悬停底全由 L0
   令牌双主题单源承担（--line/--text-1/--bg-surface/--bg-hover/--bg-base）。 */
</style>

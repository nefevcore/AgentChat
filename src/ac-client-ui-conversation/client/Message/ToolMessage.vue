<!-- ToolMessage.vue -->
<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import type { ChatMessage } from '../types.ts';
import { useToolResult } from '../useToolResult.ts';
import { toolDisplayLabel, toolDiffStat } from 'ac-client-ui-tool/client/toolLabel.ts';
import { toolIconName } from 'ac-client-ui-tool/client/toolIcon.ts';
import { resolveToolLabelAction } from 'ac-client-ui-tool/client/toolResultViews.ts';
import { Icon } from '@agentchat/webui-kit';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';

const props = defineProps<{
    message: ChatMessage;
    /** 所在会话键（M32 文件预览工作区推导——透传写类工具卡展开读取） */
    conversationId?: string;
}>();

// 行首图标位：hover 展示折叠箭头，平时展示工具图标（同款交互见
// AssistantMessage 思考行 / TurnDisplayItem 链栏）。
const rowHover = ref(false);

// 思维链内工具卡默认折叠（无流式自动展开等其他控制），仅用户点击展开
const isExpanded = ref(false);
const ui = useUiStore();

/** write 目标文件路径：结果回传 path 优先；结果未返回（调用中/流式中）回落
 *  工具参数 file_path——流式期间点击 Label 即可预览（不等结果）。 */
const writeFilePath = computed(() => {
  const args = parseArgs(props.message.arguments);
  return String(parsed.value?.data?.path || args.file_path || args.path || args.filePath || '');
});

const isWriteTool = computed(() => {
  const name = props.message.toolName || props.message.name;
  return name === 'write' && !!writeFilePath.value;
});

/** web_search：Label 点击直达搜索侧边栏（write 直达 preview 同款交互）。
 *  仅在有可展示结果时接管（结果未回/失败走默认展开体）；结果数据取
 *  resultData（参数+结果合并面——与卡内摘要行同源）。 */
const isSearchTool = computed(() => {
  const name = props.message.toolName || props.message.name;
  return name === 'web_search' && Array.isArray(resultData.value.results) && (resultData.value.results as unknown[]).length > 0;
});

// 注意：不能用 `toRef(props.message, 'content')` —— 它只捕获初始 message 对象。
// 流式期间派生 turn 每次重建都会产生"新对象"的 tool 消息（buildTurnsIncremental
// 只重建最后一个 turn），toRef 仍指向旧对象 → parsed/isJson 读到过期内容，
// 导致工具结果返回后卡片无法实时升级为专用视图（仅刷新后正常）。
// 改为 computed 每次读取 props.message.content，跟随最新的 message 对象。
const contentRef = computed(() => props.message.content);
const { parsed, isJson, component: ResultComponent } = useToolResult(
    contentRef,
    computed(() => props.message.toolName || props.message.name),
);

/** 是否正在执行（调用中/流式中），用于卡片 loading 态 */
const isRunning = computed(() =>
    props.message.isStreaming === true || props.message.status === 'running'
);

/** run_code 子调用（2026-09-17 方向 B）：平铺卡片带缩进样式——视觉
 *  归属 run_code 程序卡（紧跟其后、缩进 + 左侧竖线锚） */
const isSubcall = computed(() => props.message.subcall === true);

/** 工具参数（可能是对象或 OpenAI 风格的 JSON 字符串） */
function parseArgs(args: unknown): Record<string, unknown> {
    if (!args) return {};
    if (typeof args === 'string') {
        try { return JSON.parse(args) as Record<string, unknown>; } catch { return {}; }
    }
    return (typeof args === 'object' ? args : {}) as Record<string, unknown>;
}

const displayName = computed(() => {
    if (props.message.toolCalls?.length && !props.message.label && !props.message.name) {
        return props.message.toolCalls.map(tc => tc.function.name).join(', ');
    }
    // label 契约在轨道转正时丢失（各数据面 label=name）→ 按工具名+参数
    // 合成友好标签（"读取文件 src/main.ts"）；显式 label（如"正在调用工具: X"）优先
    return toolDisplayLabel(props.message.toolName || props.message.name, props.message.label, props.message.arguments);
});

/** 工具图标：按工具语义取特有 icon（聚合多工具 / 未知工具回落 wrench） */
const iconName = computed(() => toolIconName(props.message.toolName || props.message.name));

/** fs 写类工具的行变更统计（结果 JSON 内 diff_added/diff_removed；旧记录
 *  回落解析 diff 文本）——Label 尾缀 +N -M 数据源。运行中无结果 → null */
const diffStat = computed(() => toolDiffStat(props.message.content));

/** 行首图标：默认工具图标，hover 换折叠方向箭头（点哪行都知道能展开/收起） */
const rowIcon = computed(() => {
    // write/web_search 卡点击直达对应面板、无展开体 → hover 不换折叠箭头（保持工具图标）
    if (rowHover.value && !isWriteTool.value && !isSearchTool.value) return isExpanded.value ? 'chevron-up' : 'chevron-down';
    return iconName.value;
});

/** 失败红：error（含结果 error）/ blocked 时 label 整行红字（无徽章） */
const isFailed = computed(() => {
    if (props.message.isStreaming) return false;
    if (props.message.status === 'error' || props.message.isError) return true;
    if (parsed.value?.status === 'error' || parsed.value?.status === 'blocked') return true;
    return false;
});

const resultTitle = computed(() => {
    return parsed.value?.title || null;
});

const resultData = computed(() => {
    const args = parseArgs(props.message.arguments);
    // 已有结构化结果 → 结果数据渲染；工具参数层并入（结果字段优先）——
    // 卡片普遍依赖参数性字段（path/file 等），run_code 的程序体（code）也
    // 在参数里：结果不含程序体（上下文纪律——落盘只有 programHash），
    // 不并入则收束/刷新后程序段直接消失（实测复盘 4cd1a90d）。
    if (parsed.value) return { ...args, ...(parsed.value.data || parsed.value) };
    // 结果未返回（调用中/流式中）：用工具参数构造预览，调用阶段即可显示
    // 命令/文件路径等；流式中的原始输出喂给 output（bash 终端卡实时显示输出）。
    const preview: Record<string, unknown> = { ...args };
    if (props.message.content) preview.output = props.message.content;
    return preview;
});

const hasContent = computed(() => {
    return !!props.message.content;
});

function handleLabelClick() {
  if (isWriteTool.value) {
    // write：点击直达文件预览（全局单例 uiStore——宽屏右侧辅助侧边栏
    // preview 选区，窄屏全屏 Modal）。工具结果体不展开：Label 即终点。
    ui.openPreview(writeFilePath.value, props.message.agent_id || '', props.conversationId || '');
    return;
  }
  // 域行直达动作（web_search 直达搜索侧边栏等）：经 tool-card:result-view
  // 席位 def 的 onLabelClick 钩子（2026-12 R7 相位整改——base 不 import
  // domain 行；窄屏 helper 返 false → 走默认展开；行卸载 → def 消失 →
  // 回落展开，可摘除性保持）。
  if (isSearchTool.value) {
    const action = resolveToolLabelAction(props.message.toolName || props.message.name);
    if (action?.(resultData.value as Record<string, unknown>)) return;
  }
  toggleExpand();
}
function toggleExpand() {
    isExpanded.value = !isExpanded.value;
}

// ── 纯文本兜底输出限高滚动 + 流式吸底 ──
// 超长纯文本结果收进固定视口（--card-viewport-max 统一令牌，与思考卡
// 及各工具卡同高，样式见 .tool-output），不再把消息流撑出数屏。流式
// 输出增长时：
// 用户停在底部附近 → 直接吸底看最新输出（思考卡跟随的轻量版——工具
// 输出整块到达而非逐 token 流，无需缓动引擎）；用户上滚阅读 → 不打扰。
const outputEl = ref<HTMLElement | null>(null);

/** 用户停在底部附近（scroll 事件回读；吸底跟随的意图门槛） */
const outputAtBottom = ref(true);
const OUTPUT_BOTTOM_EPS = 16;

function syncOutputScrollState() {
    const el = outputEl.value;
    if (!el) return;
    outputAtBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < OUTPUT_BOTTOM_EPS;
}

// 流式增量到达：底部附近 → 吸底跟随（rAF 等限高容器高度就位）
watch(() => props.message.content, () => {
    requestAnimationFrame(() => {
        const el = outputEl.value;
        if (!el || !outputAtBottom.value) return;
        el.scrollTop = el.scrollHeight;
    });
});

// 展开初始化（nextTick 等 v-show 完成 display 切换）：历史结果停在顶部；
// 流式中展开 → 吸底直接看最新输出（与思考卡同款）
watch(isExpanded, (expanded) => {
    if (!expanded) return;
    nextTick(() => {
        const el = outputEl.value;
        if (!el) return;
        if (isRunning.value) el.scrollTop = el.scrollHeight;
        syncOutputScrollState();
    });
});
</script>

<template>
    <div class="message-item message-tool" :class="{ 'tool-subcall': isSubcall }">
        <div class="tool-section">
            <!-- 标签栏：图标位 = 工具图标 ⇄ 折叠箭头（hover 切换）；
                 失败（error/blocked）label 整行红字，不再渲染 OK/ERR 状态徽章 -->
            <div
                class="tool-label"
                :class="{ 'is-failed': isFailed }"
                @click="handleLabelClick()"
                @mouseenter="rowHover = true"
                @mouseleave="rowHover = false"
            >
                <!-- 行首图标位：运行中且非 hover → 琥珀旋转环（2026-12 统一
                     选型：全前端"忙"指示同色同款——工具卡/思考卡/链栏一致）；
                     hover 显示折叠箭头（交互优先） -->
                <span v-if="isRunning && !rowHover" class="tool-spin-ring" aria-hidden="true"></span>
                <Icon v-else :name="rowIcon" :size="14" class="tool-label-icon" />
                <!-- 单行截断（容器窄时尾部省略不换行），title 悬浮看全文 -->
                <span class="tool-label-name" :title="displayName">{{ displayName }}</span>

                <!-- fs 写类工具：行变更统计 +N -M（增绿删红，GitHub 风格；
                     结果返回后出现——运行中不显示） -->
                <span v-if="diffStat" class="tool-diff-stat" aria-hidden="true">
                    <span v-if="diffStat.added > 0" class="diff-stat-add">+{{ diffStat.added }}</span>
                    <span v-if="diffStat.removed > 0" class="diff-stat-remove">-{{ diffStat.removed }}</span>
                </span>

                <!-- write 工具：点击预览图标 -->
                <span v-if="isWriteTool" class="tool-label-hint" title="点击预览文件">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                  </svg>
                </span>
                <!-- web_search 工具：点击侧边栏查看图标 -->
                <span v-if="isSearchTool" class="tool-label-hint" title="点击在侧边栏查看搜索结果">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
                  </svg>
                </span>
            </div>

            <!-- 内容体 -->
            <div v-show="isExpanded" class="tool-body">
                <!-- JSON 结构化结果 -->
                <template v-if="isJson && parsed">
                    <!-- 错误 -->
                    <div v-if="parsed.status === 'error'" class="tool-json-error">
                        {{ parsed.message || parsed.data?.message || '(命令执行失败，见下方输出)' }}
                    </div>
                    <!-- 警告 -->
                    <div v-else-if="parsed.status === 'warning'" class="tool-json-warning">
                        {{ parsed.message || parsed.data?.message }}
                    </div>
                    <!-- 阻止 -->
                    <div v-else-if="parsed.status === 'blocked'" class="tool-json-blocked">
                        <Icon name="ban" :size="12" class="tool-json-blocked-icon" />{{ parsed.message || parsed.data?.message }}
                    </div>
                    <!-- 成功 / info：已知工具用专用组件，未知工具按普通文本渲染 -->
                    <!-- 注意：bash 的 status=error 仍需渲染 terminal（输出信息在 data.output 中）；browser 批量部分失败也需渲染（展示已成功 steps）；run_code 程序失败也需渲染（错误与执行摘要在卡内——实测复盘后确立）；subagent 的错误带近似候选 id/护栏指路（卡内 error 分支渲染） -->
                    <template v-if="parsed.status !== 'error' || message.name === 'bash' || message.name === 'browser' || message.name === 'run_code' || message.toolName === 'run_code' || message.name === 'subagent' || message.toolName === 'subagent'">
                        <div v-if="resultTitle" class="tool-json-title">{{ resultTitle }}</div>
                        <component
                            v-if="ResultComponent"
                            :is="ResultComponent"
                            :data="resultData"
                            :loading="false"
                            :tool-name="message.name"
                            :agent-id="message.agent_id"
                            :conversation-id="conversationId"
                        />
                        <pre v-else ref="outputEl" class="tool-output" @scroll="syncOutputScrollState"><code>{{ message.content }}</code></pre>
                    </template>
                </template>

                <!-- 已知工具但结果未返回（调用中/流式中）：立即渲染对应专用卡片
                     （bash 终端 / edit diff / read 代码…），用工具参数展示命令/路径 + loading 态 -->
                <template v-else-if="ResultComponent">
                    <component
                        :is="ResultComponent"
                        :data="resultData"
                        :loading="isRunning"
                        :tool-name="message.name"
                        :agent-id="message.agent_id"
                        :conversation-id="conversationId"
                    />
                </template>

                <!-- 非 JSON 原始文本（未知工具） -->
                <pre v-else-if="hasContent" ref="outputEl" class="tool-output" @scroll="syncOutputScrollState"><code>{{ message.content }}</code></pre>

                <div v-else-if="isRunning" class="tool-loading">
                    <span class="loading-text">正在执行...</span>
                </div>
                <div v-else class="tool-empty">（无输出内容）</div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.message-item {
    display: flex;
    flex-direction: column;
    width: 100%;
    /* chain-body 的 flex item：允许收缩（长内容不撑破容器宽——
       subcall 卡三层缩进可用宽最窄，最先暴露右侧裁剪） */
    min-width: 0;
}

.message-tool {
    align-items: flex-start;
}

/* run_code 子调用平铺卡（方向 B）：缩进 + 左侧竖线——视觉归属 run_code
   程序卡（不进其折叠体，紧跟其后独立成卡）。与 chain-body 同款竖线
   （1px / margin 7 / padding 14——对齐 chain-icon 中心的既有节奏）。
   width: auto 覆盖 .message-item 的 width:100%：显式宽 + margin-left
   总占位 = 父宽 + 7px，右缘恒被 messages-container 裁 7px（F12 实证）；
   auto 让 margin 吃进宽度——缩进视觉不变，右缘对齐父容器 */
.message-item.tool-subcall {
    width: auto;
    margin-left: 7px;
    padding-left: 14px;
    border-left: 1px solid var(--color-border-secondary);
}

.tool-section {
    width: 100%;
    min-width: 0;
}

.tool-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text-secondary);
    user-select: none;
    cursor: pointer;
    padding: 2px 0;
    transition: color 0.15s;
    /* 允许随容器收缩（侧边栏压缩会话宽度时），文本位单行省略 */
    min-width: 0;
}

.tool-label:hover {
    color: var(--color-text-primary);
}

/* 失败（error/blocked）：label 整行红字（替代原 OK/ERR/BLK 徽章） */
.tool-label.is-failed,
.tool-label.is-failed:hover {
    color: var(--color-error);
}

/* 失败红要覆盖行首图标（Icon 继承 currentColor，随行色走） */
.tool-label.is-failed .tool-label-icon {
    color: var(--color-error);
}

.tool-label-icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--color-text-secondary);
}

/* label 文本：单行截断（min-width:0 覆盖 flex 项 auto 下限才能收缩出
   省略空间）——容器宽度不足时尾部「…」，悬浮 title 看全文 */
.tool-label-name {
    font-weight: 500;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tool-label-hint {
  display: flex; align-items: center; opacity: 0;
  transition: opacity 0.15s; color: var(--color-accent, #4a90d9); flex-shrink: 0;
}
.tool-label:hover .tool-label-hint { opacity: 1; }

/* fs 写类工具 diff 统计（Label 尾缀 +N -M）：增绿删红，配色与卡内 diff
   行（diff-add/diff-del）同源；不参与收缩——固定宽度尾缀，优先保 Label 文本 */
.tool-diff-stat {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
    font-family: 'SF Mono', 'Consolas', monospace;
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    user-select: none;
}

.diff-stat-add { color: #4ade80; white-space: nowrap; }
.diff-stat-remove { color: #f87171; white-space: nowrap; }

/* 行首图标切换（工具图标 ⇄ 折叠箭头 ⇄ 运行中旋转环）：无位移的淡入淡出 */
.tool-label-icon { transition: opacity 0.12s ease; }

/* 运行中旋转环（2026-12 选型样式 2，后统一为琥珀）：替换行首工具图标位。
 * 琥珀与思考卡（think-spin-ring）/链栏（chain-spin-ring）同色同款——
 * 全前端"忙"指示统一（用户选型），环径与图标位（14px）同尺寸不跳动。 */
.tool-spin-ring {
    width: 13px;
    height: 13px;
    margin: 0.5px; /* 14px 图标位内居中（(14-13)/2） */
    border-radius: 50%;
    border: 2px solid var(--color-warning-light, rgba(245,158,11,0.15));
    border-top-color: var(--color-warning, #f59e0b);
    animation: toolSpin 0.8s linear infinite;
    flex-shrink: 0;
}
@keyframes toolSpin { to { transform: rotate(360deg); } }

.tool-body {
    margin-top: 4px;
    margin-left: 7px;
    border-left: 1px solid var(--color-border-secondary);
    padding-left: 14px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: calc(12px * 1.7 + 12px);
    min-width: 0;
}

/* 各专用结果卡根（本组件 scoped 命中子组件根元素）：同样允许收缩——
   卡内长内容（代码最长行 / 长命令）交由卡自己的横向滚动区承接，
   不再把卡撑出容器宽被 messages-container 裁掉 */
.tool-body > * {
    min-width: 0;
}

.tool-output {
    margin: 0;
    font-size: 12px;
    line-height: 1.7;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
    color: var(--color-text-secondary);
    background: transparent;
    /* 限高滚动：超长纯文本结果收进固定视口（--card-viewport-max 统一
       令牌——与思考卡及各工具卡同高），不再把消息流撑出数屏；流式输出
       增长时底部附近自动吸底（见 script） */
    max-height: var(--card-viewport-max);
    overflow-y: auto;
    overscroll-behavior: contain;
    /* 槽位常驻：滚动条出现/消失时内容宽度不跳变 */
    scrollbar-gutter: stable;
    scrollbar-width: thin;
    scrollbar-color: var(--color-border-secondary) transparent;
}

.tool-output code {
    font-family: inherit;
    color: inherit;
}

/* 细滚动条（与思考卡同款） */
.tool-output::-webkit-scrollbar { width: 5px; }
.tool-output::-webkit-scrollbar-track { background: transparent; }
.tool-output::-webkit-scrollbar-thumb { background: var(--color-border-secondary); border-radius: 3px; }
.tool-output::-webkit-scrollbar-thumb:hover { background: var(--color-border-primary); }

.tool-loading {
    display: flex;
    align-items: center;
    gap: 6px;
}

.loading-text {
    font-size: 12px;
    color: var(--color-text-secondary);
    font-style: italic;
}

.tool-empty {
    font-size: 12px;
    color: var(--color-text-secondary);
    font-style: italic;
}

.tool-json-error {
    color: var(--color-error);
    font-size: 12px;
}

.tool-json-warning {
    color: var(--color-warning);
    font-size: 12px;
}

.tool-json-blocked {
    display: flex;
    align-items: center;
    gap: 5px;
    color: #f59e0b;
    font-size: 12px;
}
.tool-json-blocked-icon { flex-shrink: 0; }

.tool-json-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin-bottom: 4px;
}
</style>

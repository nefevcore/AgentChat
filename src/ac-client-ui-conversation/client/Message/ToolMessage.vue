<!-- ToolMessage.vue -->
<script setup lang="ts">
import { ref, computed, nextTick } from 'vue';
import type { ChatMessage } from '../types.ts';
import { useToolResult } from '../useToolResult.ts';
import { toolDisplayLabel, toolDiffStat } from 'ac-client-ui-tool/client/toolLabel.ts';
import { toolIconName } from 'ac-client-ui-tool/client/toolIcon.ts';
import { Icon } from '@agentchat/webui-kit';

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
const resultComponentRef = ref<{ open?: () => void }>();

const isWriteTool = computed(() => {
  const name = props.message.toolName || props.message.name;
  return name === 'write' && parsed.value?.data?.path;
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
    if (rowHover.value) return isExpanded.value ? 'chevron-up' : 'chevron-down';
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
    // 已有结构化结果 → 用结果数据渲染
    if (parsed.value) return parsed.value.data || parsed.value || {};
    // 结果未返回（调用中/流式中）：用工具参数构造预览，调用阶段即可显示
    // 命令/文件路径等；流式中的原始输出喂给 output（bash 终端卡实时显示输出）。
    const args = parseArgs(props.message.arguments);
    const preview: Record<string, unknown> = { ...args };
    if (props.message.content) preview.output = props.message.content;
    return preview;
});

const hasContent = computed(() => {
    return !!props.message.content;
});

function handleLabelClick() {
  if (isWriteTool.value) {
    isExpanded.value = true;
    nextTick(() => resultComponentRef.value?.open?.());
  } else {
    toggleExpand();
  }
}
function toggleExpand() {
    isExpanded.value = !isExpanded.value;
}
</script>

<template>
    <div class="message-item message-tool">
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
                <span v-if="isWriteTool" class="tool-label-hint" title="点击查看文件内容">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
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
                    <!-- 注意：bash 的 status=error 仍需渲染 terminal（输出信息在 data.output 中）；browser 批量部分失败也需渲染（展示已成功 steps） -->
                    <template v-if="parsed.status !== 'error' || message.name === 'bash' || message.name === 'browser'">
                        <div v-if="resultTitle" class="tool-json-title">{{ resultTitle }}</div>
                        <component
                            ref="resultComponentRef"
                            v-if="ResultComponent"
                            :is="ResultComponent"
                            :data="resultData"
                            :loading="false"
                            :tool-name="message.name"
                            :agent-id="message.agent_id"
                            :conversation-id="conversationId"
                        />
                        <pre v-else class="tool-output"><code>{{ message.content }}</code></pre>
                    </template>
                </template>

                <!-- 已知工具但结果未返回（调用中/流式中）：立即渲染对应专用卡片
                     （bash 终端 / edit diff / read 代码…），用工具参数展示命令/路径 + loading 态 -->
                <template v-else-if="ResultComponent">
                    <component
                        ref="resultComponentRef"
                        :is="ResultComponent"
                        :data="resultData"
                        :loading="isRunning"
                        :tool-name="message.name"
                        :agent-id="message.agent_id"
                        :conversation-id="conversationId"
                    />
                </template>

                <!-- 非 JSON 原始文本（未知工具） -->
                <pre v-else-if="hasContent" class="tool-output"><code>{{ message.content }}</code></pre>

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
}

.message-tool {
    align-items: flex-start;
}

.tool-section {
    width: 100%;
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
}

.tool-output code {
    font-family: inherit;
    color: inherit;
}

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

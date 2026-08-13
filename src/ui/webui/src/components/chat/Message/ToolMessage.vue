<!-- ToolMessage.vue -->
<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue';
import type { ChatMessage } from '@/types';
import { useToolResult } from '@/composables/useToolResult';

const props = defineProps<{
    message: ChatMessage;
    index: number;
}>();

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

/** 是否正在执行（调用中/流式中），用于卡片 loading 态与自动展开 */
const isRunning = computed(() =>
    props.message.isStreaming === true || props.message.status === 'running'
);

// 流式执行期间自动展开工具卡：调用开始即可看到对应专用卡片（bash 终端 / edit diff …）
watch(isRunning, (v) => { if (v) isExpanded.value = true; });

/** 工具参数（可能是对象或 OpenAI 风格的 JSON 字符串） */
function parseArgs(args: unknown): Record<string, unknown> {
    if (!args) return {};
    if (typeof args === 'string') {
        try { return JSON.parse(args) as Record<string, unknown>; } catch { return {}; }
    }
    return (typeof args === 'object' ? args : {}) as Record<string, unknown>;
}

const displayName = computed(() => {
    if (props.message.label) return props.message.label;
    if (props.message.name) return props.message.name;
    if (props.message.toolCalls?.length) {
        return props.message.toolCalls.map(tc => tc.function.name).join(', ');
    }
    return '工具调用';
});

const statusIcon = computed(() => {
    if (props.message.isStreaming) return 'running';
    if (props.message.status === 'error' || props.message.isError) return 'error';
    if (parsed.value?.status === 'error') return 'error';
    if (parsed.value?.status === 'blocked') return 'blocked';
    return 'success';
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
            <!-- 标签栏 -->
            <div class="tool-label" @click="handleLabelClick()">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                    class="tool-label-icon">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
                <span class="tool-label-name">{{ displayName }}</span>

                <!-- write 工具：点击预览图标 -->
                <span v-if="isWriteTool" class="tool-label-hint" title="点击查看文件内容">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                  </svg>
                </span>

                <span v-if="statusIcon === 'running'" class="streaming-dots">
                    <span class="dot dot-yellow"></span>
                    <span class="dot dot-gray"></span>
                    <span class="dot dot-gray"></span>
                </span>
                <span v-else-if="statusIcon === 'success'" class="tool-status-done">OK</span>
                <span v-else-if="statusIcon === 'error'" class="tool-status-error">ERR</span>
                <span v-else-if="statusIcon === 'blocked'" class="tool-status-blocked">BLK</span>

                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                    class="collapse-chevron" :class="{ 'chevron-expanded': isExpanded }">
                    <path d="m9 18 6-6-6-6"/>
                </svg>
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
                        ⛔ {{ parsed.message || parsed.data?.message }}
                    </div>
                    <!-- 成功 / info：已知工具用专用组件，未知工具按普通文本渲染 -->
                    <!-- 注意：bash 的 status=error 仍需渲染 terminal（输出信息在 data.output 中）；browser 批量部分失败也需渲染（展示已成功 steps） -->
                    <template v-if="parsed.status !== 'error' || (parsed.status === 'error' && (message.name === 'bash' || message.name === 'browser'))">
                        <div v-if="resultTitle" class="tool-json-title">{{ resultTitle }}</div>
                        <component
                            ref="resultComponentRef"
                            v-if="ResultComponent"
                            :is="ResultComponent"
                            :data="resultData"
                            :loading="false"
                            :tool-name="message.name"
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
}

.tool-label:hover {
    color: var(--color-text-primary);
}

.tool-label-icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--color-text-secondary);
}

.tool-label-name { font-weight: 500; }

.tool-label-hint {
  display: flex; align-items: center; opacity: 0;
  transition: opacity 0.15s; color: var(--color-accent, #4a90d9); flex-shrink: 0;
}
.tool-label:hover .tool-label-hint { opacity: 1; }

.tool-status-done {
    color: #22c55e;
    font-size: 11px;
    font-weight: 700;
}

.tool-status-error {
    color: #ef4444;
    font-size: 11px;
    font-weight: 700;
}

.tool-status-blocked {
    color: #f59e0b;
    font-size: 11px;
    font-weight: 700;
}

.streaming-dots {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-left: 2px;
}

.dot {
    display: inline-block;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    animation: dotPulse 1.5s infinite;
}

.dot-yellow {
    background: #f39c12;
}

.dot-gray {
    background: #d1d5db;
}

.dot:nth-child(2) {
    animation-delay: 0.2s;
}

.dot:nth-child(3) {
    animation-delay: 0.4s;
}

@keyframes dotPulse {
    0%, 80%, 100% { opacity: 0.3; }
    40% { opacity: 1; }
}

.collapse-chevron {
    transition: transform 0.2s ease;
    flex-shrink: 0;
    color: var(--color-text-secondary);
}

.chevron-expanded {
    transform: rotate(90deg);
}

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
    color: #f59e0b;
    font-size: 12px;
}

.tool-json-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin-bottom: 4px;
}
</style>

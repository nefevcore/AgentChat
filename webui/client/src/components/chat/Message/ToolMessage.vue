<!-- ToolMessage.vue -->
<script setup lang="ts">
import { ref, computed, toRef } from 'vue';
import type { ChatMessage } from '@/types';
import { useToolResult } from '@/composables/useToolResult';

const props = defineProps<{
    message: ChatMessage;
    index: number;
}>();

const isExpanded = ref(false);

const { parsed, isJson, component: ResultComponent } = useToolResult(
    toRef(props.message, 'content'),
    computed(() => props.message.toolName || props.message.name),
);

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
    return parsed.value?.data || {};
});

const hasContent = computed(() => {
    return !!props.message.content;
});

function toggleExpand() {
    isExpanded.value = !isExpanded.value;
}
</script>

<template>
    <div class="message-item message-tool">
        <div class="tool-section">
            <!-- 标签栏 -->
            <div class="tool-label" @click="toggleExpand()">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                    class="tool-label-icon">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
                <span class="tool-label-name">{{ displayName }}</span>

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
                    <!-- 注意：bash 的 status=error 仍需渲染 terminal（输出信息在 data.output 中） -->
                    <template v-if="parsed.status !== 'error' || (parsed.status === 'error' && message.name === 'bash')">
                        <div v-if="resultTitle" class="tool-json-title">{{ resultTitle }}</div>
                        <component
                            v-if="ResultComponent"
                            :is="ResultComponent"
                            :data="resultData"
                            :tool-name="message.name"
                        />
                        <pre v-else class="tool-output"><code>{{ message.content }}</code></pre>
                    </template>
                </template>

                <!-- 非 JSON 原始文本 -->
                <pre v-else-if="hasContent" class="tool-output"><code>{{ message.content }}</code></pre>

                <div v-else-if="statusIcon === 'running'" class="tool-loading">
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
    font-size: 14px;
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

.tool-label-name {
    font-weight: 500;
}

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
    min-height: calc(13px * 1.7 + 12px);
}

.tool-output {
    margin: 0;
    font-size: 13px;
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
    font-size: 13px;
}

.tool-json-warning {
    color: var(--color-warning);
    font-size: 13px;
}

.tool-json-blocked {
    color: #f59e0b;
    font-size: 13px;
}

.tool-json-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin-bottom: 4px;
}
</style>

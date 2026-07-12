<!-- ThinkingToolGroup.vue - 思维链折叠分组 -->
<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useChatStore } from '@/stores/chat';
import AssistantMessage from './AssistantMessage.vue';
import ToolMessage from './ToolMessage.vue';
import type { ChatMessage, FileAttachment } from '@/types';

const props = defineProps<{
    /** 分组内的消息列表，可包含多轮 [assistant_thinking, tool..., ...] */
    messages: ChatMessage[];
    /** 分组在整体消息列表中的起始索引 */
    startIndex: number;
    /** 是否正在流式传输 */
    isStreaming?: boolean;
}>();

const emit = defineEmits<{
    downloadFile: [file: FileAttachment];
}>();

interface GroupStep {
    thinking: ChatMessage;
    tools: ChatMessage[];
}

const steps = computed<GroupStep[]>(() => {
    const result: GroupStep[] = [];
    const msgs = props.messages;
    let i = 0;
    while (i < msgs.length) {
        const msg = msgs[i];
        const reasoning = msg.reasoning_content || msg.thinking || '';
        const hasToolCalls = !!(msg.toolCalls && msg.toolCalls.length > 0);
        // assistant 有思考内容，或有工具调用 → 配对后续 tool 消息
        if (msg.role === 'assistant' && (reasoning.trim() || hasToolCalls)) {
            const tools: ChatMessage[] = [];
            let j = i + 1;
            while (j < msgs.length && msgs[j].role === 'tool') {
                tools.push(msgs[j]);
                j++;
            }
            result.push({ thinking: msg, tools });
            i = j;
        } else if (msg.role === 'tool') {
            result.push({ thinking: msg, tools: [] });
            i++;
        } else {
            i++;
        }
    }
    return result;
});

const stepCount = computed(() => steps.value.length);

const hasRunning = computed(() =>
    steps.value.some(s => s.tools.some(t => t.status === 'running'))
);

const chatStore = useChatStore();

// 折叠状态：会话进行中保持展开，会话结束后折叠
const isExpanded = ref(false);

watch(() => chatStore.turnInProgress, (inProgress) => {
    if (inProgress) {
        isExpanded.value = true;
    } else {
        isExpanded.value = false;
    }
}, { immediate: true });

function isThinkingStreamingNow(stepIdx: number): boolean {
    if (!props.isStreaming) return false;
    if (stepIdx !== steps.value.length - 1) return false;
    const thinking = steps.value[stepIdx].thinking;
    return !thinking.content || thinking.content.trim() === '';
}

function toggleExpand() {
    isExpanded.value = !isExpanded.value;
}
</script>

<template>
    <div class="think-chain-group" :class="{ 'group-streaming': isStreaming && hasRunning }">
        <!-- 标签栏 -->
        <div class="chain-label" @click="toggleExpand()">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                class="chain-icon">
                <path d="M12 2a6 6 0 0 1 6 6c0 2.5-1.8 5.5-3.4 6.4a2.5 2.5 0 0 0-1.6 1.6A7 7 0 0 1 12 22a7 7 0 0 1-1-13.9A6 6 0 0 1 12 2z"/>
                <path d="M12 16v4"/><path d="M8 16v4"/><path d="M10 18h4"/>
            </svg>
            <span class="chain-label-text">思考过程（共 {{ stepCount }} 步）</span>
            <span v-if="isStreaming && hasRunning" class="streaming-dots">
                <span class="dot dot-yellow"></span>
                <span class="dot dot-gray"></span>
                <span class="dot dot-gray"></span>
            </span>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                class="collapse-chevron" :class="{ 'chevron-expanded': isExpanded }">
                <path d="m9 18 6-6-6-6" />
            </svg>
        </div>

        <!-- 内容体 -->
        <div v-show="isExpanded" class="chain-body">
            <template v-for="(step, sIdx) in steps" :key="startIndex + sIdx">
                <!-- 思考过程 -->
                <div class="chain-step-thinking">
                    <AssistantMessage
                        :message="step.thinking"
                        :index="startIndex + sIdx"
                        :is-streaming="isThinkingStreamingNow(sIdx)"
                        :show-copy="false"
                        compact
                        @download-file="emit('downloadFile', $event)" />
                </div>
                <!-- 工具结果列表 -->
                <div v-for="(tool, tIdx) in step.tools" :key="`${startIndex + sIdx}-${tIdx}`" class="chain-step-tool">
                    <ToolMessage
                        :message="tool"
                        :index="startIndex + sIdx + tIdx + 1" />
                </div>
            </template>
        </div>
    </div>
</template>

<style scoped>
.think-chain-group {
    max-width: 85%;
    padding: 0 16px;
}

.chain-label {
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

.chain-label:hover {
    color: var(--color-text-primary);
}

.chain-icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--color-text-secondary);
}

.chain-label-text {
    font-weight: 500;
}


.streaming-dots {
    display: inline-flex;
    align-items: center;
    gap: 2px;
}

.streaming-dots .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    animation: dot-pulse 1.4s infinite ease-in-out;
}

.dot-yellow {
    background: #e6a817;
    animation-delay: 0s;
}

.dot-gray {
    background: #a8abb2;
    animation-delay: 0.3s;
}

.dot-gray:last-child {
    animation-delay: 0.6s;
}

@keyframes dot-pulse {
    0%, 80%, 100% { opacity: 0.3; }
    40% { opacity: 1; }
}

.collapse-chevron {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    transition: transform 0.2s ease;
    color: var(--color-text-tertiary, #a8abb2);
}

.chevron-expanded {
    transform: rotate(90deg);
}

.chain-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-left: 7px;
    border-left: 1px solid var(--color-border-secondary);
    padding: 4px 0 0 14px;
}

.group-streaming .chain-label {
    color: var(--color-text-primary);
}
</style>

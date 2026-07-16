<!-- Message.vue - 消息路由组件 -->
<script setup lang="ts">
import { computed } from 'vue';
import UserMessage from './UserMessage.vue';
import AssistantMessage from './AssistantMessage.vue';
import ToolMessage from './ToolMessage.vue';
import type { ChatMessage, FileAttachment } from '@/types';

const props = defineProps<{
    message: ChatMessage;
    index: number;
    isStreaming?: boolean;
    isArchivedContext?: boolean;
    /** 当前活跃 Agent ID，用于多 Agent 会话中正确归属消息显示角色 */
    activeAgent?: string;
    /** 发送者头像 URL */
    senderAvatar?: string | null;
    /** 发送者显示名称 */
    senderName?: string;
}>();

const emit = defineEmits<{
    downloadFile: [file: FileAttachment];
}>();

/**
 * 计算消息的"显示角色"。
 *
 * 背景：Agent 间会话共享 messages.jsonl，消息的 role 字段是从接收方视角记录的。
 * 例如 chat_agent → coding_agent 的消息在 JSONL 中 role="user"（coding_agent 视角），
 * 但从 chat_agent 视角看这条消息应该是"自己发出的"（assistant）。
 *
 * 规则：
 *   - tool 角色始终渲染为 ToolMessage
 *   - agent_id === 'user' → UserMessage（人类用户的消息）
 *   - agent_id === activeAgent → AssistantMessage（当前 Agent 自己产生的消息）
 *   - 其他 agent_id → UserMessage（对方 Agent 发来的消息）
 *   - 无 agent_id（旧数据兼容）→ 回退到 role 判断
 */
const displayRole = computed<'user' | 'assistant' | 'tool'>(() => {
    const { role, agent_id } = props.message;

    // tool 角色不变
    if (role === 'tool') return 'tool';

    // 无 agent_id（旧数据兼容）：回退到原始 role
    if (!agent_id || !props.activeAgent) return role as 'user' | 'assistant';

    // 人类用户的消息永远显示为 user
    if (agent_id === 'user') return 'user';

    // 当前活跃 Agent 自己产生的消息 → assistant
    if (agent_id === props.activeAgent) return 'assistant';

    // 其他 Agent 发来的消息 → user
    return 'user';
});

const component = computed(() => {
    switch (displayRole.value) {
        case 'user':
            return UserMessage;
        case 'assistant':
            return AssistantMessage;
        case 'tool':
            return ToolMessage;
        default:
            return null;
    }
});
</script>

<template>
    <div v-if="component" :class="{ 'archived-context': isArchivedContext }">
        <component :is="component" :message="message" :index="index" :is-streaming="isStreaming"
            :sender-avatar="senderAvatar" :sender-name="senderName"
            @download-file="emit('downloadFile', $event as FileAttachment)" />
    </div>
</template>

<style scoped>
.archived-context {
    opacity: 0.7;
}
</style>

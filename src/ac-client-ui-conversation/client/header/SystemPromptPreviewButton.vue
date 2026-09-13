// ============================================================
// client/header/SystemPromptPreviewButton.vue —— System Prompt
// 预览入口（会话头按钮）
//（会话区重构遗留归位：原 ConversationView 内联按钮迁
//  conversation:header-widget 出厂贡献 order 25——Token 仪表(20)之后、
//  Agent·single 动作(30)之前。内联残留恒排席位 outlet 之后＝恒排「更多」
//  按钮之后（次序回归根源：M30 重构时 Agent 配置/更多已迁 order 30 贡献，
//  本按钮漏迁）。ownerProps = { form, agentId }，群/pair 形态组件内自隐。
//  弹窗 = overlay 席位贡献（webui-base-conversation.system-prompt），
//  开关态住 ui store；内容请求经 chatStore。）
// ============================================================

<script setup lang="ts">
import { computed, toRef } from 'vue';
import { Icon } from '@agentchat/webui-kit';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import { useChatStore } from '../chatStore.ts';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';

const props = defineProps<{
  /** 席位 owner 上下文透传（D16-③：ConversationView 经 SlotOutlet data 传入） */
  data: {
    /** 会话形态（仅 direct/single 显示入口） */
    form?: 'direct' | 'group' | 'single' | 'pair';
    /** 头部目标 Agent（direct = 激活 Agent；single = 会话承载 Agent） */
    agentId?: string | null;
  };
}>();

const chatStore = useChatStore();
const ui = useUiStore();
const roster = useRosterCore();

const agentId = toRef(() => props.data.agentId);

/** 形态 gate：仅 direct/single（group/pair 无系统提示词预览入口） */
const applicable = computed(() =>
  (props.data.form === 'direct' || props.data.form === 'single') && !!agentId.value);

/** 弹窗标题快照（getAgentName 含预设目录解析——与内核 activeAgentName 同源） */
const agentName = computed(() => {
  const id = agentId.value;
  if (!id) return '';
  return roster.getAgentName(id) || id;
});

/** 打开 System Prompt 预览（overlay 贡献——开关态住 ui store；内容请求经 chatStore） */
function openPreview() {
  if (agentId.value) chatStore.requestSystemPrompt(agentId.value);
  ui.openSystemPrompt(agentName.value);
}
</script>

<template>
  <button
    v-if="applicable"
    class="settings-btn"
    :disabled="chatStore.systemPromptLoading"
    title="预览 System Prompt"
    @click="openPreview()"
  >
    <Icon name="scroll-text" :size="18" />
  </button>
</template>

<style scoped>
/* 与 AgentHeaderActions/SingleHeaderActions 同款按钮词汇（行内各自声明，
   行独立卸载互不影响） */
.settings-btn {
  display: flex; align-items: center; justify-content: center;
  background: none; border: none; cursor: pointer; color: var(--color-text-secondary);
  padding: 6px; border-radius: var(--radius-sm); line-height: 0; flex-shrink: 0;
}
.settings-btn:hover { background: var(--color-bg-surface); color: var(--color-text-primary); }
.settings-btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>

// ============================================================
// client/SystemPromptModal.vue —— System Prompt 预览弹窗
//（会话区重构：自 ConversationView 内联 Modal 迁出，经 overlay 席位出厂
//  贡献 order 88——开关态住 ui store（openSystemPrompt/closeSystemPrompt，
//  TokenUsage 同款全局单例姿势）；内容/加载/错误仍住 chatStore
//  （systemPromptContent 族——requestSystemPrompt/clearSystemPrompt）。
//  会话头按钮（内核保留）只负责置位开关 + 发起请求。）
// ============================================================

<script setup lang="ts">
import { computed, watch } from 'vue';
import { Modal, Icon } from '@agentchat/webui-kit';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { useChatStore } from './chatStore.ts';

const ui = useUiStore();
const chatStore = useChatStore();

const visible = computed(() => ui.systemPromptOpen);
const agentName = computed(() => ui.systemPromptAgentName);

function close() {
  ui.closeSystemPrompt();
  chatStore.clearSystemPrompt();
}

/** 弹窗开着时会话模式被切换（ChatInput 写口 bump）→ 重取：程序化档
 *  注入 SDK 投影块、收窄档换指引块——所见即当前模式的真实装配
 *  （2026-12 预览失真修复；模式切换仅在 run 间隙生效，无竞态）。 */
watch(() => chatStore.convToolMode, () => {
  if (visible.value) chatStore.requestSystemPrompt();
});

function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => {
      chatStore.copyFeedback = true;
      setTimeout(() => { chatStore.copyFeedback = false; }, 2000);
    }).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text: string) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    chatStore.copyFeedback = true;
    setTimeout(() => { chatStore.copyFeedback = false; }, 2000);
  } catch { /* 复制失败，静默处理 */ }
  document.body.removeChild(textarea);
}
</script>

<template>
  <Modal :visible="visible" :width="700" @close="close">
    <div v-if="visible" class="system-prompt-dialog">
      <div class="prompt-header">
        <h4>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
          System Prompt · {{ agentName }}
        </h4>
        <button class="close-btn" @click="close" title="关闭"><Icon name="x" :size="14" /></button>
      </div>
      <div class="prompt-body">
        <div v-if="chatStore.systemPromptLoading" class="prompt-loading"><span class="prompt-spinner"></span><span>正在组装 System Prompt…</span></div>
        <div v-else-if="chatStore.systemPromptError" class="prompt-error">{{ chatStore.systemPromptError }}</div>
        <pre v-else class="prompt-content">{{ chatStore.systemPromptContent }}</pre>
      </div>
      <div class="prompt-footer">
        <span class="prompt-info">共 {{ chatStore.systemPromptContent.length }} 字符</span>
        <div class="prompt-actions">
          <button class="btn-refresh" @click="chatStore.requestSystemPrompt()" :disabled="chatStore.systemPromptLoading" title="刷新（重新组装当前会话视角的提示词——含工具调用模式收窄后的装配面）">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
            刷新
          </button>
          <button class="btn-copy" @click="copyText(chatStore.systemPromptContent)" :disabled="chatStore.copyFeedback" title="复制到剪贴板">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            {{ chatStore.copyFeedback ? '已复制' : '复制' }}<Icon v-if="chatStore.copyFeedback" name="check" :size="11" />
          </button>
          <button class="btn-cancel" @click="close">关闭</button>
        </div>
      </div>
    </div>
  </Modal>
</template>

<style>
/* System Prompt 预览弹窗（全局样式——Modal 内容面） */
.system-prompt-dialog { max-height: 85vh; display: flex; flex-direction: column; }
.prompt-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--color-border-secondary, #e0e0e0); flex-shrink: 0; }
.prompt-header h4 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; font-weight: 600; color: var(--color-text-primary, #2c3e50); }
.prompt-body { flex: 1; overflow-y: auto; padding: 16px 20px; min-height: 200px; }
.prompt-loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 40px 0; color: var(--color-text-muted); font-size: 13px; }
.prompt-spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--color-border-primary); border-top-color: var(--color-primary); border-radius: 50%; animation: spm-spin 0.6s linear infinite; }
@keyframes spm-spin { to { transform: rotate(360deg); } }
.prompt-error { color: #e74c3c; padding: 20px; text-align: center; font-size: 13px; }
.prompt-content { margin: 0; padding: 12px 16px; background: var(--color-bg-surface, #f8f9fa); border: 1px solid var(--color-border-secondary, #e0e0e0); border-radius: 8px; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', 'Monaco', monospace; font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: var(--color-text-primary, #2c3e50); max-height: 55vh; overflow-y: auto; user-select: text; -webkit-user-select: text; }
.prompt-footer { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; border-top: 1px solid var(--color-border-secondary, #e0e0e0); flex-shrink: 0; }
.prompt-info { font-size: 12px; color: var(--color-text-muted); }
.prompt-actions { display: flex; gap: 8px; }
.btn-refresh { display: flex; align-items: center; gap: 4px; padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; background: var(--color-bg-page, #fff); border: 1px solid var(--color-border-secondary, #ddd); color: var(--color-text-secondary, #7f8c8d); }
.btn-refresh:hover:not(:disabled) { background: var(--color-bg-surface); color: var(--color-text-primary); }
.btn-refresh:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-copy { display: flex; align-items: center; gap: 4px; padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; background: var(--color-primary, #4a90d9); border: none; color: #fff; transition: background 0.2s; }
.btn-copy:hover:not(:disabled) { opacity: 0.9; }
.btn-copy:disabled { opacity: 0.7; cursor: default; background: #27ae60; }
.btn-cancel { padding: 6px 12px; border: 1px solid var(--color-border-secondary); border-radius: 6px; background: var(--color-bg-page); color: var(--color-text-secondary); font-size: 12px; cursor: pointer; }
.btn-cancel:hover { background: var(--color-bg-surface); }
.close-btn { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; border: none; background: none; font-size: 20px; color: var(--color-text-secondary, #7f8c8d); cursor: pointer; border-radius: 6px; line-height: 1; flex-shrink: 0; }
.close-btn:hover { background: var(--color-bg-surface, #f0f0f0); color: var(--color-text-primary, #2c3e50); }
</style>

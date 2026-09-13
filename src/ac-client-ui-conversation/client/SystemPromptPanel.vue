<script setup lang="ts">
// ============================================================
// client/SystemPromptPanel.vue —— System Prompt aux 选区面板
//（A1：对照会话阅读——宽屏会话头按钮直达侧栏，边聊边看 prompt）
//
// 数据：chatStore systemPrompt 族（与 modal 同源——requestSystemPrompt
// 由会话头按钮发起；选区宿主只在当选时补一次请求〔宽屏入口不再开
// modal，请求可能从未发起〕）。keepAlive 语义：内容常驻，切换会话
// 时由入口按钮重新触发请求。
// ============================================================
import { computed, watch } from 'vue';
import { Icon, Tooltip } from '@agentchat/webui-kit';
import { useClientContext } from 'ac-client-runtime';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { useChatStore } from './chatStore.ts';

const ctx = useClientContext();
const roster = useRosterCore();
const singlesBoard = ctx?.singleBoard;
const ui = useUiStore();
const chatStore = useChatStore();

/** 当前会话目标 Agent（与会话头 headerAgentId 同款解析：single 承载
 *  Agent 优先，回落活跃 1v1 Agent；群/无选中 = null）。rail 直开与
 *  会话头按钮两入口同源——行为差异消除（此前 rail 直开走无参请求，
 *  群视角静默不发起 + 标题用旧快照）。 */
const agentId = computed(() => {
  const sid = singlesBoard?.activeSingleId.value;
  if (sid) {
    const meta = singlesBoard?.singles.value.find((s) => s.id === sid);
    return meta?.agentId || roster.defaultPresetId.value;
  }
  return roster.activeAgentId.value || null;
});
/** 标题（实时解析——不依赖按钮快照 systemPromptAgentName） */
const agentName = computed(() => {
  const id = agentId.value;
  if (!id) return '';
  return roster.getAgentName(id) || id;
});
const inGroupView = computed(() => !agentId.value && !!ctx?.groups?.activeGroupId.value);

/** 选区激活时兜底请求：目标解析自持（带 agentId——single 视角由
 *  chatStore resolveContext 附 sessionId）；内容已有则不重复。 */
watch(() => [ui.auxPanel, ui.auxVisible, agentId.value] as const, ([panel, visible, id]) => {
  if (panel === 'prompt' && visible && id && !chatStore.systemPromptContent
    && !chatStore.systemPromptLoading && !chatStore.systemPromptError) {
    chatStore.requestSystemPrompt(id);
  }
}, { immediate: true });

/** 目标切换（会话切换）→ 内容清空重取（旧 Agent 的 prompt 不残留） */
watch(agentId, (id, old) => {
  if (id !== old && id) {
    chatStore.clearSystemPrompt();
    chatStore.requestSystemPrompt(id);
  }
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
  } catch { /* 复制失败，静默 */ }
  document.body.removeChild(textarea);
}
</script>

<template>
  <div class="spp-panel">
    <div class="spp-head">
      <span class="spp-title">System Prompt<i class="spp-sep">·</i>{{ agentName || '未选择' }}</span>
      <div class="spp-actions">
        <Tooltip text="刷新（重新组装当前 Agent 提示词）" placement="bottom">
          <button
            class="spp-btn"
            :disabled="chatStore.systemPromptLoading || !agentId"
            @click="chatStore.requestSystemPrompt(agentId!)"
          >
            <Icon v-if="chatStore.systemPromptLoading" name="loader-circle" :size="14" class="spp-spin" />
            <Icon v-else name="refresh-cw" :size="14" />
          </button>
        </Tooltip>
        <Tooltip
          v-if="chatStore.systemPromptContent"
          :text="chatStore.copyFeedback ? '已复制' : '复制全文'"
          placement="bottom"
        >
          <button
            class="spp-btn"
            :class="{ copied: chatStore.copyFeedback }"
            @click="copyText(chatStore.systemPromptContent)"
          >
            <Icon v-if="chatStore.copyFeedback" name="check" :size="14" />
            <Icon v-else name="copy" :size="14" />
          </button>
        </Tooltip>
      </div>
    </div>
    <div class="spp-body">
      <div v-if="inGroupView" class="spp-empty">群聊无单一 System Prompt——切换到 1v1 或独立会话查看</div>
      <template v-else>
        <div v-if="chatStore.systemPromptLoading" class="spp-loading"><span class="spp-spinner"></span><span>正在组装 System Prompt…</span></div>
        <div v-else-if="chatStore.systemPromptError" class="spp-error">{{ chatStore.systemPromptError }}</div>
        <pre v-else-if="chatStore.systemPromptContent" class="spp-content">{{ chatStore.systemPromptContent }}</pre>
        <div v-else class="spp-empty">{{ agentId ? '点击右上刷新组装当前 Agent 的完整提示词' : '在主侧边栏选择一个 Agent 后查看其 System Prompt' }}</div>
      </template>
    </div>
    <div v-if="chatStore.systemPromptContent" class="spp-foot">
      共 {{ chatStore.systemPromptContent.length }} 字符
    </div>
  </div>
</template>

<style scoped>
.spp-panel {
  display: flex; flex-direction: column;
  height: 100%; min-width: 0; overflow: hidden;
  background: var(--color-bg-page, #fff);
}
.spp-head {
  display: flex; align-items: center; gap: 8px;
  height: var(--layout-header-height, 48px); padding: 0 16px; flex-shrink: 0;
  border-bottom: 1px solid var(--color-border-secondary, #e0e0e0);
}
.spp-title {
  font-size: 13px; font-weight: 600; flex: 1; min-width: 0;
  display: flex; align-items: baseline; gap: 0;
  overflow: hidden; white-space: nowrap;
}
.spp-sep { font-style: normal; font-weight: 400; color: var(--color-text-tertiary); padding: 0 6px; }
.spp-actions { display: flex; gap: 4px; flex-shrink: 0; }
/* icon 动作按钮（刷新/复制）：与预览页 fpt-icon-btn 同形态——24×22
   透明图标钮 + hover 底色 + Tooltip 提示 */
.spp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  padding: 0;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.spp-btn:hover { background: var(--color-bg-hover, rgba(0,0,0,0.06)); color: var(--color-text-primary); }
.spp-btn:disabled { opacity: 0.5; cursor: default; }
.spp-btn.copied { color: var(--color-success, #10b981); }
/* 刷新中 spinner 旋转 */
.spp-spin { animation: spp-btn-rotate 0.8s linear infinite; }
@keyframes spp-btn-rotate { to { transform: rotate(360deg); } }
.spp-body { flex: 1; min-height: 0; overflow: auto; }
.spp-content {
  margin: 0; padding: 14px 16px;
  font-size: 12px; line-height: 1.7;
  font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  white-space: pre-wrap; word-break: break-word;
  color: var(--color-text-primary);
}
.spp-loading, .spp-empty {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 40px 20px; color: var(--color-text-tertiary); font-size: 12px;
  text-align: center;
}
.spp-error { padding: 20px; color: var(--color-error, #e74c3c); font-size: 12px; }
.spp-spinner {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid var(--color-border-secondary, #ddd);
  border-top-color: var(--color-primary, #6366f1);
  animation: spp-spin 0.8s linear infinite;
}
@keyframes spp-spin { to { transform: rotate(360deg); } }
.spp-foot {
  padding: 4px 16px; flex-shrink: 0;
  border-top: 1px solid var(--color-border-secondary, #e0e0e0);
  font-size: 10px; color: var(--color-text-tertiary);
}
</style>

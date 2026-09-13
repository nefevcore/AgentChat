<!-- ApprovalBar.vue —— 提权审批 dock 卡（composer 上方；access-tier §六消费面）
  base 档 Agent 在有人会话里调用 needPermission=true 工具（write/bash/web_search…）
  时，ac-security 经 durableInteraction 开出 kind='approval' 审批卡。审批卡全文
  展示工具 + 参数 + 档位说明（防审批疲劳的 UX 责任在本卡）：
  · 批准 = 本次调用按 full-access 执行（单次有效，不持久化——持久授权走
    agentAdmin 改 tags 升档）；
  · 拒绝 = 本次调用被拒（Agent 收到明确说明）。
  外壳与密度对齐 dock 卡族规范（InteractionBar/QueueDock 同族）。 -->
<script setup lang="ts">
import { computed, watch, onUnmounted } from 'vue';
import { Icon } from '@agentchat/webui-kit';
import { useChatStore } from './chatStore.ts';

const chatStore = useChatStore();
const approval = computed(() => chatStore.approval);

/** 会话归属门控：同 InteractionBar（store 已按会话键路由，防御性复核） */
const visible = computed(() => {
  const it = approval.value;
  if (!it) return false;
  if (!it.agent_id || !it.key) return true;
  return it.agent_id === (chatStore.resolveContext()?.agentId ?? '');
});

/** 参数摘要展示：对象 pretty JSON，标量原样（bash 全文/写路径全文可读） */
const argsText = computed(() => {
  const a = approval.value?.args;
  if (a === null || a === undefined) return '';
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a, null, 2);
  } catch {
    return String(a);
  }
});

/** 超时自动关闭（有 deadline 时；0 = 永不——后端在永久等待） */
let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
watch(approval, (val) => {
  if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
  if (!val) return;
  if (val.timeout_ms) {
    timeoutTimer = setTimeout(() => {
      if (chatStore.approval?.interaction_id === val.interaction_id) {
        chatStore.respondApproval(false); // 超时视同拒绝（后端 close 也会同步）
      }
    }, val.timeout_ms);
  }
});
onUnmounted(() => { if (timeoutTimer) clearTimeout(timeoutTimer); });

function decide(approved: boolean) {
  chatStore.respondApproval(approved);
}
</script>

<template>
  <div v-if="approval && visible" class="approval-bar">
    <Transition name="ab-card-in" appear>
      <section class="ab-card">
        <!-- 头部：eyebrow（申请方 + 工具）+ 档位说明 -->
        <header class="ab-header">
          <div class="ab-heading">
            <div class="ab-eyebrow">提权请求 · {{ approval.agent_id || 'Agent' }} → {{ approval.tool }}</div>
            <p v-if="approval.need" class="ab-need">{{ approval.need }}</p>
          </div>
          <div class="ab-header-actions">
            <button type="button" class="ab-icon-btn" title="拒绝本次请求" @click="decide(false)">
              <Icon name="x" :size="13" />
            </button>
          </div>
        </header>

        <!-- 参数全文（审批展示的是该次调用的完整参数——不截断遮掩） -->
        <div v-if="argsText" class="ab-body">
          <pre class="ab-args">{{ argsText }}</pre>
        </div>

        <!-- 底部：拒绝 / 批准（批准 = 本次按 full-access 执行，单次有效） -->
        <footer class="ab-footer">
          <div class="ab-note">批准仅对本次调用生效；持久授权请在 Agent 配置 tags 中添加档位标签。</div>
          <div class="ab-actions">
            <button type="button" class="ab-btn outline" @click="decide(false)">拒绝</button>
            <button type="button" class="ab-btn primary" @click="decide(true)">批准（本次）</button>
          </div>
        </footer>
      </section>
    </Transition>
  </div>
</template>

<style scoped>
.approval-bar {
  /* dock 卡定位（对齐 InteractionBar/QueueDock：与输入卡同宽、随 composer 列排布） */
  flex-shrink: 0;
  margin: 0 10px 6px;
}

.ab-card {
  display: flex;
  flex-direction: column;
  max-height: min(50vh, 400px);
  background: var(--color-bg-secondary, var(--color-bg-page));
  border: 1px solid var(--color-border-secondary);
  border-radius: var(--radius-lg);
  overflow: hidden;
  /* 与输入卡同级的层次感（轻 --shadow-input 一档——辅助浮层不争主操作位焦点）；
     双主题值见 webui-kit tokens.css --shadow-dock（InteractionBar .ib-card 同款） */
  box-shadow: var(--shadow-dock, 0 1px 2px rgba(0, 0, 0, 0.04), 0 2px 8px rgba(0, 0, 0, 0.06));
}

/* ── 头部（密度对齐 dock 族：6px 12px 内距） ── */
.ab-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 8px 6px 12px;
}
.ab-heading { min-width: 0; }
.ab-eyebrow {
  margin-bottom: 4px;
  font-size: 11px;
  line-height: 16px;
  color: var(--color-text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ab-need {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  color: var(--color-text-primary);
  word-break: break-word;
}
.ab-header-actions { display: flex; flex-shrink: 0; align-items: center; gap: 2px; }

.ab-icon-btn {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--color-text-tertiary);
  cursor: pointer;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.ab-icon-btn:hover { background: var(--color-bg-hover, rgba(0,0,0,.04)); color: var(--color-text-primary); }

/* ── 参数全文（滚动兜底：超长时内部滚） ── */
.ab-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.ab-args {
  margin: 0;
  padding: 6px 12px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  line-height: 18px;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}

/* ── 底部：说明 + 动作 ── */
.ab-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px 8px 12px;
}
.ab-note {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--color-text-tertiary);
}
.ab-actions { display: flex; flex-shrink: 0; align-items: center; gap: 6px; }
.ab-btn {
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  cursor: pointer;
  transition: opacity var(--dur-fast), background var(--dur-fast), border-color var(--dur-fast);
}
.ab-btn.outline {
  background: transparent;
  border: 1px solid var(--color-border-primary);
  color: var(--color-text-secondary);
}
.ab-btn.outline:hover { color: var(--color-text-primary); border-color: var(--color-text-tertiary); }
.ab-btn.primary {
  background: var(--color-primary);
  border: 1px solid var(--color-primary);
  color: #fff;
}
.ab-btn.primary:hover { background: var(--color-primary-hover); border-color: var(--color-primary-hover); }

/* ── 卡片入场 ── */
.ab-card-in-enter-active { transition: opacity 0.16s var(--ease-out), transform 0.16s var(--ease-out); }
.ab-card-in-enter-from { opacity: 0; transform: translateY(6px); }
</style>

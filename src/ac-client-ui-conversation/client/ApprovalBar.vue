<!-- ApprovalBar.vue —— 提权审批 dock 卡（composer 上方；access-tier §六消费面）
  base 档 Agent 在有人会话里调用 needPermission=true 工具（write/bash/web_search…）
  时，ac-security 经 durableInteraction 开出 kind='approval' 审批卡。审批卡全文
  展示工具 + 参数 + 档位说明（防审批疲劳的 UX 责任在本卡）：
  · 批准（2026-09-17 两档）：「通过（本次）」= 本次调用按 full-access 执行（单次
    有效，不持久化）；下拉可改选「通过（本轮全部）」= 本轮 run 内后续
    needPermission 调用免再询问，run 收束自动失效（内存授权，不持久化）；
    持久授权走 agentAdmin 改 tags 升档；
  · 拒绝 = 本次调用被拒（Agent 收到明确说明）。
  外壳与密度对齐 dock 卡族规范（InteractionBar/QueueDock 同族）。 -->
<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue';
import { DockCard, Icon } from '@agentchat/webui-kit';
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

/** 批准范围（2026-09-17 功能增强）：'call' 仅本次（缺省）| 'run' 本轮全部 */
const approveScope = ref<'call' | 'run'>('call');

function decide(approved: boolean, scope: 'call' | 'run' = 'call') {
  chatStore.respondApproval(approved, scope);
}
</script>

<template>
  <Transition name="ab-card-in" appear>
    <DockCard
      v-if="approval && visible"
      class="approval-bar"
      :eyebrow="`提权请求 · ${approval.agent_id || 'Agent'} → ${approval.tool}`"
    >
      <template #actions>
        <button type="button" class="ab-icon-btn" title="拒绝本次请求" @click="decide(false)">
          <Icon name="x" :size="13" />
        </button>
      </template>

      <!-- 档位说明（申请方诉求——审批全文的第一段） -->
      <p v-if="approval.need" class="ab-need">{{ approval.need }}</p>

      <!-- 参数全文（审批展示的是该次调用的完整参数——不截断遮掩） -->
      <div v-if="argsText" class="ab-body">
        <pre class="ab-args">{{ argsText }}</pre>
      </div>

      <!-- 底部：拒绝 / 批准两档（主钮"通过（本次）"；下拉可改选
           "通过（本轮 run）全部"——本轮 run 内后续 needPermission 调用
           免再询问，run 收束自动失效） -->
      <footer class="ab-footer">
        <div class="ab-note">
          {{ approveScope === 'run'
            ? '本轮 run 内的后续提权请求不再询问；run 结束自动失效（内存授权，不持久化）。'
            : '批准仅对本次调用生效；持久授权请在 Agent 配置 tags 中添加档位标签。' }}
        </div>
        <div class="ab-actions">
          <button type="button" class="ab-btn outline" @click="decide(false)">拒绝</button>
          <div class="ab-approve-split">
            <button type="button" class="ab-btn primary" @click="decide(true, approveScope)">通过（{{ approveScope === 'run' ? '本轮全部' : '本次' }}）</button>
            <select v-model="approveScope" class="ab-scope-select" title="批准范围：仅本次 / 本轮 run 全部" aria-label="批准范围">
              <option value="call">通过（本次）</option>
              <option value="run">通过（本轮全部）</option>
            </select>
          </div>
        </div>
      </footer>
    </DockCard>
  </Transition>
</template>

<style scoped>
.approval-bar {
  /* dock 卡定位（壳由 kit DockCard 提供：与输入卡同宽、随 composer 列排布） */
  flex-shrink: 0;
}

/* 档位说明（原 ab-header/ab-heading/ab-eyebrow 已随 DockCard 壳归位） */
.ab-need {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  color: var(--text-1);
  word-break: break-word;
}

.ab-icon-btn {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-3);
  cursor: pointer;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.ab-icon-btn:hover { background: var(--bg-hover); color: var(--text-1); }

/* ── 参数全文（滚动兜底：超长时内部滚） ── */
.ab-body {
  /* 原 50vh/400px 上限挂在卡片上；改挂参数区（DockCard 壳无 max-height） */
  max-height: min(50vh, 400px);
  overflow-y: auto;
  overscroll-behavior: contain;
}
.ab-args {
  margin: 0;
  padding: 6px 12px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  line-height: 18px;
  color: var(--text-2);
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
  color: var(--text-3);
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
  border: 1px solid var(--line-strong);
  color: var(--text-2);
}
.ab-btn.outline:hover { color: var(--text-1); border-color: var(--text-3); }
.ab-btn.primary {
  background: var(--primary);
  border: 1px solid var(--primary);
  color: var(--on-primary);
}
.ab-btn.primary:hover { background: var(--primary-strong); border-color: var(--primary-strong); }

/* ── 批准两档：主钮 + 范围下拉（覆盖式 select，视觉融合为分组按钮） ── */
.ab-approve-split { display: flex; align-items: stretch; }
.ab-approve-split .ab-btn.primary { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.ab-scope-select {
  width: 18px;
  padding: 0 2px;
  border: 1px solid var(--primary);
  border-left: none;
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: var(--primary);
  color: transparent; /* 收起态只显示箭头指示（文本对视觉无用——当前档位在主钮上） */
  font-size: 12px;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  text-align: center;
  text-indent: 100%;
  overflow: hidden;
  /* 一次性 SVG 数据色（%23ffffff = 下拉箭头白描边，跟 ab-btn.primary 实底；
     非调色板色值，按指南 R1 例外保留）。 */
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='6' viewBox='0 0 8 6'%3E%3Cpath d='M1 1l3 3 3-3' stroke='%23ffffff' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: center;
}
.ab-scope-select::-ms-expand { display: none; }
.ab-scope-select:hover { background-color: var(--primary-strong); }
.ab-scope-select option { color: var(--text-1); background: var(--bg-surface); }

/* ── 卡片入场 ── */
.ab-card-in-enter-active { transition: opacity 0.16s var(--ease-out), transform 0.16s var(--ease-out); }
.ab-card-in-enter-from { opacity: 0; transform: translateY(6px); }
</style>

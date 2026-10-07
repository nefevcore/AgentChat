<script setup lang="ts">
// ============================================================
// client/WizardOverlay.vue —— 首启向导壳（overlay 席位宿主）
//
// 形态（plan §3.1）：左侧步骤条（序号/✓/副标题 + 顶部模型状态行）、
// 右侧内容区（eyebrow + 标题 + 导语 + 步骤组件 + 进度条）、底部
// 跳过/上一步/下一步。点步骤条可跳步。右上 ✕ 等同「跳过引导」。
// 未配模型跳过 → 一次确认（§3.4）。窄屏（≤768px）全屏卡片 + 步骤
// 条横向滚动（kit Modal 已内建窄屏全屏——布局差异走容器内响应式）。
// ============================================================
import { computed, onMounted, ref } from 'vue';
import type { Component } from 'vue';
import { Button, Icon } from '@agentchat/webui-kit';
import { getPools } from 'ac-client-ui-settings/client/api.ts';
import ProfileStep from './steps/ProfileStep.vue';
import LlmStep from './steps/LlmStep.vue';
import SearchStep from './steps/SearchStep.vue';
import AgentStep from './steps/AgentStep.vue';
import TourStep from './steps/TourStep.vue';
import { readMark, writeMark, ONBOARDING_STEPS, STEP_META, shouldConfirmSkip, type OnboardingStepId } from './onboardingState.ts';
import { useOnboardingBus } from './onboardingBus.ts';

// ── 打开态与首启触发 ──
const open = ref(false);
const stepIndex = ref(0);

const stepId = computed<OnboardingStepId>(() => ONBOARDING_STEPS[stepIndex.value]);
const isLast = computed(() => stepIndex.value === ONBOARDING_STEPS.length - 1);

const STEP_COMPONENTS: Record<OnboardingStepId, Component> = {
  profile: ProfileStep,
  llm: LlmStep,
  search: SearchStep,
  agent: AgentStep,
  tour: TourStep,
};

// ── 模型已配状态（步骤条顶部状态行 + 跳过确认判据）──
const llmCount = ref(-1); // -1 = 未探得
async function probeLlm(): Promise<void> {
  try {
    const pools = await getPools();
    llmCount.value = Object.keys(pools.llmProviders).filter((k) => !k.startsWith('$')).length;
  } catch {
    llmCount.value = -1; // RPC 失败静默降级（不确认、不标状态）
  }
}

// 步骤完成标记（步骤内保存/创建成功后上报；侧栏打 ✓）
const done = ref<Set<OnboardingStepId>>(new Set());
function markDone(id: OnboardingStepId): void {
  const next = new Set(done.value);
  next.add(id);
  done.value = next;
}
// 池计数联动：第 2 步保存成功后刷新（覆盖 llmCount 与 ✓ 判定）
function onLlmSaved(): void {
  markDone('llm');
  void probeLlm();
}

// ── 跳过确认（§3.4/D5：无 llm 连接时拦一次）──
const skipConfirmVisible = ref(false);
const skipConfirmedOnce = ref(false);

function requestSkip(): void {
  if (shouldConfirmSkip(Math.max(llmCount.value, 0), skipConfirmedOnce.value)) {
    skipConfirmVisible.value = true;
    return;
  }
  finish();
}

function confirmSkip(): void {
  skipConfirmedOnce.value = true;
  skipConfirmVisible.value = false;
  finish();
}

function cancelSkip(): void {
  skipConfirmVisible.value = false;
  if (llmCount.value === 0) stepIndex.value = ONBOARDING_STEPS.indexOf('llm'); // 回去配置
}

/** 走完/跳过：写标记 + 关闭 */
function finish(): void {
  if (typeof window !== 'undefined') writeMark(window.localStorage);
  open.value = false;
  skipConfirmVisible.value = false;
}

// ── 首启触发：boot 就绪后弹（§3.3——避免与 splash 抢首帧）──
function maybeAutoOpen(): void {
  if (typeof window === 'undefined') return;
  if (readMark(window.localStorage)) return;
  open.value = true;
  stepIndex.value = 0;
}

onMounted(() => {
  void probeLlm();
  // boot-ready 已发生（标志在场）→ 立即判定；否则等事件（域行装载在
  // mount 之前完成——本组件挂载时 boot 流程尚在 app.mount 之后收尾，
  // 事件大概率未及派发；两分支全覆盖，时序无关）
  if ((window as unknown as Record<string, unknown>).__agentchatBootReady) {
    maybeAutoOpen();
    return;
  }
  window.addEventListener('agentchat:boot-ready', maybeAutoOpen, { once: true });
});

// ── 重播入口（更多菜单经事件总线打开——批 4 席位化前的轻量通道）──
const { offBus } = useOnboardingBus(() => {
  stepIndex.value = 0; // 重播重置到第 1 步
  done.value = new Set();
  skipConfirmedOnce.value = false;
  open.value = true;
  void probeLlm();
});

function goNext(): void {
  if (!isLast.value) stepIndex.value += 1;
  else finish();
}
function goPrev(): void {
  if (stepIndex.value > 0) stepIndex.value -= 1;
}

const progress = computed(() => Math.round(((stepIndex.value + 1) / ONBOARDING_STEPS.length) * 100));
const eyebrow = computed(() => `第 ${stepIndex.value + 1} 步 / 共 ${ONBOARDING_STEPS.length} 步`);

// 当前步骤组件
const currentComponent = computed<Component>(() => STEP_COMPONENTS[stepId.value]);
</script>

<template>
  <Teleport to="body">
    <Transition name="ob-fade">
      <div v-if="open" class="ob-overlay" role="dialog" aria-modal="true" aria-label="新手引导">
        <div class="ob-backdrop" />
        <div class="ob-shell">
          <!-- 左侧步骤条 -->
          <aside class="ob-steps">
            <div class="ob-steps-head">
              <span class="ob-steps-title">新手引导</span>
              <span class="ob-steps-status" :class="llmCount > 0 ? 'is-ok' : ''">
                模型：{{ llmCount > 0 ? '已配置' : '未配置' }}
              </span>
            </div>
            <button
              v-for="(id, i) in ONBOARDING_STEPS" :key="id"
              type="button" class="ob-step" :class="{ active: i === stepIndex, done: done.has(id) }"
              @click="stepIndex = i"
            >
              <span class="ob-step-no">{{ done.has(id) ? '✓' : i + 1 }}</span>
              <span class="ob-step-text">
                <span class="ob-step-title">{{ STEP_META[id].title }}</span>
                <span class="ob-step-sub">{{ STEP_META[id].sub }}</span>
              </span>
            </button>
          </aside>

          <!-- 右侧内容区 -->
          <div class="ob-main">
            <div class="ob-main-head">
              <div class="ob-head-text">
                <span class="ob-eyebrow">{{ eyebrow }}</span>
                <h2 class="ob-title">{{ STEP_META[stepId].title }}</h2>
              </div>
              <button type="button" class="ob-close" aria-label="跳过引导" title="跳过引导" @click="requestSkip">
                <Icon name="x" :size="18" />
              </button>
            </div>
            <p class="ob-lead">{{ STEP_META[stepId].lead }}</p>
            <div class="ob-body">
              <component :is="currentComponent" :key="stepId" :llm-count="llmCount" @done="markDone(stepId)" @llm-saved="onLlmSaved" @search-saved="markDone('search')" @agent-created="markDone('agent')" />
            </div>
            <div class="ob-foot">
              <span class="ob-progress" :title="`${progress}%`"><span class="ob-progress-fill" :style="{ width: progress + '%' }" /></span>
              <span class="ob-progress-label">{{ stepIndex + 1 }} / {{ ONBOARDING_STEPS.length }}</span>
              <span class="ob-foot-spacer" />
              <Button variant="ghost" @click="requestSkip">跳过引导</Button>
              <Button v-if="stepIndex > 0" variant="ghost" @click="goPrev">上一步</Button>
              <Button variant="primary" @click="goNext">{{ isLast ? '完成' : '下一步' }}</Button>
            </div>
          </div>
        </div>

        <!-- 跳过确认（§3.4/D5） -->
        <div v-if="skipConfirmVisible" class="ob-confirm" role="alertdialog" aria-label="确认跳过">
          <div class="ob-confirm-card">
            <h3>还没配置模型连接</h3>
            <p>现在跳过的话，Agent 将无法回复任何消息。之后可以在<b>设置 → 模型管理</b>补配，或在<b>更多 → 新手引导</b>重新打开。</p>
            <div class="ob-confirm-actions">
              <Button variant="primary" @click="cancelSkip">回去配置</Button>
              <Button variant="ghost" @click="confirmSkip">仍然跳过</Button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 覆盖层：overlay 席位 z 配额之下（席位条目不自选高位——§5.3）；
   940×640（plan §3.1），窄屏全屏 */
.ob-overlay { position: fixed; inset: 0; z-index: 1100; display: flex; align-items: center; justify-content: center; }
.ob-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.45); }
.ob-shell {
  position: relative; width: min(940px, 100%); height: min(640px, 100%);
  background: var(--bg-raised); border: 1px solid var(--line);
  border-radius: var(--r-lg); box-shadow: var(--shadow-panel), var(--elev-hairline);
  display: flex; overflow: hidden;
}
.ob-steps {
  width: 220px; flex-shrink: 0; border-right: 1px solid var(--line);
  background: var(--bg-surface); padding: 16px 10px; display: flex; flex-direction: column; gap: 4px;
}
.ob-steps-head { padding: 0 8px 12px; display: flex; flex-direction: column; gap: 4px; }
.ob-steps-title { font-size: var(--fs-md); font-weight: 600; color: var(--text-1); }
.ob-steps-status { font-size: var(--fs-2xs); color: var(--text-3); }
.ob-steps-status.is-ok { color: var(--ok); }
.ob-step {
  display: flex; align-items: center; gap: 10px; padding: 8px; border: none;
  border-radius: var(--r-md); background: none; cursor: pointer; text-align: left;
  color: var(--text-3); transition: background var(--dur-fast);
}
.ob-step:hover { background: var(--bg-hover); }
.ob-step.active { background: var(--role-selected-bg); color: var(--text-1); }
.ob-step.done { color: var(--text-2); }
.ob-step-no {
  width: 22px; height: 22px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%; border: 1px solid var(--line-strong); font-size: var(--fs-2xs);
}
.ob-step.done .ob-step-no { border-color: var(--ok); color: var(--ok); background: rgba(var(--ok-rgb), 0.12); }
.ob-step.active .ob-step-no { border-color: var(--primary); color: var(--primary); }
.ob-step-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.ob-step-title { font-size: var(--fs-sm); font-weight: 500; }
.ob-step-sub { font-size: var(--fs-2xs); opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.ob-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ob-main-head { display: flex; align-items: flex-start; justify-content: space-between; padding: 20px 24px 0; }
.ob-eyebrow { font-size: var(--fs-2xs); color: var(--primary); font-weight: 600; letter-spacing: 0.04em; }
.ob-title { margin: 4px 0 0; font-size: var(--fs-xl); font-weight: 700; color: var(--text-1); }
.ob-close {
  border: none; background: none; color: var(--text-3); cursor: pointer;
  width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--r-sm);
}
.ob-close:hover { background: var(--bg-hover); color: var(--text-1); }
.ob-lead { margin: 8px 24px 0; font-size: var(--fs-sm); color: var(--text-2); }
.ob-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 24px; }
.ob-foot {
  display: flex; align-items: center; gap: 8px; padding: 12px 24px 16px;
  border-top: 1px solid var(--line);
}
.ob-progress { width: 120px; height: 4px; background: var(--bg-inset); border-radius: var(--r-full); overflow: hidden; }
.ob-progress-fill { display: block; height: 100%; background: var(--primary); transition: width var(--dur-base) var(--ease-out); }
.ob-progress-label { font-size: var(--fs-2xs); color: var(--text-3); }
.ob-foot-spacer { flex: 1; }

/* 跳过确认卡片 */
.ob-confirm { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.4); }
.ob-confirm-card {
  width: min(400px, 90%); background: var(--bg-raised); border: 1px solid var(--line);
  border-radius: var(--r-md); box-shadow: var(--shadow-panel); padding: 20px;
}
.ob-confirm-card h3 { margin: 0 0 8px; font-size: var(--fs-md); color: var(--text-1); }
.ob-confirm-card p { margin: 0 0 16px; font-size: var(--fs-sm); color: var(--text-2); line-height: 1.6; }
.ob-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* 窄屏（≤768px）：全屏卡片 + 步骤条横滚（plan §3.1） */
@media (max-width: 768px) {
  .ob-shell { width: 100vw; height: 100dvh; border-radius: 0; border: 0; flex-direction: column; padding-top: var(--safe-top, 0px); }
  .ob-steps { width: auto; flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: 10px 12px; }
  .ob-steps-head { padding: 0 4px 0 0; justify-content: center; }
  .ob-step { flex-shrink: 0; padding: 6px; }
  .ob-step-text { display: none; }
  .ob-main-head { padding: 14px 16px 0; }
  .ob-lead { margin: 6px 16px 0; }
  .ob-body { padding: 12px 16px; padding-bottom: calc(12px + var(--safe-bottom, 0px)); }
  .ob-foot { padding: 10px 16px 12px; }
  .ob-progress { width: 60px; }
}

.ob-fade-enter-active, .ob-fade-leave-active { transition: opacity var(--dur-base) var(--ease-out); }
.ob-fade-enter-from, .ob-fade-leave-to { opacity: 0; }
</style>

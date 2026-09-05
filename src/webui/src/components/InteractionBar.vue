<!-- InteractionBar.vue —— ask_questions 决策 dock 卡（composer 上方）
  Agent 通过 ask_questions 工具请求用户决策时，在 DialogView composer 列
  渲染一张 dock 卡（TaskDock/QueueDock 同族——输入框上方的独立卡，不内联
  在输入卡内挤压输入区）。布局与交互对齐 DeepSeek Harness 的
  QuestionComposer，外壳与密度对齐 dock 卡族规范（TodoPanel/QueueDock：
  margin 0 10px 6px / 边框 / 圆角 / 无阴影扁平卡 / 13px 正文 · 6~12px 内距）：
  · 卡片 = 头部（eyebrow 提问方 + 完整问题标题 + 收起/关闭）+ 选项区 + 底部
    （分页器 ‹i/N› / 错误反馈 / 跳过 + 下一题·提交）；
  · 一次只看一题：点选项即选中并自动翻到下一题；末题点选后由主按钮提交；
  · 每题可改选、可输入其他回答（与选项互斥）、可跳过（提交 null）；
  · 收起（chevron）只留头部条不遮挡会话；关闭（×）收起卡片（后端工具
    仍在等待，late-reply 对账由后端负责）；超时自动关闭。 -->
<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import Icon from '../ui/Icon.vue';
import { useChatStore } from '../stores/chat';

const chatStore = useChatStore();
const interaction = computed(() => chatStore.interaction);

/** 当前题页码；多题逐题作答（DSH 分页模型），单题即 0/1 */
const index = ref(0);
/** 作答草稿：selected/custom 互斥；skipped 为显式跳过（提交 null） */
const drafts = ref<Array<{ selected: string | null; custom: string; skipped: boolean }>>([]);
/** 收起态：只留头部条（问题仍可见，作答区折叠不遮挡会话流） */
const minimized = ref(false);
/** 底部反馈文案（未答就翻页/提交时提示，随任意作答清除） */
const feedback = ref('');

/** 会话归属门控：store 的 interaction 已按当前上下文会话键路由（多 Agent
 *  并发提问时各答各的，不再全局单槽串台），此处仅防御性复核——带 key 的
 *  新载荷 store 侧已精确匹配，无 key 旧载荷按 agent 对齐；无 agent_id
 *  的最旧载荷放行（兼容）。 */
const visible = computed(() => {
  const it = interaction.value;
  if (!it) return false;
  if (!it.agent_id || !it.key) return true;
  return it.agent_id === (chatStore.resolveContext()?.agentId ?? '');
});

const questions = computed(() => interaction.value?.questions ?? []);
const question = computed(() => questions.value[index.value]);
const isLast = computed(() => index.value >= questions.value.length - 1);
const isMulti = computed(() => questions.value.length > 1);
/** 当前题已答（选中选项或非空自定义） */
const answered = computed(() => {
  const d = drafts.value[index.value];
  return !!d && (!!d.selected || d.custom.trim() !== '');
});

/** 超时自动关闭：后端超时后选项残留会"点了没反应" */
let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
watch(interaction, (val) => {
  if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
  index.value = 0;
  feedback.value = '';
  minimized.value = false;
  drafts.value = (val?.questions ?? []).map(() => ({ selected: null, custom: '', skipped: false }));
  if (!val) return;
  if (val.timeout_ms) {
    timeoutTimer = setTimeout(() => {
      if (chatStore.interaction?.interaction_id === val.interaction_id) {
        chatStore.dismissInteraction();
      }
    }, val.timeout_ms);
  }
});
onUnmounted(() => { if (timeoutTimer) clearTimeout(timeoutTimer); });

/** 点选项 = 选中（清自定义——互斥）；非末题自动翻页（DSH choose 语义） */
function choose(option: string) {
  const d = drafts.value[index.value];
  if (!d) return;
  d.selected = option;
  d.custom = '';
  d.skipped = false;
  feedback.value = '';
  if (!isLast.value) index.value += 1;
}

/** 输入自定义回答 = 清除选项选中（互斥）；显式跳过状态作废 */
function onCustomInput() {
  const d = drafts.value[index.value];
  if (!d) return;
  d.skipped = false;
  if (d.custom.trim()) {
    d.selected = null;
    feedback.value = '';
  }
}

/** 主按钮：未答拦下提示；非末题翻页，末题校验全卷后一次提交 */
function continueFlow() {
  if (!answered.value) {
    feedback.value = '请选择一个选项或填写自定义回答。';
    return;
  }
  if (!isLast.value) {
    index.value += 1;
    feedback.value = '';
    return;
  }
  submitAll();
}

/** 跳过当前题（提交 null）；非末题翻页，末题直接交卷 */
function skipQuestion() {
  const d = drafts.value[index.value];
  if (d) {
    d.selected = null;
    d.custom = '';
    d.skipped = true;
  }
  feedback.value = '';
  if (!isLast.value) {
    index.value += 1;
    return;
  }
  submitAll();
}

/** 一次提交全部——answers 与 questions 对齐，未答/跳过的题传 null
 *  （工具结果如实呈现"用户跳过"，Agent 自行决断）。有漏答题跳回并提示。 */
function submitAll() {
  const qs = questions.value;
  const missing = drafts.value.findIndex((d) => !d.selected && !d.custom.trim() && !d.skipped);
  if (missing >= 0) {
    index.value = missing;
    feedback.value = '请先完成这道问题。';
    return;
  }
  const answers = qs.map((_, i) => {
    const d = drafts.value[i];
    if (!d) return null;
    return d.custom.trim() || d.selected || null;
  });
  chatStore.respondInteraction(answers);
}

/** 自定义输入 Enter = 翻页/提交（Shift+Enter 换行；输入法组合中不触发） */
function onCustomKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  continueFlow();
}

function step(delta: number) {
  index.value += delta;
  feedback.value = '';
}
</script>

<template>
  <div v-if="interaction && visible" class="interaction-bar">
    <Transition name="ib-card-in" appear>
      <section class="ib-card" :class="{ minimized }">
        <!-- 头部：提问方 eyebrow + 完整问题（不截断）+ 收起/关闭 -->
        <header class="ib-header">
          <div class="ib-heading">
            <div class="ib-eyebrow">决策请求 · {{ interaction.agent_id || 'Agent' }}</div>
            <h3 class="ib-title">{{ question?.question }}</h3>
          </div>
          <div class="ib-header-actions">
            <button
              type="button"
              class="ib-icon-btn"
              :title="minimized ? '展开' : '收起'"
              :aria-expanded="!minimized"
              @click="minimized = !minimized"
            >
              <Icon :name="minimized ? 'chevron-down' : 'chevron-up'" :size="13" />
            </button>
            <button type="button" class="ib-icon-btn" title="关闭（Agent 仍在等待，刷新页面可恢复作答入口）" @click="chatStore.dismissInteraction()">
              <Icon name="x" :size="13" />
            </button>
          </div>
        </header>

        <template v-if="!minimized">
          <!-- 选项区：整行选项（序号徽标 + 文案），选中 = 底色 + 主色描边；
               末行自定义输入（铅笔图标，与选项互斥） -->
          <div class="ib-body">
            <div class="ib-options" role="radiogroup" :aria-label="question?.question">
              <button
                v-for="(opt, oi) in question?.options ?? []"
                :key="oi"
                type="button"
                role="radio"
                :aria-checked="drafts[index]?.selected === opt"
                class="ib-option"
                :class="{ selected: drafts[index]?.selected === opt }"
                @click="choose(opt)"
              >
                <span class="ib-number">{{ oi + 1 }}</span>
                <span class="ib-option-label">{{ opt }}</span>
              </button>
              <div class="ib-custom-row" :class="{ active: !!drafts[index]?.custom.trim() }">
                <span class="ib-number" aria-hidden="true"><Icon name="pencil" :size="11" /></span>
                <input
                  v-model="drafts[index]!.custom"
                  class="ib-custom-input"
                  placeholder="或输入其他回答…"
                  @input="onCustomInput"
                  @keydown="onCustomKeydown"
                />
              </div>
            </div>
          </div>

          <!-- 底部：分页器（多题）+ 反馈 + 跳过 / 下一题·提交 -->
          <footer class="ib-footer">
            <div v-if="isMulti" class="ib-pager">
              <button type="button" class="ib-icon-btn" :disabled="index === 0" title="上一题" @click="step(-1)">
                <Icon name="chevron-left" :size="13" />
              </button>
              <span class="ib-progress">{{ index + 1 }} / {{ questions.length }}</span>
              <button type="button" class="ib-icon-btn" :disabled="isLast" title="下一题" @click="step(1)">
                <Icon name="chevron-right" :size="13" />
              </button>
            </div>
            <div class="ib-feedback" role="status">{{ feedback }}</div>
            <div class="ib-actions">
              <button type="button" class="ib-btn outline" @click="skipQuestion">跳过</button>
              <button type="button" class="ib-btn primary" :disabled="!answered" @click="continueFlow">
                {{ isLast ? '提交回答' : '下一题' }}
              </button>
            </div>
          </footer>
        </template>
      </section>
    </Transition>
  </div>
</template>

<style scoped>
.interaction-bar {
  /* dock 卡定位（对齐 TaskDock/QueueDock：与输入卡同宽、随 composer 列排布；
     6px 下距 = dock 列纵向节奏） */
  flex-shrink: 0;
  margin: 0 10px 6px;
}

/* ── 卡片（DSH QuestionComposer 布局 × dock 卡外壳：边框扁平卡，无阴影；
      密度对齐 TodoPanel/QueueDock——13px 正文 / 6~12px 内距 / 22px 图标钮） ── */
.ib-card {
  display: flex;
  flex-direction: column;
  max-height: min(56vh, 440px);
  background: var(--color-bg-secondary, var(--color-bg-page));
  border: 1px solid var(--color-border-secondary);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.ib-card.minimized { max-height: none; }

/* ── 头部（密度对齐 TodoPanel 头行：6px 12px 内距 · 13px/500 标题） ── */
.ib-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 8px 6px 12px;
}
.ib-heading { min-width: 0; }
.ib-eyebrow {
  margin-bottom: 4px;
  font-size: 11px;
  line-height: 16px;
  color: var(--color-text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ib-title {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  color: var(--color-text-primary);
  word-break: break-word;
}
.ib-header-actions { display: flex; flex-shrink: 0; align-items: center; gap: 2px; }

/* 方形图标按钮（收起/关闭/翻页共用；对齐 QueueDock queue-act：22px · radius-sm） */
.ib-icon-btn {
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
.ib-icon-btn:hover:not(:disabled) { background: var(--color-bg-hover, rgba(0,0,0,.04)); color: var(--color-text-primary); }
.ib-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ── 选项区（滚动兜底：题干/选项超长时内部滚） ── */
.ib-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.ib-options {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 12px;
}
.ib-option,
.ib-custom-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 30px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  transition: background-color var(--dur-fast), border-color var(--dur-fast);
}
.ib-option {
  background: transparent;
  color: var(--color-text-primary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.ib-option:hover { background: var(--color-bg-hover, rgba(0,0,0,.04)); }
.ib-option.selected {
  background: var(--role-selected-bg, #e6eaff);
  border-color: var(--color-primary);
}
.ib-number {
  display: grid;
  place-items: center;
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-hover, rgba(0,0,0,.06));
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
}
.ib-option.selected .ib-number {
  background: var(--color-primary);
  color: #fff;
}
.ib-option-label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--color-text-primary);
  word-break: break-word;
}

/* ── 自定义输入行（与选项同构：铅笔徽标 + 无边框输入） ── */
.ib-custom-row:hover,
.ib-custom-row:focus-within { background: var(--color-bg-hover, rgba(0,0,0,.04)); }
.ib-custom-row.active { border-color: var(--color-primary); }
.ib-custom-input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  outline: none;
  font-size: 13px;
  line-height: 20px;
  color: var(--color-text-primary);
}
.ib-custom-input::placeholder { color: var(--color-text-tertiary); }

/* ── 底部：分页器 + 反馈 + 动作（密度对齐 dock 族：12px 元信息 · 紧凑按钮） ── */
.ib-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  padding: 0 10px 8px 12px;
}
.ib-pager { display: flex; flex-shrink: 0; align-items: center; gap: 4px; }
.ib-progress {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 500;
  line-height: 22px;
  font-variant-numeric: tabular-nums;
  padding: 0 2px;
}
.ib-feedback {
  flex: 1;
  min-height: 16px;
  text-align: right;
  font-size: 11px;
  line-height: 16px;
  color: var(--color-error);
}
.ib-actions { display: flex; flex-shrink: 0; align-items: center; gap: 6px; }
.ib-btn {
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  cursor: pointer;
  transition: opacity var(--dur-fast), background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
}
.ib-btn.outline {
  background: transparent;
  border: 1px solid var(--color-border-primary);
  color: var(--color-text-secondary);
}
.ib-btn.outline:hover { color: var(--color-text-primary); border-color: var(--color-text-tertiary); }
.ib-btn.primary {
  background: var(--color-primary);
  border: 1px solid var(--color-primary);
  color: #fff;
}
.ib-btn.primary:disabled { opacity: 0.4; cursor: not-allowed; }
.ib-btn.primary:not(:disabled):hover { background: var(--color-primary-hover); border-color: var(--color-primary-hover); }

/* ── 卡片入场（自下 6px 淡入上浮） ── */
.ib-card-in-enter-active { transition: opacity 0.16s var(--ease-out), transform 0.16s var(--ease-out); }
.ib-card-in-enter-from { opacity: 0; transform: translateY(6px); }
</style>

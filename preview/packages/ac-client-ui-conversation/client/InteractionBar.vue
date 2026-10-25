<!-- InteractionBar.vue —— ask_questions 决策 dock 卡（composer 上方）
  Agent 通过 ask_questions 工具请求用户决策时，在 ConversationView composer 列
  渲染一张 dock 卡（ComposerDock/QueueDock 同族——输入框上方的独立卡，不内联
  在输入卡内挤压输入区）。布局与交互对齐 DeepSeek Harness 的
  QuestionComposer，外壳与密度对齐 dock 卡族规范（TodoPanel/QueueDock：
  margin 0 10px 6px / 边框 / 圆角 / 无阴影扁平卡 / 13px 正文 · 6~12px 内距）：
  · 卡片 = 头部（eyebrow 提问方 + header 折叠/关闭）+ 选项区 + 底部
    （分页器 ‹i/N› / 错误反馈 / 跳过 + 下一题·提交）；
  · 一次只看一题：点选项即选中并自动翻到下一题；末题点选后由主按钮提交；
  · 每题可改选、可输入其他回答（与选项互斥）、可跳过（提交 null）；
  · 收起（点 header 整体折叠）只留头部条不遮挡会话；关闭（×）收起卡片（后端工具
    仍在等待，late-reply 对账由后端负责）；超时自动关闭。 -->
<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { DockCard, FeedbackNotice, Icon, OptionRow, Tooltip } from '@agentchat/webui-kit';
import { useChatStore } from './chatStore.ts';

const chatStore = useChatStore();
const interaction = computed(() => chatStore.interaction);

/** 当前题页码；多题逐题作答（DSH 分页模型），单题即 0/1 */
const index = ref(0);
/** 作答草稿：selected（勾选项数组，单选题提交时取首项）/custom 互斥；skipped 为显式跳过（提交 null） */
const drafts = ref<Array<{ selected: string[]; custom: string; skipped: boolean }>>([]);
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
const isMulti = computed(() => questions.value[index.value]?.multi === true);
/** 当前题已答（选中至少一项或非空自定义） */
const answered = computed(() => {
  const d = drafts.value.at(index.value);
  return !!d && (d.selected.length > 0 || d.custom.trim() !== '');
});

/** 超时自动关闭：后端超时后选项残留会"点了没反应" */
let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
/** 作答草稿与 interaction 同步（挂载即初始化——恢复路径下 dock 卡异步组件
 *  挂载时 interaction 已非空，watch 缺 immediate 会让 drafts 恒空 → 渲染读
 *  drafts[index].custom 崩溃 → slot 错误边界把 interaction 卡永久退位，
 *  表现为"刷新后弹窗不出现 + 后续所有提问都不弹"〔2026-09-12 反馈根因〕）。 */
function syncDrafts(val: typeof interaction.value): void {
  index.value = 0;
  feedback.value = '';
  minimized.value = false;
  drafts.value = (val?.questions ?? []).map(() => ({ selected: [] as string[], custom: '', skipped: false }));
}
watch(interaction, (val) => {
  if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
  syncDrafts(val);
  if (!val) return;
  if (val.timeout_ms) {
    timeoutTimer = setTimeout(() => {
      if (chatStore.interaction?.interaction_id === val.interaction_id) {
        chatStore.dismissInteraction();
      }
    }, val.timeout_ms);
  }
}, { immediate: true });
onUnmounted(() => { if (timeoutTimer) clearTimeout(timeoutTimer); });

/** 点选项：单选 = 覆盖选中并翻页（即选即走）；多选 = 增删勾选（停留本题）。
 *  两种都清自定义与跳过态（互斥）。 */
function choose(option: string) {
  const d = drafts.value.at(index.value);
  if (!d) return;
  if (isMulti.value) {
    d.selected = d.selected.includes(option)
      ? d.selected.filter((o) => o !== option)
      : [...d.selected, option];
  } else {
    d.selected = [option];
  }
  d.custom = '';
  d.skipped = false;
  feedback.value = '';
  if (!isMulti.value && !isLast.value) index.value += 1;
}

/** 输入自定义回答 = 清除全部选中（互斥）；显式跳过状态作废。
 *  受控写回（原 v-model 直写 drafts[index]!.custom——挂载竞态下 drafts 空
 *  数组会读 undefined.custom 崩溃；改 :value + 事件写回，空草稿安全回落）。 */
function onCustomInput(e: Event) {
  const d = drafts.value.at(index.value);
  if (!d) return;
  d.custom = (e.target as HTMLInputElement).value;
  d.skipped = false;
  if (d.custom.trim()) {
    d.selected = [];
    feedback.value = '';
  }
}

/** 主按钮：未答拦下提示；非末题翻页，末题校验全卷后一次提交 */
function continueFlow() {
  if (!answered.value) {
    feedback.value = isMulti.value ? '请至少勾选一项或填写自定义回答。' : '请选择一个选项或填写自定义回答。';
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
  const d = drafts.value.at(index.value);
  if (d) {
    d.selected = [];
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
 *  （工具结果如实呈现"用户跳过"，Agent 自行决断）。多选题答案为勾选项
 *  数组（保持选项顺序），单选题为单个字符串。有漏答题跳回并提示。 */
function submitAll() {
  const qs = questions.value;
  const missing = drafts.value.findIndex((d) => !d.selected.length && !d.custom.trim() && !d.skipped);
  if (missing >= 0) {
    index.value = missing;
    feedback.value = '请先完成这道问题。';
    return;
  }
  const answers = qs.map((q, i) => {
    const d = drafts.value.at(i);
    if (!d) return null;
    const custom = d.custom.trim();
    if (custom) return custom;
    if (d.selected.length) return q.multi ? d.selected : d.selected[0];
    return null;
  });
  chatStore.respondInteraction(answers as Array<string | string[] | null>);
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
  <Transition name="ib-card-in" appear>
    <DockCard
      v-if="interaction && visible"
      class="interaction-bar"
      collapsible
      :open="!minimized"
      @toggle="(o) => (minimized = !o)"
      icon="message-circle"
      :eyebrow="`决策请求 · ${interaction.agent_id || 'Agent'}`"
    >
      <template #actions>
        <Tooltip text="关闭（Agent 仍在等待，刷新页面可恢复作答入口）" placement="bottom">
          <button type="button" class="ib-icon-btn" aria-label="关闭（Agent 仍在等待，刷新页面可恢复作答入口）" @click="chatStore.dismissInteraction()">
            <Icon name="x" :size="13" />
          </button>
        </Tooltip>
      </template>

      <!-- cr-186：折叠显隐归 DockCard（collapsible v-show）——原 v-if 包裹层退役 -->
        <!-- 完整问题（DockCard 的 title 是单行省略——题干住正文区，长问题不截断） -->
        <h3 class="ib-title">{{ question?.question }}<span v-if="isMulti" class="ui-badge info ib-multi-tag">多选</span></h3>
        <!-- 选项区：整行选项（序号徽标 + 文案），选中 = 底色 + 主色描边；
             单选 radiogroup 即选即走，多选 checkbox 组停留勾选；
             末行自定义输入（铅笔图标，与选项互斥） -->
        <div class="ib-body">
          <div
            class="ib-options"
            :role="isMulti ? 'group' : 'radiogroup'"
            :aria-label="question?.question"
          >
            <OptionRow
              v-for="(opt, oi) in question?.options ?? []"
              :key="oi"
              :index="oi + 1"
              :multi="isMulti"
              :selected="drafts[index]?.selected.includes(opt)"
              @choose="choose(opt)"
            >{{ opt }}</OptionRow>
            <div class="ib-custom-row" :class="{ active: !!drafts[index]?.custom?.trim() }">
              <span class="ib-number" aria-hidden="true"><Icon name="pencil" :size="11" /></span>
              <input
                :value="drafts[index]?.custom ?? ''"
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
          <div v-if="questions.length > 1" class="ib-pager">
            <Tooltip text="上一题" placement="top">
              <button type="button" class="ib-icon-btn" :disabled="index === 0" aria-label="上一题" @click="step(-1)">
                <Icon name="chevron-left" :size="13" />
              </button>
            </Tooltip>
            <span class="ib-progress">{{ index + 1 }} / {{ questions.length }}</span>
            <Tooltip text="下一题" placement="top">
              <button type="button" class="ib-icon-btn" :disabled="isLast" aria-label="下一题" @click="step(1)">
                <Icon name="chevron-right" :size="13" />
              </button>
            </Tooltip>
          </div>
          <!-- 作答校验反馈：kit FeedbackNotice（error tone；文案仍由本组件持有） -->
        <div class="ib-feedback"><FeedbackNotice :text="feedback" tone="error" /></div>
          <div class="ib-actions">
            <button type="button" class="ib-btn outline" @click="skipQuestion">跳过</button>
            <button type="button" class="ib-btn primary" :disabled="!answered" @click="continueFlow">
              {{ isLast ? '提交回答' : '下一题' }}
            </button>
          </div>
        </footer>
    </DockCard>
  </Transition>
</template>

<style scoped>
.interaction-bar {
  /* dock 卡定位（壳由 kit DockCard 提供：与输入卡同宽、随 composer 列排布） */
  flex-shrink: 0;
}

/* ── 题干（原 ib-header/ib-heading/ib-eyebrow 已随 DockCard 壳归位） ── */
.ib-title {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  color: var(--text-1);
  word-break: break-word;
}
/* 多选题徽标＝ui-badge info（形状/配色归 kit 徽章族，此处只留专属修饰） */
.ib-multi-tag { margin-left: 6px; vertical-align: 1px; }

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
  color: var(--text-3);
  cursor: pointer;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.ib-icon-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-1); }
.ib-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ── 选项区（滚动兜底：题干/选项超长时内部滚） ── */
.ib-body {
  /* 原 56vh/440px 上限挂在卡片上；改挂选项区（DockCard 壳无 max-height） */
  max-height: min(56vh, 440px);
  overflow-y: auto;
  overscroll-behavior: contain;
}
.ib-options {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 12px;
}
/* 选项行已迁 kit OptionRow（cr-157——序号位/选中态/单多选语义由组件自带）；
   此处仅留自定义输入行（ib-custom-row）与其铅笔序号位 */
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
.ib-number {
  display: grid;
  place-items: center;
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
}

/* ── 自定义输入行（与选项同构：铅笔徽标 + 无边框输入） ── */
.ib-custom-row:hover,
.ib-custom-row:focus-within { background: var(--bg-hover); }
.ib-custom-row.active { border-color: var(--primary); }
.ib-custom-input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  outline: none;
  font-size: 13px;
  line-height: 20px;
  color: var(--text-1);
}
.ib-custom-input::placeholder { color: var(--text-3); }

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
  color: var(--text-2);
  font-size: 12px;
  font-weight: 500;
  line-height: 22px;
  font-variant-numeric: tabular-nums;
  padding: 0 2px;
}
.ib-feedback {
  /* 反馈 chip 右对齐占位：布局归本行，图标/配色归 kit FeedbackNotice */
  flex: 1;
  min-height: 16px;
  text-align: right;
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
  border: 1px solid var(--line-strong);
  color: var(--text-2);
}
.ib-btn.outline:hover { color: var(--text-1); border-color: var(--text-3); }
.ib-btn.primary {
  background: var(--primary);
  border: 1px solid var(--primary);
  color: var(--on-primary);
}
.ib-btn.primary:disabled { opacity: 0.4; cursor: not-allowed; }
.ib-btn.primary:not(:disabled):hover { background: var(--primary-strong); border-color: var(--primary-strong); }

/* ── 卡片入场（自下 6px 淡入上浮） ── */
.ib-card-in-enter-active { transition: opacity 0.16s var(--ease-out), transform 0.16s var(--ease-out); }
.ib-card-in-enter-from { opacity: 0; transform: translateY(6px); }
</style>

<!-- GoalBar.vue —— 长期目标 dock 条（DSH GoalBar 姿势）
  单行条带：目标图标 + 阶段标签（进行中/已暂停/受阻——受阻与自动暂停
  带原因 tooltip）+ 目标文本（ellipsis 截断）+ goal-round 轮次进度
  （第 N/M 轮）。无目标（null/undefined）不渲染。
  2026-10 直编面：hover 操作区（暂停/恢复切换 · 编辑 · 删除）——写经
  goalApi（goal/update · goal/delete RPC，与 Agent goal 工具同一写口）；
  落定后 emit changed（GoalDockCard → useGoalTracking.refresh 对账），
  rpc error 行内呈现（服务未装载/失败不静默吞写操作）。 -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { TaskGoal } from './goalCard.ts';
import type { TaskGoalPatch } from './goalApi.ts';
import { updateGoal, deleteGoal } from './goalApi.ts';
import { Icon, Modal, Button } from '@agentchat/webui-kit';

const props = defineProps<{
  goal: TaskGoal;
  /** 桶归属 Agent（写面必传；无则操作区隐藏——退化只读形态） */
  agentId?: string | null;
  /** 会话桶键（写面必传） */
  conversationId?: string | null;
  /** RPC 调用面（缺省 clientRuntime 单例——GoalDockCard 显式透传） */
  rpc?: Pick<import('ac-client-runtime').RpcClientFace, 'call'> | null;
}>();

const emit = defineEmits<{ changed: [] }>();

const PHASES: Record<string, { label: string; cls: string }> = {
  active: { label: '进行中的目标', cls: 'phase-active' },
  paused: { label: '已暂停的目标', cls: 'phase-paused' },
  blocked: { label: '受阻的目标', cls: 'phase-blocked' },
};

const phase = computed(() => PHASES[props.goal.status] ?? PHASES.active!);
const roundsText = computed(() => {
  if (props.goal.status !== 'active') return '';
  const done = props.goal.roundsDone ?? 0;
  if (done <= 0) return '';
  return `第 ${done}/${props.goal.maxRounds ?? 20} 轮`;
});
const tooltip = computed(() => {
  if (props.goal.status === 'blocked' && props.goal.blockedReason) return `受阻原因：${props.goal.blockedReason}`;
  if (props.goal.autoPausedReason) return `自动暂停：${props.goal.autoPausedReason}`;
  return props.goal.note || undefined;
});

// ============================================================
// 写面（hover 操作区；agentId/conversationId/rpc 三者齐备才可用）
// ============================================================

const canWrite = computed(() => !!(props.agentId && props.conversationId && props.rpc));
const busy = ref(false);
/** 操作失败反馈（行内 danger 提示；下次操作前清除） */
const actionError = ref('');

async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value || !canWrite.value) return;
  busy.value = true;
  actionError.value = '';
  try {
    await action();
    emit('changed');
  } catch (err: unknown) {
    actionError.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

/** 暂停/恢复切换（active/blocked → paused 停轮；paused → active 恢复并清自动暂停） */
async function togglePause(): Promise<void> {
  const next = props.goal.status === 'active' || props.goal.status === 'blocked' ? 'paused' : 'active';
  await run(async () => {
    await updateGoal(props.agentId!, props.conversationId!, { status: next }, props.rpc!);
  });
}

// ---- 编辑弹窗（objective/note/maxRounds；打开时从当前 goal 取值） ----
const editOpen = ref(false);
const editObjective = ref('');
const editNote = ref('');
const editMaxRounds = ref<number>(20);

function openEdit(): void {
  editObjective.value = props.goal.objective;
  editNote.value = props.goal.note ?? '';
  editMaxRounds.value = props.goal.maxRounds ?? 20;
  editOpen.value = true;
}

async function saveEdit(): Promise<void> {
  await run(async () => {
    const patch: TaskGoalPatch = { objective: editObjective.value };
    // note 空串 = 清除（域语义）；恒随编辑提交，未改也幂等
    patch.note = editNote.value;
    const rounds = Math.floor(Number(editMaxRounds.value));
    if (Number.isFinite(rounds) && rounds >= 1 && rounds <= 200) patch.maxRounds = rounds;
    await updateGoal(props.agentId!, props.conversationId!, patch, props.rpc!);
    editOpen.value = false;
  });
}

// ---- 删除确认（危险操作二段式；放弃 = 不入历史） ----
const deleteOpen = ref(false);

async function confirmDelete(): Promise<void> {
  await run(async () => {
    await deleteGoal(props.agentId!, props.conversationId!, props.rpc!);
    deleteOpen.value = false;
  });
}

// 弹窗内失败反馈随 goal 切换清位（外层数据已换，旧错误无意义）
watch(() => props.goal.id, () => {
  actionError.value = '';
  editOpen.value = false;
  deleteOpen.value = false;
});

// 弹窗打开即聚焦目标文本框（键盘直达编辑）
const objectiveInput = ref<HTMLInputElement | null>(null);
watch(editOpen, (open) => {
  if (open) void nextTick(() => objectiveInput.value?.focus());
});
</script>

<template>
  <div class="goal-bar" :title="tooltip">
    <span class="goal-glyph" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />
      </svg>
    </span>
    <span class="goal-phase" :class="phase.cls">{{ phase.label }}</span>
    <span class="goal-objective">{{ goal.objective }}</span>
    <span v-if="roundsText" class="goal-rounds">{{ roundsText }}</span>
    <!-- 受阻/自动暂停标记：语义图标（替代 emoji 文字符号的旧形态） -->
    <Icon v-if="goal.status === 'blocked'" name="alert-circle" :size="12" class="goal-blocked-mark" aria-hidden="true" />
    <Icon v-else-if="goal.autoPausedReason" name="pause" :size="12" class="goal-blocked-mark goal-paused-mark" aria-hidden="true" />

    <!-- hover 操作区（写面齐备才渲染；busy 期间禁点防重复提交） -->
    <span v-if="canWrite" class="goal-actions" aria-label="目标操作">
      <button
        class="goal-act"
        :title="goal.status === 'active' || goal.status === 'blocked' ? '暂停（停止自动开轮）' : '恢复（继续自动推进）'"
        :disabled="busy"
        @click.stop="togglePause"
      >
        <Icon :name="goal.status === 'active' || goal.status === 'blocked' ? 'pause' : 'play'" :size="13" />
      </button>
      <button class="goal-act" title="编辑目标" :disabled="busy" @click.stop="openEdit">
        <Icon name="pencil" :size="13" />
      </button>
      <button class="goal-act goal-act-danger" title="删除目标（放弃，不入历史）" :disabled="busy" @click.stop="deleteOpen = true">
        <Icon name="trash" :size="13" />
      </button>
    </span>

    <!-- 操作失败反馈（行内短暂呈现；不弹新窗叠加在弹窗上） -->
    <Transition name="goal-err">
      <span v-if="actionError && !editOpen && !deleteOpen" class="goal-action-error" :title="actionError">
        <Icon name="alert-circle" :size="12" />{{ actionError }}
      </span>
    </Transition>

    <!-- 编辑弹窗（ui/Modal 统一外壳） -->
    <Modal :visible="editOpen" title="编辑目标" :width="440" :z-index="1200" @close="editOpen = false; actionError = ''">
      <div class="goal-edit-body">
        <div class="goal-edit-row">
          <label>目标</label>
          <input
            ref="objectiveInput"
            v-model="editObjective"
            type="text"
            class="goal-edit-input"
            placeholder="一句话、可判完成"
            @keyup.enter="saveEdit"
          />
        </div>
        <div class="goal-edit-row">
          <label>备注</label>
          <input v-model="editNote" type="text" class="goal-edit-input" placeholder="进展备注（可选；清空即清除）" />
        </div>
        <div class="goal-edit-row">
          <label>轮次预算</label>
          <input
            v-model.number="editMaxRounds"
            type="number"
            min="1"
            max="200"
            class="goal-edit-input goal-edit-rounds"
            placeholder="1-200"
          />
          <span class="goal-edit-hint">已 {{ goal.roundsDone ?? 0 }} 轮 · 达上限自动暂停</span>
        </div>
        <div v-if="actionError" class="goal-edit-error">{{ actionError }}</div>
      </div>
      <template #footer>
        <Button variant="ghost" :disabled="busy" @click="editOpen = false; actionError = ''">取消</Button>
        <Button variant="primary" :loading="busy" @click="saveEdit">保存</Button>
      </template>
    </Modal>

    <!-- 删除确认（危险操作二段式） -->
    <Modal :visible="deleteOpen" title="删除目标" :width="440" :z-index="1200" @close="deleteOpen = false; actionError = ''">
      <div class="goal-edit-body">
        <div class="goal-delete-msg">
          确定删除目标 <strong>“{{ goal.objective }}”</strong> 吗？
        </div>
        <div class="goal-delete-note">删除 = 放弃该目标（不入历史），自动推进随之停止。此操作不可恢复。</div>
        <div v-if="actionError" class="goal-edit-error">{{ actionError }}</div>
      </div>
      <template #footer>
        <Button variant="ghost" :disabled="busy" @click="deleteOpen = false; actionError = ''">取消</Button>
        <Button variant="danger" :loading="busy" @click="confirmDelete">删除</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.goal-bar {
  display: flex; align-items: center; gap: 10px;
  height: 32px; padding: 4px 12px;
  /* 底距 6px = dock 卡列纵向节奏（M27 S3：原 .task-dock 包装层 spacing
     下放为本卡自带——与 TodoPanel 同款，零像素迁移） */
  margin: 0 10px 6px;
  border: 1px solid var(--color-border-secondary);
  border-radius: var(--radius-lg);
  background: var(--color-bg-secondary, var(--color-bg-page));
  flex-shrink: 0;
  min-width: 0;
  /* 与输入卡同级的层次感（轻 --shadow-input 一档——辅助浮层不争主操作位焦点）；
     双主题值见 webui-kit tokens.css --shadow-dock */
  box-shadow: var(--shadow-dock, 0 1px 2px rgba(0, 0, 0, 0.04), 0 2px 8px rgba(0, 0, 0, 0.06));
}
.goal-glyph { display: inline-flex; color: var(--color-text-tertiary); flex: none; }
.goal-phase { flex: none; font-size: 12px; font-weight: 500; line-height: 20px; }
.phase-active { color: var(--color-primary, #4a90d9); }
.phase-paused { color: var(--color-text-tertiary); }
.phase-blocked { color: #f59e0b; }
.goal-objective {
  min-width: 0; flex: 1; font-size: 13px; line-height: 20px;
  color: var(--color-text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.goal-rounds { flex: none; font-size: 11px; color: var(--color-text-tertiary); }
.goal-blocked-mark { flex: none; color: #f59e0b; }
.goal-paused-mark { color: var(--color-text-tertiary); }

/* ── hover 操作区：常驻占位、透明待命（防条带宽度跳变）；触屏无 hover
   直接可见（@media (hover:none)），条带 32px 高度内图标钮 20px 可点 ── */
.goal-actions {
  display: inline-flex; align-items: center; gap: 2px; flex: none;
  opacity: 0; transition: opacity 0.15s ease;
}
.goal-bar:hover .goal-actions, .goal-bar:focus-within .goal-actions { opacity: 1; }
@media (hover: none) { .goal-actions { opacity: 1; } }
.goal-act {
  display: inline-grid; place-items: center;
  width: 20px; height: 20px; padding: 0;
  border: none; border-radius: var(--radius-sm); background: transparent;
  color: var(--color-text-tertiary); cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.goal-act:hover:not(:disabled) { background: var(--color-bg-hover, rgba(0, 0, 0, 0.06)); color: var(--color-text-primary); }
.goal-act:disabled { opacity: 0.45; cursor: not-allowed; }
.goal-act-danger:hover:not(:disabled) { color: var(--color-error, #e74c3c); }

/* 操作失败反馈（截断 + title 全文；进出淡入淡出） */
.goal-action-error {
  flex: none; display: inline-flex; align-items: center; gap: 4px;
  max-width: 200px; font-size: 11px; line-height: 16px;
  color: var(--color-error, #e74c3c);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.goal-err-enter-active, .goal-err-leave-active { transition: opacity 0.15s ease; }
.goal-err-enter-from, .goal-err-leave-to { opacity: 0; }

/* ── 弹窗表单（TimerPane 同款行式布局） ── */
.goal-edit-body { display: flex; flex-direction: column; gap: 12px; padding: 14px 20px; }
.goal-edit-row { display: flex; align-items: center; gap: 10px; }
.goal-edit-row label { flex: none; width: 56px; font-size: 13px; color: var(--color-text-secondary); }
.goal-edit-input {
  flex: 1; min-width: 0; height: 30px; padding: 0 10px;
  border: 1px solid var(--color-border-secondary); border-radius: var(--radius-sm);
  background: var(--color-bg-page, transparent); color: var(--color-text-primary);
  font-size: 13px; font-family: inherit;
}
.goal-edit-input:focus { outline: none; border-color: var(--color-primary, #4a90d9); }
.goal-edit-rounds { flex: none; width: 90px; }
.goal-edit-hint { font-size: 11px; color: var(--color-text-tertiary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.goal-edit-error { font-size: 12px; line-height: 1.5; color: var(--color-error, #e74c3c); overflow-wrap: anywhere; }
.goal-delete-msg { font-size: 13px; line-height: 1.6; color: var(--color-text-primary); }
.goal-delete-msg strong { overflow-wrap: anywhere; }
.goal-delete-note { font-size: 12px; line-height: 1.6; color: var(--color-text-tertiary); }
</style>

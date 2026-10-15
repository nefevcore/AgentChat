<script setup lang="ts">
// ============================================================
// client/GlobalTimerHost.vue —— 全局定时任务节宿主（2026-09-13 重设计）
//
// 原形态：自带「定时任务」大标题头 + 段内描述 + 添加按钮（settings
// 节时代遗产）。重设计：头部整体撤去——aux 聚合面板（TimersPanel）里
// 段头/添加按钮由面板侧统一渲染（hideHeader 恒真语义）；行设计与
// TimerPane 同构（两行式 ui-row + mono 时刻表），Agent 级与全局级
// 视觉语言统一。数据仍经 settings 共享 store（timer.tasks）。
// ============================================================
import { ref, computed } from 'vue';
import { Button, Input, Modal, Select, Textarea } from '@agentchat/webui-kit';
import { useSettings } from 'ac-client-ui-settings/client/useSettings.ts';

const settings = useSettings();

// ── 全局定时任务（timer.tasks 模型：time/hint/targets） ──
interface GlobalTask { time: string; hint?: string; targets?: string[]; builtin?: boolean }

/** 系统机制任务特殊 hint（不走 LLM，纯机制执行） */
const SPECIAL_HINTS: Record<string, { label: string; desc: string }> = {
  '__archive_all__': { label: '全局归档', desc: '批量归档所有活跃 1:1 会话（深夜执行，不走 LLM）' },
  '__backup_all__': { label: '数据备份', desc: '自动打包备份全部数据（每周一次，不走 LLM）' },
};
type SysHint = keyof typeof SPECIAL_HINTS;
/** 任务类型下拉选项（kit Select——原原生 <select> cr-171 归一漏网） */
const TASK_TYPE_OPTIONS = [
  { value: 'custom', label: '自定义报时' },
  { value: '__archive_all__', label: '全局归档（系统）' },
  { value: '__backup_all__', label: '数据备份（系统）' },
];
function specialHint(hint?: string): { label: string; desc: string } | undefined {
  return hint ? SPECIAL_HINTS[hint.trim()] : undefined;
}
function isSysTask(t: GlobalTask): boolean { return !!specialHint(t.hint); }
/** 内置系统任务（config 预置，builtin=true）：不可删除、类型锁定；用户新建的系统任务不受此保护 */
function isProtectedTask(t: GlobalTask): boolean { return isSysTask(t) && t.builtin === true; }
/** 目标展示：'*' 通配视为全部 */
function targetsText(t: GlobalTask): string {
  const ts = (t.targets ?? []).filter(x => x && x !== '*');
  return ts.length ? '→ ' + ts.join(', ') : '→ 全部';
}
/** 目标缩写（行内次要徽章：a, b, c → →a +2） */
function targetShort(t: GlobalTask): string {
  const ts = (t.targets ?? []).filter(x => x && x !== '*');
  if (!ts.length) return '→ 全部';
  if (ts.length === 1) return `→ ${ts[0]}`;
  return `→ ${ts[0]} +${ts.length - 1}`;
}

const gTaskDraft = ref<GlobalTask>({ time: '', hint: '', targets: [] });
const gTaskType = ref<'custom' | SysHint>('custom');
const gTaskBuiltin = ref(false);
const gTaskTargetsText = ref('');
const gTaskEditIdx = ref<number | null>(null);
const gTaskEditing = ref(false);
const gTaskError = ref('');

const gTasks = computed<GlobalTask[]>(() => settings.globalConfig.value.timer?.tasks ?? []);

function ensureTimer() {
  if (!settings.globalConfig.value.timer) settings.globalConfig.value.timer = { enabled: true, tasks: [] };
  if (!settings.globalConfig.value.timer.tasks) settings.globalConfig.value.timer.tasks = [];
}
/** 新建入口（面板段头「添加」按钮经模板 ref 调用） */
function startAddTask() {
  gTaskEditing.value = true; gTaskEditIdx.value = null;
  gTaskDraft.value = { time: '', hint: '', targets: [] };
  gTaskType.value = 'custom';
  gTaskBuiltin.value = false;
  gTaskTargetsText.value = ''; gTaskError.value = '';
}
function startEditTask(idx: number) {
  gTaskEditing.value = true; gTaskEditIdx.value = idx;
  const t = gTasks.value[idx];
  const sp = specialHint(t.hint);
  gTaskType.value = sp ? (t.hint!.trim() as SysHint) : 'custom';
  gTaskBuiltin.value = isProtectedTask(t);
  gTaskDraft.value = { time: t.time, hint: sp ? t.hint : (t.hint || ''), targets: [...(t.targets || [])] };
  gTaskTargetsText.value = (t.targets || []).join('\n'); gTaskError.value = '';
}
function saveTask() {
  const time = gTaskDraft.value.time.trim();
  if (!/^\d{2}:\d{2}$/.test(time)) { gTaskError.value = '时间格式需为 HH:mm（如 08:30）'; return; }
  ensureTimer();
  const isSpecial = gTaskType.value !== 'custom';
  const task: GlobalTask = {
    time,
    hint: isSpecial ? gTaskType.value : ((gTaskDraft.value.hint ?? '').trim() || undefined),
    targets: (() => { const t = gTaskTargetsText.value.split(/[\n,，]/).map(s => s.trim()).filter(Boolean); return t.length > 0 ? t : undefined; })(),
  };
  const tasks = settings.globalConfig.value.timer.tasks as GlobalTask[];
  if (gTaskEditIdx.value !== null) tasks[gTaskEditIdx.value] = task;
  else tasks.push(task);
  gTaskEditing.value = false; gTaskEditIdx.value = null;
}
function removeTask(idx: number) {
  const tasks = settings.globalConfig.value.timer?.tasks;
  if (!tasks) return;
  const t = tasks[idx];
  if (isProtectedTask(t)) return; // 内置系统任务：删除按钮已禁用，双保险
  tasks.splice(idx, 1);
}

/** 面板段头「添加」按钮经模板 ref 调用（本组件不再自带头部） */
defineExpose({ startAddTask });
</script>

<template>
  <div class="g-timer">
    <div class="g-timer-list">
      <div v-for="(t, i) in gTasks" :key="i" class="g-timer-item ui-row" :class="{ 'is-sys': isSysTask(t) }">
        <div class="g-timer-main">
          <span class="ui-badge" :class="isSysTask(t) ? 'info' : 'tt-base'" :title="isSysTask(t) ? '系统机制任务（不走 LLM）' : '自定义报时任务'">
            {{ isSysTask(t) ? '系统' : '报时' }}
          </span>
          <span class="g-timer-hint">{{ specialHint(t.hint)?.label ?? (t.hint || '（报时）') }}</span>
          <span class="ui-badge dim" :title="`目标：${targetsText(t)}`">{{ targetShort(t) }}</span>
        </div>
        <div class="g-timer-sub">
          <span class="g-timer-time">{{ t.time }}</span>
          <span class="g-timer-targets">{{ targetsText(t) }}</span>
        </div>
        <div class="g-timer-actions">
          <Button variant="ghost" size="sm" @click="startEditTask(i)">编辑</Button>
          <Button variant="danger" size="sm" :disabled="isProtectedTask(t)" :title="isProtectedTask(t) ? '内置系统任务不可删除' : ''" @click="removeTask(i)">删除</Button>
        </div>
      </div>
      <div v-if="gTasks.length === 0" class="g-timer-empty">暂无全局任务</div>
    </div>
  </div>

  <!-- 全局定时任务编辑弹窗（ui/Modal 统一外壳） -->
  <Modal :visible="gTaskEditing" :title="gTaskEditIdx !== null ? '编辑全局任务' : '新建全局任务'" :width="440" :z-index="1200" @close="gTaskEditing = false">
    <div class="sp-modal-body">
      <div class="sp-field">
        <label>时间（HH:mm）</label>
        <Input v-model="gTaskDraft.time" placeholder="08:30" />
      </div>
      <div class="sp-field">
        <label>任务类型</label>
        <div class="sp-desc">系统任务为纯机制操作（不走 LLM）；自定义任务为报时提醒</div>
        <Select v-model="gTaskType" :options="TASK_TYPE_OPTIONS" :disabled="gTaskBuiltin" />
      </div>
      <template v-if="gTaskType === 'custom'">
        <div class="sp-field">
          <label>提示内容</label>
          <div class="sp-desc">留空则使用默认报时文本。占位符：&#123;&#123;now&#125;&#125; / &#123;&#123;time&#125;&#125; / &#123;&#123;date&#125;&#125;</div>
          <Textarea v-model="gTaskDraft.hint" :rows="3" placeholder="现在是 {{now}}，巡检提醒..." />
        </div>
      </template>
      <template v-else>
        <div class="sp-field">
          <label>机制说明</label>
          <div class="sp-desc">{{ specialHint(gTaskType)?.desc }}</div>
          <div class="sp-sys-fixed">hint 固定为 <code>{{ gTaskType }}</code>，{{ gTaskBuiltin ? '仅可调整时间与目标' : '保存后仍可删除或改回自定义' }}</div>
        </div>
      </template>
      <div class="sp-field">
        <label>目标 Agent</label>
        <div class="sp-desc">每行一个 Agent ID，留空 = 全部 Agent</div>
        <Textarea v-model="gTaskTargetsText" :rows="3" placeholder="agent_chat_dev&#10;news" />
      </div>
      <div v-if="gTaskError" class="g-task-error">{{ gTaskError }}</div>
    </div>
    <template #footer>
      <Button variant="ghost" @click="gTaskEditing = false">取消</Button>
      <Button variant="primary" @click="saveTask">保存</Button>
    </template>
  </Modal>
</template>

<style scoped>
.g-timer { display: flex; flex-direction: column; gap: 10px; }
/* ── 清单行（A 语言：底座 ui-row 透明底 / hover 浮起；行式与 TimerPane 同构） ── */
.g-timer-list { display: flex; flex-direction: column; gap: 2px; }
.g-timer-item { flex-wrap: wrap; align-content: center; row-gap: 3px; }
.g-timer-main { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.g-timer-hint { font-size: 12px; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 60px; }
.g-timer-item.is-sys .g-timer-hint { color: var(--primary); font-weight: 500; }
.g-timer-sub { display: flex; align-items: center; gap: 8px; flex-basis: 100%; color: var(--text-3); }
.g-timer-time { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3); }
.g-timer-targets { font-size: 10.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.g-timer-actions { display: flex; gap: 4px; flex-shrink: 0; }
/* 行内动作钮已归 kit Button（cr-171——ghost/danger 变体） */
.g-timer-empty { text-align: center; padding: 16px; color: var(--text-3); font-size: 12px; }

/* 编辑弹窗表单：输入件已归 kit Input/Select/Textarea（cr-171 归一补课——
   ui-input/ui-sel/ui-textarea 自带样式，sp-input/sp-textarea 手工副本随撤） */
.sp-modal-body { padding: 14px 20px; display: flex; flex-direction: column; gap: 12px; }
.sp-field { display: flex; flex-direction: column; gap: 5px; }
.sp-field label { font-size: 12px; color: var(--text-2); }
.sp-desc { font-size: 11px; color: var(--text-3); }
.sp-sys-fixed { font-size: 11px; color: var(--text-3); background: var(--bg-inset); padding: 6px 10px; border-radius: var(--r-sm); }
.sp-sys-fixed code { font-family: var(--font-mono); color: var(--primary); }
.g-task-error { color: var(--err); font-size: 12px; }
</style>

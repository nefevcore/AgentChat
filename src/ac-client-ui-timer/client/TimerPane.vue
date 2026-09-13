<script setup lang="ts">
// ============================================================
// TimerPane.vue —— Agent 定时任务清单（2026-09 重设计）
//
// A 语言行（ui-row 扁平行）：主行 = 模式徽章 + 提示内容 + 次要徽章
// （重复/目标）；副行 = mono 时刻表 + 目标尾巴。行尾 = ui-switch 开关
// + hover 操作（编辑/删除）。弹窗：模式五胶囊选择器 + 分模式时间控件。
// hideHeader=true 供 aux 聚合面板（TimersPanel）复用——段头与添加按钮
// 由面板侧统一渲染；AgentPane（Agent 设置 timer 页签）保持自带头。
// ============================================================
import { ref } from 'vue';
import type { TimerEntry } from 'ac-client-ui-settings/client/types.ts';
import { Modal, Button, Icon } from '@agentchat/webui-kit';

const props = withDefaults(defineProps<{ entries: TimerEntry[]; saving?: boolean; hideHeader?: boolean }>(), { hideHeader: false });
const emit = defineEmits<{ (e: 'update:entries', v: TimerEntry[]): void; (e: 'save'): void }>();

const editing = ref<TimerEntry | null>(null);
const timerError = ref('');

/** 新建入口（面板段头「添加」按钮经 ref 调用） */
function addTimer() {
  editing.value = { id: uid('timer'), enabled: true, mode: 'delay', delay: '1h', repeatCount: 1, hint: '', target: 'user' };
  timerError.value = '';
}

function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }
function editTimer(entry: TimerEntry) {
  editing.value = { ...entry };
  timerError.value = '';
}
function removeTimer(id: string) {
  emit('update:entries', props.entries.filter(e => e.id !== id));
}
function toggleTimer(id: string, on: boolean) {
  emit('update:entries', props.entries.map(t => t.id === id ? { ...t, enabled: on } : t));
}
function saveTimer() {
  if (!editing.value) return;
  const e = editing.value;
  const val = e.mode === 'time' ? e.time : e.delay;
  if (!val?.trim() || !e.hint.trim()) {
    timerError.value = '时间/间隔和提示内容不能为空';
    return;
  }
  const idx = props.entries.findIndex(t => t.id === e.id);
  const next = [...props.entries];
  if (idx >= 0) next[idx] = { ...e };
  else next.push({ ...e });
  emit('update:entries', next);
  editing.value = null;
  timerError.value = '';
}

// ── 展示格式化（模式 → 徽章/时刻表文本） ──
const MODE_META: Record<TimerEntry['mode'], { label: string; icon: string }> = {
  delay: { label: '间隔', icon: 'refresh-cw' },
  random: { label: '随机', icon: 'refresh-cw' },
  time: { label: '定点', icon: 'alarm-clock' },
  workday: { label: '工作日', icon: 'alarm-clock' },
  holiday: { label: '节假日', icon: 'alarm-clock' },
};
/** 弹窗模式胶囊（元信息复用 MODE_META） */
const MODES: Array<{ value: TimerEntry['mode']; desc: string }> = [
  { value: 'delay', desc: '每 N 触发一次' },
  { value: 'random', desc: '范围内随机间隔' },
  { value: 'time', desc: '每天 / 指定日期' },
  { value: 'workday', desc: '法定工作日的时刻' },
  { value: 'holiday', desc: '法定节假日的时刻' },
];
function repeatText(e: TimerEntry): string {
  return (e.repeatCount ?? 0) <= 0 ? '永久' : `${e.repeatCount} 次`;
}
function scheduleText(e: TimerEntry): string {
  const t = e.time || '';
  const timeOnly = t.includes('T') ? t.slice(11, 16) : (t.slice(11, 16) || t);
  if (e.mode === 'delay') return `每 ${e.delay || '—'}`;
  if (e.mode === 'random') return `${e.delayMin || '30s'} ~ ${e.delayMax || '5m'} 随机`;
  if (e.mode === 'workday') return `工作日 ${timeOnly}`;
  if (e.mode === 'holiday') return `节假日 ${timeOnly}`;
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.replace('T', ' ').slice(0, 16) : `每天 ${t}`;
}
/** 目标缩写（行内次要徽章：user,coding → →user,coding） */
function targetShort(e: TimerEntry): string {
  const ts = (e.target || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ts.length) return '→ user';
  if (ts.length === 1) return `→ ${ts[0]}`;
  return `→ ${ts[0]} +${ts.length - 1}`;
}

// datetime 互转
function toDateOnly(v?: string): string { if (!v) return ''; return v.slice(0, 10); }
function toTimeOnly(v?: string): string { if (!v) return ''; return v.slice(11, 16) || v; }
function updateTimeDate(datePart: string, timePart: string): string {
  if (datePart && timePart) return `${datePart} ${timePart}`;
  return timePart || datePart;
}

/** 面板段头「添加」按钮经模板 ref 调用（hideHeader 复用态的入口） */
defineExpose({ addTimer });
</script>

<template>
  <div class="timer-pane">
    <div v-if="!hideHeader" class="timer-head">
      <div>
        <div class="timer-title">定时任务</div>
        <div class="timer-desc">配置定时自动触发 Agent，结果发送给 target</div>
      </div>
      <div class="timer-head-actions">
        <button v-if="entries.length > 0" class="timer-save-btn" :disabled="saving" @click="emit('save')">{{ saving ? '保存中...' : '保存定时配置' }}</button>
        <button class="timer-add" @click="addTimer()">+ 添加</button>
      </div>
    </div>

    <div v-if="entries.length > 0" class="timer-list">
      <div v-for="entry in entries" :key="entry.id" class="timer-item ui-row" :class="{ off: !entry.enabled }">
        <div class="timer-main">
          <span class="ui-badge tt-base" :title="`模式：${MODE_META[entry.mode].label}`">{{ MODE_META[entry.mode].label }}</span>
          <span class="timer-hint">{{ entry.hint }}</span>
          <span class="ui-badge dim" :title="`重复：${repeatText(entry)}`">{{ repeatText(entry) }}</span>
          <span class="ui-badge dim" :title="`目标：${entry.target || 'user'}`">{{ targetShort(entry) }}</span>
        </div>
        <div class="timer-sub">
          <Icon class="timer-sub-ico" :name="MODE_META[entry.mode].icon" :size="12" />
          <span class="timer-schedule">{{ scheduleText(entry) }}</span>
        </div>
        <div class="timer-actions">
          <label class="ui-switch" :title="entry.enabled ? '暂停' : '启用'" @click.stop>
            <input type="checkbox" :checked="entry.enabled" @change="toggleTimer(entry.id, ($event.target as HTMLInputElement).checked)" />
            <span class="ui-switch-track"><span class="ui-switch-dot"></span></span>
          </label>
          <button class="timer-btn" @click="editTimer(entry)">编辑</button>
          <button class="timer-btn danger" @click="removeTimer(entry.id)">删除</button>
        </div>
      </div>
    </div>
    <div v-else class="timer-empty">
      暂无定时任务<span v-if="!hideHeader">，点击右上角"添加"创建</span>
    </div>

    <!-- 编辑弹窗（ui/Modal 统一外壳） -->
    <Modal :visible="editing !== null" :title="(entries.find(t => t.id === editing?.id) ? '编辑' : '新增') + '定时任务'" :width="440" :z-index="1200" @close="editing = null; timerError = ''">
      <div v-if="editing" class="timer-modal-body">
        <!-- 模式胶囊选择器 -->
        <div class="timer-row">
          <label>触发模式</label>
          <div class="tp-modes">
            <button v-for="m in MODES" :key="m.value" type="button" class="tp-mode" :class="{ active: editing.mode === m.value }" @click="editing.mode = m.value">
              <span class="tp-mode-label">{{ MODE_META[m.value].label }}</span>
              <span class="tp-mode-desc">{{ m.desc }}</span>
            </button>
          </div>
        </div>
        <div v-if="editing.mode === 'time'" class="timer-row">
          <label>日期（留空 = 每天）</label>
          <input type="date" class="timer-input" :value="toDateOnly(editing.time)" @input="editing.time = updateTimeDate(($event.target as HTMLInputElement).value, toTimeOnly(editing.time))" />
        </div>
        <div v-if="editing.mode === 'time' || editing.mode === 'workday' || editing.mode === 'holiday'" class="timer-row">
          <label>时间</label>
          <input type="time" class="timer-input" :value="toTimeOnly(editing.time)" @input="editing.time = updateTimeDate(toDateOnly(editing.time), ($event.target as HTMLInputElement).value)" />
        </div>
        <div v-if="editing.mode === 'delay'" class="timer-row">
          <label>间隔</label>
          <input v-model="editing.delay" class="timer-input" placeholder="1h（支持 30s / 5m / 2h30m）" />
        </div>
        <div v-if="editing.mode === 'random'" class="timer-row">
          <label>随机范围</label>
          <div class="timer-range">
            <input v-model="editing.delayMin" class="timer-input short" placeholder="30s" />
            <span>~</span>
            <input v-model="editing.delayMax" class="timer-input short" placeholder="5m" />
          </div>
        </div>
        <div class="timer-row">
          <label>重复次数</label>
          <input v-model.number="editing.repeatCount" type="number" min="0" class="timer-input short" placeholder="0 = 永久" />
        </div>
        <div class="timer-row">
          <label>提示内容</label>
          <textarea v-model="editing.hint" class="timer-textarea" rows="3" placeholder="触发时发送给 Agent 的指令"></textarea>
        </div>
        <div class="timer-row">
          <label>目标</label>
          <input v-model="editing.target" class="timer-input" placeholder="user, coding_agent（逗号分隔，默认 user）" />
        </div>
        <div v-if="timerError" class="timer-error">{{ timerError }}</div>
      </div>
      <template #footer>
        <Button variant="ghost" @click="editing = null; timerError = ''">取消</Button>
        <Button variant="primary" @click="saveTimer">确认</Button>
      </template>
    </Modal>
  </div>
</template>

<script lang="ts">
export default { name: 'TimerPane' };
</script>

<style scoped>
.timer-pane { display: flex; flex-direction: column; gap: 10px; }
.timer-head { display: flex; align-items: flex-start; justify-content: space-between; }
.timer-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
.timer-desc { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.timer-add {
  padding: 5px 14px; border: 1px solid var(--primary); border-radius: var(--r-md);
  background: transparent; color: var(--primary); font-size: 12px; cursor: pointer; transition: all var(--dur-fast);
}
.timer-add:hover { background: var(--primary-light); }
.timer-head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

/* ── 清单行（A 语言：底座 ui-row 透明底 / hover 浮起） ── */
.timer-list { display: flex; flex-direction: column; gap: 2px; }
.timer-item { flex-wrap: wrap; align-content: center; row-gap: 3px; }
/* 主行：徽章 + 提示 + 次要徽章 */
.timer-main { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.timer-hint { font-size: 12px; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 60px; }
/* 副行：mono 时刻表 */
.timer-sub { display: flex; align-items: center; gap: 5px; flex-basis: 100%; color: var(--text-3); }
.timer-sub-ico { color: var(--text-3); flex: none; }
.timer-schedule { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3); }
/* 停用行：整行降透明度（时刻表随之弱化） */
.timer-item.off .timer-main, .timer-item.off .timer-sub { opacity: .5; }
.timer-item.off .timer-hint { text-decoration: line-through; }

/* 行尾动作（开关 + 编辑/删除） */
.timer-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.timer-btn { padding: 3px 10px; border: none; border-radius: var(--r-md); background: transparent; color: var(--text-2); font-size: 11px; cursor: pointer; }
.timer-btn:hover { background: var(--bg-hover); color: var(--text-1); }
.timer-btn.danger { color: var(--err); }
.timer-btn.danger:hover { background: color-mix(in srgb, var(--err) 10%, transparent); color: var(--err); }
.timer-empty { padding: 20px; text-align: center; color: var(--text-3); font-size: 13px; }
.timer-save-btn {
  padding: 5px 14px; border-radius: var(--r-md); font-size: 12px; font-weight: 500; cursor: pointer;
  background: var(--primary); border: none; color: #fff; transition: all var(--dur-fast);
}
.timer-save-btn:hover:not(:disabled) { opacity: .9; }
.timer-save-btn:disabled { opacity: .5; cursor: not-allowed; }

/* ── 编辑弹窗 ── */
.timer-modal-body { padding: 14px 20px; display: flex; flex-direction: column; gap: 10px; }
.timer-row { display: flex; flex-direction: column; gap: 4px; }
.timer-row label { font-size: 12px; color: var(--text-2); }
.timer-input, .timer-select, .timer-textarea {
  padding: 6px 9px; border: 1px solid var(--input-border); border-radius: var(--r-sm);
  background: var(--input-bg); color: var(--text-1); font-size: 13px;
}
.timer-input:focus, .timer-select:focus, .timer-textarea:focus { outline: none; border-color: var(--input-focus); }
.timer-input.short { width: 130px; }
.timer-range { display: flex; align-items: center; gap: 6px; }
.timer-textarea { resize: vertical; font-family: var(--font-mono); }
.timer-error { color: var(--err); font-size: 12px; }

/* 模式胶囊选择器（2/3 列自适应网格：模式名 + 一句话说明） */
.tp-modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.tp-mode {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  padding: 7px 9px; border: 1px solid var(--line-strong); border-radius: var(--r-md);
  background: var(--bg-surface); cursor: pointer; text-align: left;
  transition: border-color var(--dur-fast), background var(--dur-fast);
}
.tp-mode:hover { border-color: color-mix(in srgb, var(--primary) 45%, transparent); }
.tp-mode.active { border-color: var(--primary); background: var(--primary-light); }
.tp-mode-label { font-size: 12px; font-weight: 500; color: var(--text-1); }
.tp-mode.active .tp-mode-label { color: var(--primary); }
.tp-mode-desc { font-size: 10px; color: var(--text-3); }
</style>

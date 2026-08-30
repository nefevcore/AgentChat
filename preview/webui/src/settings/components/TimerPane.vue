<script setup lang="ts">
// ============================================================
// TimerPane.vue —— Agent 定时任务（含编辑弹窗）
// ============================================================
import { ref } from 'vue';
import type { TimerEntry } from '../types';
import { Modal, Button } from '@/ui';

const props = defineProps<{ entries: TimerEntry[]; saving?: boolean }>();
const emit = defineEmits<{ (e: 'update:entries', v: TimerEntry[]): void; (e: 'save'): void }>();

const editing = ref<TimerEntry | null>(null);
const timerError = ref('');

function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

function addTimer() {
  editing.value = { id: uid('timer'), enabled: true, mode: 'delay', delay: '1h', repeatCount: 1, hint: '', target: 'user' };
  timerError.value = '';
}
function editTimer(entry: TimerEntry) {
  editing.value = { ...entry };
  timerError.value = '';
}
function removeTimer(id: string) {
  emit('update:entries', props.entries.filter(e => e.id !== id));
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

// datetime 互转
function toDateOnly(v?: string): string { if (!v) return ''; return v.slice(0, 10); }
function toTimeOnly(v?: string): string { if (!v) return ''; return v.slice(11, 16) || v; }
function updateTimeDate(datePart: string, timePart: string): string {
  if (datePart && timePart) return `${datePart} ${timePart}`;
  return timePart || datePart;
}
function formatTimeLabel(t?: string): string {
  if (!t) return '';
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t : `每天 ${t}`;
}
function scheduleText(e: TimerEntry): string {
  if (e.mode === 'workday') return '工作日 ' + e.time;
  if (e.mode === 'holiday') return '节假日 ' + e.time;
  if (e.mode === 'time') return formatTimeLabel(e.time);
  if (e.mode === 'random') return `随机 ${e.delayMin || '30s'}~${e.delayMax || '5m'}`;
  return '每 ' + e.delay;
}
</script>

<template>
  <div class="timer-pane">
    <div class="timer-head">
      <div>
        <div class="timer-title">定时任务</div>
        <div class="timer-desc">配置定时自动触发 Agent，结果发送给 target</div>
      </div>
      <div class="timer-head-actions">
        <button v-if="entries.length > 0" class="timer-save-btn" :disabled="saving" @click="emit('save')">{{ saving ? '保存中...' : '保存定时配置' }}</button>
        <button class="timer-add" @click="addTimer">+ 添加定时任务</button>
      </div>
    </div>

    <div v-if="entries.length > 0" class="timer-list">
      <div v-for="entry in entries" :key="entry.id" class="timer-item">
        <div class="timer-info">
          <span class="timer-schedule" :class="{ disabled: !entry.enabled }">{{ scheduleText(entry) }}</span>
          <span class="timer-hint" :class="{ disabled: !entry.enabled }">{{ entry.hint }}</span>
          <span class="timer-repeat">{{ (entry.repeatCount ?? 0) <= 0 ? '永久' : (entry.repeatCount + '次') }}</span>
        </div>
        <div class="timer-actions">
          <label class="timer-toggle" :title="entry.enabled ? '暂停' : '启用'">
            <input type="checkbox" :checked="entry.enabled" @change="emit('update:entries', entries.map(t => t.id === entry.id ? { ...t, enabled: ($event.target as HTMLInputElement).checked } : t))" />
          </label>
          <button class="timer-btn" @click="editTimer(entry)">编辑</button>
          <button class="timer-btn danger" @click="removeTimer(entry.id)">删除</button>
        </div>
      </div>
    </div>
    <div v-else class="timer-empty">暂无定时任务，点击右上角"添加"创建</div>

    <!-- 编辑弹窗（ui/Modal 统一外壳） -->
    <Modal :visible="editing !== null" :title="(entries.find(t => t.id === editing?.id) ? '编辑' : '新增') + '定时任务'" :width="440" :z-index="1200" @close="editing = null; timerError = ''">
      <div v-if="editing" class="timer-modal-body">
              <div class="timer-row">
                <label>模式</label>
                <select v-model="editing.mode" class="timer-select">
                  <option value="delay">延时（间隔触发）</option>
                  <option value="random">随机（范围触发）</option>
                  <option value="time">定时（每天）</option>
                  <option value="workday">法定工作日</option>
                  <option value="holiday">法定节假日</option>
                </select>
              </div>
              <div v-if="editing.mode === 'time'" class="timer-row">
                <label>日期</label>
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

<style scoped>
.timer-pane { display: flex; flex-direction: column; gap: 12px; }
.timer-head { display: flex; align-items: flex-start; justify-content: space-between; }
.timer-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
.timer-desc { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.timer-add {
  padding: 5px 14px; border: 1px solid var(--primary); border-radius: var(--r-md);
  background: transparent; color: var(--primary); font-size: 12px; cursor: pointer; transition: all var(--dur-fast);
}
.timer-add:hover { background: var(--primary-light); }
.timer-head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

.timer-list { display: flex; flex-direction: column; gap: 6px; }
.timer-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg-surface);
}
.timer-info { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
.timer-schedule { font-family: var(--font-mono); font-weight: 600; color: var(--primary); flex-shrink: 0; font-size: 12px; }
.timer-schedule.disabled { color: var(--text-3); text-decoration: line-through; }
.timer-hint { font-size: 12px; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.timer-hint.disabled { color: var(--text-3); text-decoration: line-through; }
.timer-repeat { font-size: 11px; color: var(--text-3); flex-shrink: 0; }
.timer-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.timer-toggle input { accent-color: var(--primary); cursor: pointer; }
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
</style>

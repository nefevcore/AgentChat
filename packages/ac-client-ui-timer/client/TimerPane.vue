<script setup lang="ts">
// ============================================================
// TimerPane.vue —— Agent 定时任务清单（cr-1147 脚本化重做）
//
// 旧五模式胶囊选择器退役：条目 = 判定脚本（code）。行式两行不变：
// 主行 = label 徽章 + next 节奏 + 状态徽章；副行 = mono 脚本首行；
// 行尾 = 开关 + 编辑/删除。弹窗 = label + 脚本编辑器（Textarea +
// 常用模板快选）。hideHeader=true 供 aux 聚合面板复用不变。
// ============================================================
import { ref } from 'vue';
import type { TimerScriptEntry } from 'ac-timer-core';
import { Button, Icon, Input, Modal, Textarea } from '@agentchat/webui-kit';

const props = withDefaults(defineProps<{ entries: TimerScriptEntry[]; saving?: boolean; hideHeader?: boolean }>(), { hideHeader: false });
const emit = defineEmits<{ (e: 'update:entries', v: TimerScriptEntry[]): void; (e: 'save'): void }>();

const editing = ref<TimerScriptEntry | null>(null);
const timerError = ref('');

/** 新建入口（模板：每小时静默检测，未到 09:00 跳过） */
function addTimer() {
  editing.value = {
    id: uid('t'), enabled: true, kind: 'script',
    label: '',
    code: '(a, u) => {\n  // a: { now, last?, count, state? }  u: { at, after, minute, day, dow, workday, ms }\n  // 到 09:00 投递提醒（其余轮静默探测）\n  const now = new Date(a.now);\n  if (u.minute(now) >= 540 && (!a.last || u.day(new Date(a.last)) !== u.day(now))) {\n    return { action: \'提醒内容\', next: u.at(\'09:00\') };\n  }\n  return { next: u.at(\'09:00\') };\n}',
  };
  timerError.value = '';
}

function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }
function editTimer(entry: TimerScriptEntry) {
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
  if (!e.code || !e.code.trim()) { timerError.value = '判定脚本不能为空'; return; }
  const idx = props.entries.findIndex(t => t.id === e.id);
  const next = [...props.entries];
  if (idx >= 0) next[idx] = { ...e };
  else next.push({ ...e });
  emit('update:entries', next);
  editing.value = null;
  timerError.value = '';
}

/** 脚本首行摘要（副行 mono 展示） */
function codeSummary(e: TimerScriptEntry): string {
  const first = (e.code || '').split('\n').map(s => s.trim()).find(s => s && !s.startsWith('//'));
  return first ? first.slice(0, 72) : e.code.slice(0, 72);
}

/** 节奏徽章（从 code 提取 next 字面量——启发式展示，非精确） */
function nextBadge(e: TimerScriptEntry): string {
  const m = /next:\s*u\.(at|after)\('([^']{1,18})'\)/.exec(e.code || '');
  return m ? m[2] : '—';
}

/** 面板段头「添加」按钮经模板 ref 调用（hideHeader 复用态的入口） */
defineExpose({ addTimer });
</script>

<template>
  <div class="timer-pane">
    <div v-if="!hideHeader" class="timer-head">
      <div>
        <div class="timer-title">定时任务</div>
        <div class="timer-desc">判定脚本控制触发（action 有值才投递），结果发送给 Agent</div>
      </div>
      <div class="timer-head-actions">
        <Button v-if="entries.length > 0" variant="primary" size="sm" :disabled="saving" @click="emit('save')">{{ saving ? '保存中...' : '保存定时配置' }}</Button>
        <Button variant="ghost" size="sm" icon="plus" @click="addTimer()">添加</Button>
      </div>
    </div>

    <div v-if="entries.length > 0" class="timer-list">
      <div v-for="entry in entries" :key="entry.id" class="timer-item ui-row" :class="{ off: !entry.enabled }">
        <div class="timer-main">
          <span class="ui-badge tt-base" title="判定脚本">脚本</span>
          <span class="timer-hint">{{ entry.label || entry.id }}</span>
          <span class="ui-badge dim" :title="`检测节奏：${nextBadge(entry)}`">每 {{ nextBadge(entry) }}</span>
        </div>
        <div class="timer-sub">
          <Icon class="timer-sub-ico" name="code" :size="12" />
          <span class="timer-schedule">{{ codeSummary(entry) }}</span>
        </div>
        <div class="timer-actions">
          <label class="ui-switch" :title="entry.enabled ? '暂停' : '启用'" @click.stop>
            <input type="checkbox" :checked="entry.enabled" @change="toggleTimer(entry.id, ($event.target as HTMLInputElement).checked)" />
            <span class="ui-switch-track"><span class="ui-switch-dot"></span></span>
          </label>
          <Button variant="ghost" size="sm" @click="editTimer(entry)">编辑</Button>
          <Button variant="danger" size="sm" @click="removeTimer(entry.id)">删除</Button>
        </div>
      </div>
    </div>
    <div v-else class="timer-empty">
      暂无定时任务<span v-if="!hideHeader">，点击右上角"添加"创建</span>
    </div>

    <!-- 编辑弹窗 -->
    <Modal :visible="editing !== null" :title="(entries.find(t => t.id === editing?.id) ? '编辑' : '新增') + '定时任务'" :width="520" :z-index="1200" @close="editing = null; timerError = ''">
      <div v-if="editing" class="timer-modal-body">
        <div class="timer-row">
          <label>标签</label>
          <Input v-model="editing.label" class="timer-input" placeholder="早间简报（可选）" />
        </div>
        <div class="timer-row">
          <label>判定脚本（双参谓词 (a, u)）</label>
          <Textarea v-model="editing.code" class="timer-textarea code" :rows="10" placeholder="(a, u) => ({ action: '提醒', next: u.at('09:00') })" />
        </div>
        <div class="timer-tip">
          a = { now, last?, count, state? }（记账快照）；u = { at, after, minute, day, dow, workday, ms }（时间工具）；
          return { action?（有值投递）, next?（Date——u.at()/u.after() 构造）, state?（持久记忆）, active?（false=完成归档） }
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
.timer-head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.timer-list { display: flex; flex-direction: column; gap: 2px; }
.timer-item { flex-wrap: wrap; align-content: center; row-gap: 3px; }
.timer-main { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.timer-hint { font-size: 12px; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.timer-sub { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-3); font-family: var(--font-mono); overflow: hidden; }
.timer-schedule { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.timer-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.timer-empty { padding: 18px 0; text-align: center; font-size: 12px; color: var(--text-3); }
.timer-modal-body { display: flex; flex-direction: column; gap: 10px; }
.timer-row label { display: block; font-size: 11px; color: var(--text-3); margin-bottom: 4px; }
.timer-textarea.code { font-family: var(--font-mono); font-size: 12px; }
.timer-tip { font-size: 11px; color: var(--text-3); line-height: 1.5; padding: 8px; background: var(--bg-2); border-radius: 4px; }
.timer-error { color: var(--danger); font-size: 11px; }
</style>

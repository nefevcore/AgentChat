<script setup lang="ts">
// ============================================================
// TimerPane.vue —— Agent 定时任务清单（cr-1164 v3 换轨）
//
// 脚本编辑器退役：条目 = 声明式触发词汇（when/gates/until/missed/
// action）。行式两行不变：主行 = label 徽章 + 触发摘要 + 状态徽章；
// 副行 = action 文本；行尾 = 开关 + 编辑/删除。弹窗 = 触发词汇分栏
// 表单（kind 分栏：once/daily/weekly/every + 门 + 终结 + 停机策略）。
// hideHeader=true 供 aux 聚合面板复用不变。多触发器条目编辑首格
// （其余保留——Agent 经 LLM 面编排复合条目）。
// ============================================================
import { ref } from 'vue';
import type { TimerEntry, WhenTrigger } from 'ac-timer-core';
import { Button, Icon, Input, Modal, Select, Textarea } from '@agentchat/webui-kit';

const props = withDefaults(defineProps<{ entries: TimerEntry[]; saving?: boolean; hideHeader?: boolean }>(), { hideHeader: false });
const emit = defineEmits<{ (e: 'update:entries', v: TimerEntry[]): void; (e: 'save'): void }>();

const editing = ref<TimerEntry | null>(null);
const timerError = ref('');
/** 纯源条目（无时间触发器）：表单不含触发分栏——保存保留原 when（不静默注入时间触发器） */
const sourceOnly = ref(false);

// ── 表单草稿（触发器首格 + 门 + 终结 + 停机策略） ──
const kind = ref<'once' | 'daily' | 'weekly' | 'every'>('daily');
const atDate = ref(''); // once：datetime-local
const atTime = ref('09:00'); // daily/weekly/every 锚
const dow = ref('1');
const iv = ref('30m');
const baseKind = ref<'wall' | 'after-last' | 'anchor'>('wall');
const jitter = ref('');
const gateWorkday = ref(false);
const gateHoliday = ref(false);
const hoursOn = ref(false);
const hoursFrom = ref('08:00');
const hoursTo = ref('22:00');
const untilKind = ref<'none' | 'count' | 'date'>('none');
const untilCount = ref(1);
const untilDate = ref('');
const missed = ref<'' | 'skip' | 'catchup-once'>('');
const actionText = ref('');

const KIND_OPTIONS = [
  { value: 'once', label: '单次' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'every', label: '间隔' },
];
const DOW_OPTIONS = [
  { value: '0', label: '周日' }, { value: '1', label: '周一' }, { value: '2', label: '周二' },
  { value: '3', label: '周三' }, { value: '4', label: '周四' }, { value: '5', label: '周五' },
  { value: '6', label: '周六' },
];
const BASE_OPTIONS = [
  { value: 'wall', label: '墙钟网格（对齐整点/半点）' },
  { value: 'anchor', label: '显式锚时刻' },
  { value: 'after-last', label: '链式（上次投递起算）' },
];

function loadDraft(t: WhenTrigger | undefined) {
  if (t === undefined) { kind.value = 'daily'; atDate.value = ''; atTime.value = '09:00'; dow.value = '1'; iv.value = '30m'; baseKind.value = 'wall'; jitter.value = ''; return; }
  switch (t.kind) {
    case 'once': {
      kind.value = 'once';
      const d = new Date(t.at);
      atDate.value = isNaN(d.getTime()) ? '' : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      break;
    }
    case 'daily': kind.value = 'daily'; atTime.value = t.at; break;
    case 'weekly': kind.value = 'weekly'; dow.value = String(t.dow); atTime.value = t.at; break;
    case 'every':
      kind.value = 'every'; iv.value = t.iv; jitter.value = t.jitter ?? '';
      if (t.base === undefined || t.base === 'wall') baseKind.value = 'wall';
      else if (t.base === 'after-last') baseKind.value = 'after-last';
      else baseKind.value = 'anchor', atTime.value = typeof t.base === 'object' ? t.base.at : atTime.value;
      break;
    case 'source': kind.value = 'daily'; break; // 源触发不在表单词汇（Agent 经 LLM 面编排）——回落 daily 不落盘覆盖（保存时保留原 when）
  }
}

/** 新建入口（缺省模板：每天 09:00） */
function addTimer() {
  editing.value = {
    id: uid('t'), enabled: true,
    label: '',
    when: [{ kind: 'daily', at: '09:00' }],
    action: { text: '' },
  };
  loadDraft(editing.value.when[0]);
  sourceOnly.value = false;
  gateWorkday.value = false; gateHoliday.value = false; hoursOn.value = false;
  untilKind.value = 'none'; missed.value = ''; actionText.value = '';
  timerError.value = '';
}

function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

function editTimer(entry: TimerEntry) {
  editing.value = { ...entry, action: { ...entry.action } };
  const first = entry.when.find((w) => w.kind !== 'source');
  sourceOnly.value = first === undefined;
  loadDraft(first);
  gateWorkday.value = entry.gates?.some((g) => g.kind === 'workday') ?? false;
  gateHoliday.value = entry.gates?.some((g) => g.kind === 'holiday') ?? false;
  const hours = entry.gates?.find((g) => g.kind === 'hours');
  hoursOn.value = hours !== undefined;
  if (hours !== undefined) { hoursFrom.value = hours.from; hoursTo.value = hours.to; }
  if (entry.until === undefined) untilKind.value = 'none';
  else if ('count' in entry.until) { untilKind.value = 'count'; untilCount.value = entry.until.count; }
  else { untilKind.value = 'date'; untilDate.value = entry.until.date.slice(0, 10); }
  missed.value = entry.missed ?? '';
  actionText.value = entry.action.text;
  timerError.value = '';
}

function removeTimer(id: string) {
  emit('update:entries', props.entries.filter(e => e.id !== id));
}

function toggleTimer(id: string, on: boolean) {
  emit('update:entries', props.entries.map(t => t.id === id ? { ...t, enabled: on } : t));
}

function buildTrigger(): WhenTrigger | string {
  switch (kind.value) {
    case 'once':
      if (!atDate.value) return '单次触发需要时刻';
      return { kind: 'once', at: new Date(atDate.value).toISOString() };
    case 'daily':
      if (!/^\d{1,2}:\d{2}$/.test(atTime.value)) return '每天触发需要 HH:mm 时刻';
      return { kind: 'daily', at: atTime.value.padStart(5, '0') };
    case 'weekly':
      if (!/^\d{1,2}:\d{2}$/.test(atTime.value)) return '每周触发需要 HH:mm 时刻';
      return { kind: 'weekly', dow: Number(dow.value), at: atTime.value.padStart(5, '0') };
    case 'every': {
      if (!/^\d+(\.\d+)?(ms|s|m|h|d)$/.test(iv.value.trim())) return "间隔需为 '30m' / '2h30m' / '7d' 形态";
      if (jitter.value.trim() && !/^\d+(\.\d+)?(ms|s|m|h|d)$/.test(jitter.value.trim())) return '抖动需为间隔串形态';
      if (jitter.value.trim() && baseKind.value === 'after-last') return '抖动不与链式组合（会越漂越远）';
      const base = baseKind.value === 'wall' ? undefined
        : baseKind.value === 'after-last' ? 'after-last' as const
        : { at: atTime.value.padStart(5, '0') };
      return { kind: 'every', iv: iv.value.trim(), ...(base !== undefined ? { base } : {}), ...(jitter.value.trim() ? { jitter: jitter.value.trim() } : {}) };
    }
  }
}

function saveTimer() {
  if (!editing.value) return;
  if (!actionText.value.trim()) { timerError.value = '唤醒文本不能为空（时间到投给 Agent 的消息）'; return; }
  const trigger = sourceOnly.value ? null : buildTrigger();
  if (trigger !== null && typeof trigger === 'string') { timerError.value = trigger; return; }
  if (untilKind.value === 'count' && (!Number.isInteger(untilCount.value) || untilCount.value < 1)) { timerError.value = '终结次数须为正整数'; return; }
  if (untilKind.value === 'date' && !untilDate.value) { timerError.value = '终结日期不能为空'; return; }
  const gates: TimerEntry['gates'] = [
    ...(gateWorkday.value ? [{ kind: 'workday' } as const] : []),
    ...(gateHoliday.value ? [{ kind: 'holiday' } as const] : []),
    ...(hoursOn.value ? [{ kind: 'hours', from: hoursFrom.value.padStart(5, '0'), to: hoursTo.value.padStart(5, '0') } as const] : []),
  ];
  const until = untilKind.value === 'none' ? undefined
    : untilKind.value === 'count' ? { count: untilCount.value } as const
    : { date: untilDate.value } as const;
  // 源触发器保留在 when 尾部（表单只编辑首个时间触发器）；纯源条目原样保留 when
  const sourceTriggers = editing.value.when.filter((w): w is Extract<WhenTrigger, { kind: 'source' }> => w.kind === 'source');
  const next: TimerEntry = {
    ...editing.value,
    when: trigger === null ? editing.value.when : [trigger, ...sourceTriggers],
    ...(gates.length > 0 ? { gates } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(missed.value !== '' ? { missed: missed.value } : {}),
    action: { ...editing.value.action, text: actionText.value.trim() },
  };
  const idx = props.entries.findIndex(t => t.id === next.id);
  const list = [...props.entries];
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  emit('update:entries', list);
  editing.value = null;
  timerError.value = '';
}

/** 触发摘要（主行徽章右侧） */
function kindBadge(e: TimerEntry): string {
  const t = e.when[0] as WhenTrigger | undefined;
  if (t === undefined) return '—';
  switch (t.kind) {
    case 'once': return '单次';
    case 'daily': return '每天 ' + t.at;
    case 'weekly': return '每周' + '日一二三四五六'[t.dow] + ' ' + t.at;
    case 'every': return '每 ' + t.iv + (t.base === 'after-last' ? '（链式）' : '');
    case 'source': return '源 ' + t.source;
  }
}

/** 源触发计数（多触发器标注） */
function extraCount(e: TimerEntry): number {
  return e.when.length - 1;
}

/** 面板段头「添加」按钮经模板 ref 调用（hideHeader 复用态的入口） */
defineExpose({ addTimer });
</script>

<template>
  <div class="timer-pane">
    <div v-if="!hideHeader" class="timer-head">
      <div>
        <div class="timer-title">定时任务</div>
        <div class="timer-desc">声明式触发词汇（到点唤醒 Agent），无脚本</div>
      </div>
      <div class="timer-head-actions">
        <Button v-if="entries.length > 0" variant="primary" size="sm" :disabled="saving" @click="emit('save')">{{ saving ? '保存中...' : '保存定时配置' }}</Button>
        <Button variant="ghost" size="sm" icon="plus" @click="addTimer()">添加</Button>
      </div>
    </div>

    <div v-if="entries.length > 0" class="timer-list">
      <div v-for="entry in entries" :key="entry.id" class="timer-item ui-row" :class="{ off: !entry.enabled }">
        <div class="timer-main">
          <span class="ui-badge tt-base" title="触发词汇">{{ kindBadge(entry).split(' ')[0] }}</span>
          <span class="timer-hint">{{ entry.label || entry.action.text }}</span>
          <span class="ui-badge dim" :title="kindBadge(entry)">{{ kindBadge(entry) }}</span>
          <span v-if="extraCount(entry) > 0" class="ui-badge dim" :title="'另有 ' + extraCount(entry) + ' 个触发器（Agent 面编排）'">+{{ extraCount(entry) }}</span>
          <span v-if="entry.until" class="ui-badge dim">{{ 'count' in entry.until ? '满' + entry.until.count + '次' : '至' + entry.until.date.slice(0, 10) }}</span>
        </div>
        <div class="timer-sub">
          <Icon class="timer-sub-ico" name="clock" :size="12" />
          <span class="timer-schedule">{{ entry.action.text }}</span>
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

    <!-- 编辑弹窗：触发词汇分栏表单 -->
    <Modal :visible="editing !== null" :title="(entries.find(t => t.id === editing?.id) ? '编辑' : '新增') + '定时任务'" :width="560" :z-index="1200" @close="editing = null; timerError = ''">
      <div v-if="editing" class="timer-modal-body">
        <div class="timer-row">
          <label>标签（可选，list 展示）</label>
          <Input v-model="editing.label" class="timer-input" placeholder="晨间简报" />
        </div>
        <div v-if="!sourceOnly" class="timer-row">
          <label>触发（到点/到刻唤醒）</label>
          <div class="timer-grid">
            <Select v-model="kind" :options="KIND_OPTIONS" />
            <Input v-if="kind === 'once'" v-model="atDate" type="datetime-local" />
            <template v-if="kind === 'daily' || kind === 'weekly' || (kind === 'every' && baseKind === 'anchor')">
              <Select v-if="kind === 'weekly'" v-model="dow" :options="DOW_OPTIONS" />
              <Input v-if="kind !== 'every' || baseKind === 'anchor'" v-model="atTime" placeholder="09:00" />
            </template>
            <template v-if="kind === 'every'">
              <Input v-model="iv" placeholder="30m" />
              <Select v-model="baseKind" :options="BASE_OPTIONS" />
              <Input v-if="baseKind !== 'after-last'" v-model="jitter" placeholder="抖动（可选，如 5m）" />
            </template>
          </div>
        </div>
        <div v-if="sourceOnly" class="timer-tip">本条目为源触发（外部状态变化唤醒，经 Agent 的 timer 工具编排）——此处仅可编辑标签、门、终结与唤醒文本。</div>
        <div class="timer-row">
          <label>时间门（AND——门不命中的刻度直接跳过）</label>
          <div class="timer-gates">
            <label class="timer-check"><input type="checkbox" v-model="gateWorkday" /> 工作日</label>
            <label class="timer-check"><input type="checkbox" v-model="gateHoliday" /> 节假日</label>
            <label class="timer-check"><input type="checkbox" v-model="hoursOn" /> 时段</label>
            <template v-if="hoursOn">
              <Input v-model="hoursFrom" placeholder="08:00" />
              <span class="timer-sep">→</span>
              <Input v-model="hoursTo" placeholder="22:00" />
            </template>
          </div>
        </div>
        <div class="timer-row">
          <label>终结与停机策略</label>
          <div class="timer-grid">
            <Select v-model="untilKind" :options="[
              { value: 'none', label: '不终结' },
              { value: 'count', label: '满 N 次' },
              { value: 'date', label: '至日期' },
            ]" />
            <Input v-if="untilKind === 'count'" v-model.number="untilCount" type="number" min="1" />
            <Input v-else-if="untilKind === 'date'" v-model="untilDate" type="date" />
            <Select v-model="missed" :options="[
              { value: '', label: '停机策略（缺省）' },
              { value: 'skip', label: '错过跳过' },
              { value: 'catchup-once', label: '错过补投一次' },
            ]" />
          </div>
        </div>
        <div class="timer-row">
          <label>唤醒文本（时间到投给 Agent 的消息——语义判断归 Agent）</label>
          <Textarea v-model="actionText" class="timer-textarea" :rows="3" placeholder="晨间简报时间到，请汇总昨日动态" />
        </div>
        <div class="timer-tip">
          触发词汇：once 单次 / daily 每天 / weekly 每周 / every 间隔（墙钟网格 · 锚 · 链式 ± 抖动）；门：工作日 / 节假日 / 时段（跨午夜形支持 from > to）。
          唤醒只是「时间到」——值不值得做、做什么由 Agent 判定。源触发（外部状态变化）经 Agent 的 timer 工具编排。
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
.timer-sub { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-3); overflow: hidden; }
.timer-schedule { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.timer-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.timer-empty { padding: 18px 0; text-align: center; font-size: 12px; color: var(--text-3); }
.timer-modal-body { display: flex; flex-direction: column; gap: 10px; }
.timer-row label { display: block; font-size: 11px; color: var(--text-3); margin-bottom: 4px; }
.timer-grid { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.timer-grid > :first-child { min-width: 130px; }
.timer-gates { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.timer-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-2); cursor: pointer; }
.timer-sep { color: var(--text-3); }
.timer-gates :deep(.ui-input) { width: 76px; }
.timer-grid :deep(.ui-input) { width: 110px; }
.timer-textarea { font-size: 12px; }
.timer-tip { font-size: 11px; color: var(--text-3); line-height: 1.5; padding: 8px; background: var(--bg-2); border-radius: 4px; }
.timer-error { color: var(--danger); font-size: 11px; }
</style>

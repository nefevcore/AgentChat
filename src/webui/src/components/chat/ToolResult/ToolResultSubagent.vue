<script setup lang="ts">
// ============================================================
// ToolResultSubagent.vue —— subagent 工具结果展示
// 按 data 结构自动区分 action：spawn（创建）/ send（投递回执）/
// await（结果）/ list（列表）/ stop（停止）/ delete（删除）/ kill（旧词汇）
// ============================================================
import { computed } from 'vue';
import type { Component } from 'vue';
import { Icon } from '@/ui';

const props = defineProps<{ data: Record<string, unknown>; loading?: boolean }>();

// 状态徽章映射
const STATUS_META: Record<string, { label: string; cls: string }> = {
  running:  { label: '运行中', cls: 'st-running' },
  idle:     { label: '空闲',   cls: 'st-killed' },
  done:     { label: '完成',   cls: 'st-done' },
  error:    { label: '异常',   cls: 'st-error' },
  timeout:  { label: '超时',   cls: 'st-timeout' },
  stopped:  { label: '已停止', cls: 'st-killed' },
  killed:   { label: '已终止', cls: 'st-killed' },
};

// send 投递回执徽章
const DELIVERED_META: Record<string, { label: string; cls: string }> = {
  started: { label: '已开跑', cls: 'st-running' },
  steered: { label: '已注入', cls: 'st-done' },
  queued:  { label: '已排队', cls: 'st-timeout' },
};

function statusMeta(status: unknown) {
  const key = String(status ?? '');
  return STATUS_META[key] || { label: key || '未知', cls: 'st-unknown' };
}

// 格式化耗时
function fmtElapsed(ms: unknown): string {
  const n = Number(ms);
  if (!n || n < 0) return '';
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function fmtTime(ts: unknown): string {
  const t = Number(ts);
  if (!t) return '';
  return new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── spawn 结果 ──
const spawnData = computed(() => ({
  id: props.data.subagent_id as string | undefined,
  status: props.data.status as string | undefined,
  message: props.data.message as string | undefined,
}));

// ── await 结果 ──
const awaitData = computed(() => ({
  id: props.data.subagent_id as string | undefined,
  status: props.data.status as string | undefined,
  result: props.data.result as string | undefined,
  error: props.data.error as string | undefined,
  elapsed: props.data.elapsed_ms as number | undefined,
}));

// ── list 结果 ──
interface SubItem {
  id: string;
  name: string;
  status: string;
  task: string;
  elapsed: number;
  started: string;
}
const listData = computed<SubItem[]>(() => {
  const arr = props.data.subagents;
  if (!Array.isArray(arr)) return [];
  return arr.map((s: any) => ({
    id: s.id ?? '',
    name: s.name ?? '',
    status: s.status ?? '',
    task: s.task ?? '',
    elapsed: s.elapsed_ms ?? 0,
    started: s.started_at ?? '',
  }));
});
const activeCount = computed(() => Number(props.data.active_count ?? 0));

// ── kill 结果 ──
const killData = computed(() => ({
  id: props.data.subagent_id as string | undefined,
  message: props.data.message as string | undefined,
}));

// ── send 投递回执（异步；sync send 带结果走 await 卡） ──
const sendData = computed(() => ({
  id: props.data.subagent_id as string | undefined,
  delivered: props.data.delivered as string | undefined,
  message: props.data.message as string | undefined,
}));
const deliveredMeta = computed(() => {
  const key = String(sendData.value.delivered ?? '');
  return DELIVERED_META[key] || { label: key || '未知', cls: 'st-unknown' };
});

// ── stop / delete 结果 ──
const stopData = computed(() => ({
  id: props.data.subagent_id as string | undefined,
  message: props.data.message as string | undefined,
}));

const kind = computed(() => {
  // 根据 data 结构推断工具类型
  if (Array.isArray(props.data.subagents)) return 'list';
  if (props.data.active_count !== undefined) return 'list';
  if (props.data.result !== undefined || props.data.error !== undefined) return 'await';
  if (props.data.stopped === true) return 'stop';
  if (props.data.deleted === true) return 'delete';
  if (props.data.delivered !== undefined) return 'send';
  const msg = typeof props.data.message === 'string' ? props.data.message : '';
  if (msg.includes('已终止') || msg.includes('已回收')) return 'kill';
  return 'spawn';
});
</script>

<template>
  <div class="subagent-result">
    <!-- ═══ spawn：创建子 Agent ═══ -->
    <div v-if="kind === 'spawn'" class="sa-card sa-spawn">
      <div class="sa-head">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="5" r="1.5"/><circle cx="19" cy="12" r="1.5"/><circle cx="5" cy="12" r="1.5"/>
          <circle cx="12" cy="19" r="1.5"/><line x1="12" y1="6.5" x2="18" y2="10.8"/><line x1="6" y1="10.8" x2="12" y2="6.5"/>
          <line x1="12" y1="17.5" x2="18" y2="13.2"/><line x1="6" y1="13.2" x2="12" y2="17.5"/>
        </svg>
        <span class="sa-title">子 Agent 已创建</span>
        <span class="sa-badge" :class="statusMeta(spawnData.status).cls">{{ statusMeta(spawnData.status).label }}</span>
      </div>
      <div class="sa-body">
        <div class="sa-id"><span class="sa-key">ID</span><code>{{ spawnData.id }}</code></div>
        <div v-if="spawnData.message" class="sa-msg">{{ spawnData.message }}</div>
      </div>
    </div>

    <!-- ═══ await：等待结果 ═══ -->
    <div v-else-if="kind === 'await'" class="sa-card sa-await">
      <div class="sa-head">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        <span class="sa-title">子 Agent 结果</span>
        <span class="sa-badge" :class="statusMeta(awaitData.status).cls">{{ statusMeta(awaitData.status).label }}</span>
        <span v-if="awaitData.elapsed" class="sa-elapsed"><Icon name="clock" :size="11" class="sa-elapsed-icon" />{{ fmtElapsed(awaitData.elapsed) }}</span>
      </div>
      <div class="sa-body">
        <div class="sa-id"><span class="sa-key">ID</span><code>{{ awaitData.id }}</code></div>
        <div v-if="awaitData.result" class="sa-result">{{ awaitData.result }}</div>
        <div v-else-if="awaitData.error" class="sa-error"><Icon name="alert-circle" :size="12" class="sa-error-icon" />{{ awaitData.error }}</div>
        <div v-else class="sa-msg">仍在运行中…</div>
      </div>
    </div>

    <!-- ═══ list：子 Agent 列表 ═══ -->
    <div v-else-if="kind === 'list'" class="sa-card sa-list">
      <div class="sa-head">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
          <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
        </svg>
        <span class="sa-title">子 Agent 列表</span>
        <span class="sa-count">{{ activeCount }} 活跃</span>
      </div>
      <div class="sa-body">
        <div v-if="listData.length === 0" class="sa-empty">暂无活跃子 Agent</div>
        <div v-for="item in listData" :key="item.id" class="sa-item">
          <span class="sa-badge sm" :class="statusMeta(item.status).cls">{{ statusMeta(item.status).label }}</span>
          <code class="sa-item-id">{{ item.id }}</code>
          <span class="sa-item-task">{{ item.task }}</span>
          <span v-if="item.elapsed" class="sa-item-elapsed">{{ fmtElapsed(item.elapsed) }}</span>
        </div>
      </div>
    </div>

    <!-- ═══ send：多轮投递回执 ═══ -->
    <div v-else-if="kind === 'send'" class="sa-card sa-send">
      <div class="sa-head">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
        <span class="sa-title">已发送至子 Agent</span>
        <span class="sa-badge" :class="deliveredMeta.cls">{{ deliveredMeta.label }}</span>
      </div>
      <div class="sa-body">
        <div class="sa-id"><span class="sa-key">ID</span><code>{{ sendData.id }}</code></div>
        <div v-if="sendData.message" class="sa-msg">{{ sendData.message }}</div>
      </div>
    </div>

    <!-- ═══ stop：停止推理确认 ═══ -->
    <div v-else-if="kind === 'stop'" class="sa-card sa-stop">
      <div class="sa-head">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="6" y="6" width="12" height="12" rx="1"/>
        </svg>
        <span class="sa-title">已停止推理</span>
        <span class="sa-badge st-killed">已停止</span>
      </div>
      <div class="sa-body">
        <div class="sa-id"><span class="sa-key">ID</span><code>{{ stopData.id }}</code></div>
        <div v-if="stopData.message" class="sa-msg">{{ stopData.message }}</div>
      </div>
    </div>

    <!-- ═══ delete：删除确认 ═══ -->
    <div v-else-if="kind === 'delete'" class="sa-card sa-delete">
      <div class="sa-head">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
        <span class="sa-title">子 Agent 已删除</span>
        <span class="sa-badge st-killed">已删除</span>
      </div>
      <div class="sa-body">
        <div class="sa-id"><span class="sa-key">ID</span><code>{{ stopData.id }}</code></div>
        <div v-if="stopData.message" class="sa-msg">{{ stopData.message }}</div>
      </div>
    </div>

    <!-- ═══ kill：终止确认（旧词汇） ═══ -->
    <div v-else class="sa-card sa-kill">
      <div class="sa-head">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <span class="sa-title">子 Agent 已终止</span>
        <span class="sa-badge st-killed">已终止</span>
      </div>
      <div class="sa-body">
        <div class="sa-id"><span class="sa-key">ID</span><code>{{ killData.id }}</code></div>
        <div v-if="killData.message" class="sa-msg">{{ killData.message }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.subagent-result { padding: 2px 0; }

.sa-card {
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 10px;
  overflow: hidden;
  background: var(--color-bg-surface, #fafafa);
}

.sa-head {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 12px;
  background: var(--color-code-toolbar, #eceff1);
  border-bottom: 1px solid var(--color-border-secondary, #e0e0e0);
  font-size: 12px;
}
.sa-head svg { color: var(--color-text-secondary); flex-shrink: 0; }
.sa-title { font-weight: 600; color: var(--color-text-primary); }
.sa-elapsed { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: var(--color-text-tertiary); }
.sa-elapsed-icon { flex-shrink: 0; }
.sa-count { margin-left: auto; font-size: 11px; color: var(--color-text-tertiary); }

.sa-body { padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }

.sa-id {
  display: flex; align-items: center; gap: 6px; font-size: 12px;
}
.sa-id code {
  font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
  font-size: 11px; color: var(--color-primary, #6366f1);
  background: var(--color-primary-light, rgba(79,70,229,0.08));
  padding: 1px 6px; border-radius: 4px;
}
.sa-key { color: var(--color-text-tertiary); min-width: 22px; }

.sa-msg { font-size: 12px; color: var(--color-text-secondary); }

.sa-result {
  font-size: 12px; color: var(--color-text-primary);
  white-space: pre-wrap; word-break: break-word;
  line-height: 1.6;
  background: var(--color-bg-page, #fff);
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 6px;
  padding: 8px 10px;
}
.sa-error { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--color-error, #e74c3c); }
.sa-error-icon { flex-shrink: 0; }
.sa-empty { font-size: 12px; color: var(--color-text-tertiary); padding: 6px 0; }

/* ── 状态徽章 ── */
.sa-badge {
  display: inline-flex; align-items: center;
  font-size: 11px; font-weight: 600;
  padding: 1px 8px; border-radius: 10px;
  gap: 4px;
}
.sa-badge.sm { font-size: 10px; padding: 0 6px; flex-shrink: 0; }
.sa-badge::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: currentColor;
}
.st-running { color: #e6a817; background: rgba(230,168,23,0.1); }
.st-done    { color: #16a34a; background: rgba(22,163,74,0.1); }
.st-error   { color: #ef4444; background: rgba(239,68,68,0.1); }
.st-timeout { color: #f97316; background: rgba(249,115,22,0.1); }
.st-killed  { color: #6b7280; background: rgba(107,114,128,0.12); }
.st-unknown { color: #6b7280; background: rgba(107,114,128,0.12); }

/* ── 列表条目 ── */
.sa-item {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 0; border-bottom: 1px dashed var(--color-border-secondary, rgba(0,0,0,0.06));
  font-size: 12px;
}
.sa-item:last-child { border-bottom: none; }
.sa-item-id { font-family: 'SF Mono', Consolas, monospace; font-size: 10px; color: var(--color-text-secondary); flex-shrink: 0; }
.sa-item-task {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--color-text-primary);
}
.sa-item-elapsed { font-size: 10px; color: var(--color-text-tertiary); flex-shrink: 0; }
</style>

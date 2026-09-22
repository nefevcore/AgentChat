<script setup lang="ts">
// ============================================================
// ToolResultSubagent.vue —— subagent 工具结果展示
// kind 判定经 inferKind.ts 单源（output.action 显式优先，历史结构猜
// 回落）。六卡：spawn / send / await / list / stop / delete。
// ID 可点击 → openSubagentView 进入子会话只读视角（P3 联动）。
// ============================================================
import { computed, ref } from 'vue';
import { Icon } from '@agentchat/webui-kit';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { subStatusLabel } from 'ac-client-ui-jobs/client';
import { inferKind } from './inferKind.ts';

const props = defineProps<{ data: Record<string, unknown>; loading?: boolean }>();

// 状态徽章映射（delivered 之外的 run 状态词表）——文案经 subStatusLabel
// 单源（与运行跟踪面板跨重启历史行同词），本地只保留色类
const STATUS_META: Record<string, { label: string; cls: string }> = {
  running:  { label: subStatusLabel('running'), cls: 'st-running' },
  idle:     { label: subStatusLabel('idle'),    cls: 'st-killed' },
  done:     { label: subStatusLabel('done'),    cls: 'st-done' },
  error:    { label: subStatusLabel('error'),   cls: 'st-error' },
  timeout:  { label: subStatusLabel('timeout'), cls: 'st-timeout' },
  stopped:  { label: subStatusLabel('stopped'), cls: 'st-killed' },
};

// send 投递回执徽章（next-run 忙时排队与 queued 同观感）
const DELIVERED_META: Record<string, { label: string; cls: string }> = {
  started: { label: '已开跑', cls: 'st-running' },
  steered: { label: '已注入', cls: 'st-done' },
  queued:  { label: '已排队', cls: 'st-timeout' },
};

function statusMeta(status: unknown) {
  const key = String(status ?? '');
  return STATUS_META[key] || { label: key || '未知', cls: 'st-unknown' };
}

function deliveredMeta(delivered: unknown) {
  const key = String(delivered ?? '');
  return DELIVERED_META[key] || { label: key || '未知', cls: 'st-unknown' };
}

// 格式化耗时
function fmtElapsed(ms: unknown): string {
  const n = Number(ms);
  if (!n || n < 0) return '';
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

const kind = computed(() => inferKind(props.data));

// ── loading 态：结果未返回（调用中），data = 工具参数预览 ──
const actionLabel: Record<string, string> = {
  spawn: '派出子 Agent',
  send: '向子 Agent 发消息',
  await: '等待子 Agent 结果',
  list: '查询子 Agent 列表',
  stop: '停止子 Agent 推理',
  delete: '删除子 Agent',
};

// ── ID 点击 → 子会话只读视角（uiStore 缺席时静默不可点） ──
function openSubagentView(id: unknown) {
  const sid = String(id ?? '');
  if (!sid || !sid.startsWith('sub_')) return;
  try {
    useUiStore().openSubagentView(sid, typeof props.data.name === 'string' ? props.data.name : undefined);
  } catch { /* pinia 未装配（裸 boot 测试）——静默 */ }
}

// ── spawn 结果 ──
const spawnData = computed(() => ({
  id: props.data.subagent_id as string | undefined,
  name: props.data.name as string | undefined,
  task: props.data.task as string | undefined,
  status: props.data.status as string | undefined,
  message: props.data.message as string | undefined,
}));

// ── await 结果（send sync 带结果复用同款结构） ──
const awaitData = computed(() => ({
  id: props.data.subagent_id as string | undefined,
  status: props.data.status as string | undefined,
  result: props.data.result as string | undefined,
  error: props.data.error as string | undefined,
  elapsed: props.data.elapsed_ms as number | undefined,
}));

// await/spawn(等待) 的 result 折叠（长结果默认 6 行高度，可展开）
const resultExpanded = ref(false);
const RESULT_FOLD_LIMIT = 400;
const resultFoldable = computed(() => String(awaitData.value.result ?? '').length > RESULT_FOLD_LIMIT);

// ── list 结果 ──
interface SubItem {
  id: string;
  name: string;
  status: string;
  task: string;
  runs: number;
  lastResult: string;
}
const listData = computed<SubItem[]>(() => {
  const arr = props.data.subagents;
  if (!Array.isArray(arr)) return [];
  return arr.map((s: any) => ({
    id: s.id ?? '',
    name: s.name ?? '',
    status: s.status ?? '',
    task: s.task ?? '',
    runs: Number(s.runs ?? 0),
    lastResult: typeof s.last_result === 'string' ? s.last_result : '',
  }));
});
const activeCount = computed(() => Number(props.data.active_count ?? 0));
const totalCount = computed(() => {
  const t = Number(props.data.total);
  return Number.isFinite(t) ? t : listData.value.length;
});

// ── send 投递回执（async；sync send 带结果也走本卡——delivered 徽章保留） ──
const sendData = computed(() => ({
  id: props.data.subagent_id as string | undefined,
  delivered: props.data.delivered as string | undefined,
  result: props.data.result as string | undefined,
  error: props.data.error as string | undefined,
  elapsed: props.data.elapsed_ms as number | undefined,
  status: props.data.status as string | undefined,
  message: props.data.message as string | undefined,
}));

// ── stop / delete 结果（同形轻量回执） ──
const stopData = computed(() => ({
  id: props.data.subagent_id as string | undefined,
  message: props.data.message as string | undefined,
}));
</script>

<template>
  <div class="subagent-result">
    <!-- ═══ loading：调用中（data=参数预览，无 subagent_id 等结果字段） ═══ -->
    <div v-if="loading" class="sa-loading">
      <span class="sa-spin" aria-hidden="true"></span>
      <span class="sa-loading-text">{{ actionLabel[String(data.action)] || '执行 subagent' }}…</span>
      <code v-if="data.subagent_id" class="sa-loading-id">{{ data.subagent_id }}</code>
      <span v-else-if="data.task" class="sa-loading-task">{{ String(data.task).slice(0, 60) }}<template v-if="String(data.task).length > 60">…</template></span>
    </div>

    <!-- ═══ spawn：创建子 Agent ═══ -->
    <div v-else-if="kind === 'spawn'" class="sa-card sa-spawn">
      <div class="sa-head">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="5" r="1.5"/><circle cx="19" cy="12" r="1.5"/><circle cx="5" cy="12" r="1.5"/>
          <circle cx="12" cy="19" r="1.5"/><line x1="12" y1="6.5" x2="18" y2="10.8"/><line x1="6" y1="10.8" x2="12" y2="6.5"/>
          <line x1="12" y1="17.5" x2="18" y2="13.2"/><line x1="6" y1="13.2" x2="12" y2="17.5"/>
        </svg>
        <span class="sa-title">子 Agent 已创建</span>
        <span v-if="spawnData.name" class="sa-name">{{ spawnData.name }}</span>
        <span class="sa-badge" :class="statusMeta(spawnData.status).cls">{{ statusMeta(spawnData.status).label }}</span>
      </div>
      <div class="sa-body">
        <div class="sa-id"><span class="sa-key">ID</span><code class="sa-id-link" title="点击查看子 Agent 会话" @click="openSubagentView(spawnData.id)">{{ spawnData.id }}</code></div>
        <div v-if="spawnData.task" class="sa-task">{{ spawnData.task }}<template v-if="spawnData.task.length >= 120">…</template></div>
      </div>
    </div>

    <!-- ═══ await：等待/收取结果 ═══ -->
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
        <div class="sa-id"><span class="sa-key">ID</span><code class="sa-id-link" title="点击查看子 Agent 会话" @click="openSubagentView(awaitData.id)">{{ awaitData.id }}</code></div>
        <div v-if="awaitData.result" class="sa-result" :class="{ folded: resultFoldable && !resultExpanded }">{{ awaitData.result }}</div>
        <div v-else-if="awaitData.error" class="sa-error"><Icon name="alert-circle" :size="12" class="sa-error-icon" />{{ awaitData.error }}</div>
        <div v-else class="sa-msg">尚未运行过（send 可启动首轮）</div>
        <button v-if="resultFoldable" class="sa-fold-btn" @click="resultExpanded = !resultExpanded">
          {{ resultExpanded ? '收起' : '展开全文' }}
        </button>
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
        <span class="sa-count">{{ activeCount }} 活跃 / 共 {{ totalCount }}</span>
      </div>
      <div class="sa-body">
        <div v-if="listData.length === 0" class="sa-empty">暂无活跃子 Agent</div>
        <div v-for="item in listData" :key="item.id" class="sa-item">
          <span class="sa-badge sm" :class="statusMeta(item.status).cls">{{ statusMeta(item.status).label }}</span>
          <span v-if="item.name" class="sa-item-name">{{ item.name }}</span>
          <code class="sa-item-id sa-id-link" title="点击查看子 Agent 会话" @click="openSubagentView(item.id)">{{ item.id }}</code>
          <span class="sa-item-task" :title="item.task">{{ item.task }}</span>
          <span v-if="item.runs" class="sa-item-runs">{{ item.runs }} 轮</span>
        </div>
      </div>
    </div>

    <!-- ═══ send：投递回执（async 排队回执 / sync 带结果） ═══ -->
    <div v-else-if="kind === 'send'" class="sa-card sa-send">
      <div class="sa-head">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
        <span class="sa-title">已发送至子 Agent</span>
        <span class="sa-badge" :class="deliveredMeta(sendData.delivered).cls">{{ deliveredMeta(sendData.delivered).label }}</span>
        <span class="sa-badge" :class="statusMeta(sendData.status).cls">{{ statusMeta(sendData.status).label }}</span>
        <span v-if="sendData.elapsed" class="sa-elapsed"><Icon name="clock" :size="11" class="sa-elapsed-icon" />{{ fmtElapsed(sendData.elapsed) }}</span>
      </div>
      <div class="sa-body">
        <div class="sa-id"><span class="sa-key">ID</span><code class="sa-id-link" title="点击查看子 Agent 会话" @click="openSubagentView(sendData.id)">{{ sendData.id }}</code></div>
        <div v-if="sendData.message" class="sa-msg">{{ sendData.message }}</div>
        <div v-if="sendData.result" class="sa-result" :class="{ folded: resultFoldable && !resultExpanded }">{{ sendData.result }}</div>
        <div v-else-if="sendData.error" class="sa-error"><Icon name="alert-circle" :size="12" class="sa-error-icon" />{{ sendData.error }}</div>
        <button v-if="resultFoldable && sendData.result" class="sa-fold-btn" @click="resultExpanded = !resultExpanded">
          {{ resultExpanded ? '收起' : '展开全文' }}
        </button>
      </div>
    </div>

    <!-- ═══ stop / delete：轻量回执 ═══ -->
    <div v-else class="sa-card sa-receipt">
      <div class="sa-head">
        <svg v-if="kind === 'stop'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="6" y="6" width="12" height="12" rx="1"/>
        </svg>
        <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
        <span class="sa-title">{{ kind === 'stop' ? '已停止推理' : '子 Agent 已删除' }}</span>
        <span class="sa-badge st-killed">{{ kind === 'stop' ? '已停止' : '已删除' }}</span>
      </div>
      <div class="sa-body">
        <div class="sa-id"><span class="sa-key">ID</span><code>{{ stopData.id }}</code></div>
        <div v-if="stopData.message" class="sa-msg">{{ stopData.message }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.subagent-result { padding: 2px 0; }

/* ── loading（工具卡外壳的调用中预览：琥珀环与全前端"忙"指示同款） ── */
.sa-loading { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; color: var(--color-text-secondary); }
.sa-spin {
  width: 12px; height: 12px; flex-shrink: 0; border-radius: 50%;
  border: 2px solid var(--color-warning-light, rgba(245,158,11,0.15));
  border-top-color: var(--color-warning, #f59e0b);
  animation: saSpin 0.8s linear infinite;
}
@keyframes saSpin { to { transform: rotate(360deg); } }
.sa-loading-text { font-style: italic; }
.sa-loading-id {
  font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
  font-size: 11px; color: var(--color-text-tertiary);
}
.sa-loading-task { font-size: 11px; color: var(--color-text-tertiary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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
.sa-title { font-weight: 600; color: var(--color-text-primary); white-space: nowrap; }
.sa-name {
  font-size: 11px; color: var(--color-text-secondary);
  background: var(--color-bg-page, #fff);
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  padding: 0 6px; border-radius: 8px; max-width: 120px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sa-elapsed { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: var(--color-text-tertiary); flex-shrink: 0; }
.sa-elapsed-icon { flex-shrink: 0; }
.sa-count { margin-left: auto; font-size: 11px; color: var(--color-text-tertiary); }

.sa-body { padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }

.sa-id {
  display: flex; align-items: center; gap: 6px; font-size: 12px;
}
.sa-id code, .sa-item-id {
  font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
  font-size: 11px; color: var(--color-primary, #6366f1);
  background: var(--color-primary-light, rgba(79,70,229,0.08));
  padding: 1px 6px; border-radius: 4px;
}
/* 可点击进入子会话视角的 ID */
.sa-id-link { cursor: pointer; }
.sa-id-link:hover { text-decoration: underline; }
.sa-key { color: var(--color-text-tertiary); min-width: 22px; }

.sa-task {
  font-size: 12px; color: var(--color-text-secondary);
  white-space: pre-wrap; word-break: break-word; line-height: 1.5;
}
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
.sa-result.folded { max-height: 160px; overflow: hidden; }
.sa-fold-btn {
  align-self: flex-start;
  background: none; border: none; padding: 2px 0;
  font-size: 11px; color: var(--color-link, #4a90d9); cursor: pointer;
}
.sa-fold-btn:hover { text-decoration: underline; }
.sa-error { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--color-error, #e74c3c); }
.sa-error-icon { flex-shrink: 0; }
.sa-empty { font-size: 12px; color: var(--color-text-tertiary); padding: 6px 0; }

/* ── 状态徽章 ── */
.sa-badge {
  display: inline-flex; align-items: center;
  font-size: 11px; font-weight: 600;
  padding: 1px 8px; border-radius: 10px;
  gap: 4px; flex-shrink: 0;
}
.sa-badge.sm { font-size: 10px; padding: 0 6px; }
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
.sa-item-name { font-weight: 500; color: var(--color-text-primary); flex-shrink: 0; max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sa-item-id { font-size: 10px; flex-shrink: 0; }
.sa-item-task {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--color-text-primary);
}
.sa-item-runs { font-size: 10px; color: var(--color-text-tertiary); flex-shrink: 0; }
</style>

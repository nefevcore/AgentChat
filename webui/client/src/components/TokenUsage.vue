<script setup lang="ts">
import { ref, watch, computed, onUnmounted, nextTick } from 'vue';
import { useAgentStore } from '../stores/agents';
import { Chart, BarElement, BarController, CategoryScale, LinearScale, Legend, Tooltip, Title } from 'chart.js';

Chart.register(BarElement, BarController, CategoryScale, LinearScale, Legend, Tooltip, Title);

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const agentStore = useAgentStore();

interface AgentUsage {
  agent: string;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  total_react_turns: number;
  total_cache_hit: number;
  total_cache_miss: number;
  record_count: number;
  last_used: string;
}

interface DailyUsage {
  date: string;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  record_count: number;
}

interface UsageSummary {
  overall: {
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_tokens: number;
    total_react_turns: number;
    total_cache_hit: number;
    total_cache_miss: number;
    total_records: number;
  };
  by_agent: AgentUsage[];
  by_day: DailyUsage[];
}

const loading = ref(false);
const error = ref('');
const data = ref<UsageSummary | null>(null);
const activeTab = ref<'overview' | 'agents' | 'daily'>('overview');

// ── 排序状态 ──
type AgentSortKey = keyof AgentUsage | 'label';

const agentSortKey = ref<AgentSortKey>('total_tokens');
const agentSortDir = ref<-1 | 1>(-1); // -1=desc, 1=asc

function toggleSort(key: AgentSortKey) {
  if (agentSortKey.value === key) {
    agentSortDir.value = (agentSortDir.value * -1) as -1 | 1;
  } else {
    agentSortKey.value = key;
    agentSortDir.value = -1;
  }
}

function sortArrow(key: AgentSortKey): string {
  if (agentSortKey.value !== key) return '';
  return agentSortDir.value === -1 ? ' ▼' : ' ▲';
}

const sortedAgents = computed(() => {
  if (!data.value) return [];
  const arr = [...data.value.by_agent];
  const key = agentSortKey.value;
  const dir = agentSortDir.value;
  arr.sort((a, b) => {
    let va: string | number;
    let vb: string | number;
    if (key === 'label') {
      va = agentStore.getAgentName(a.agent);
      vb = agentStore.getAgentName(b.agent);
      return dir * va.localeCompare(vb);
    }
    va = a[key];
    vb = b[key];
    if (typeof va === 'string' && typeof vb === 'string') return dir * va.localeCompare(vb);
    return dir * ((va as number) - (vb as number));
  });
  return arr;
});

const cacheTotal = computed(() => {
  if (!data.value) return 0;
  return data.value.overall.total_cache_hit + data.value.overall.total_cache_miss;
});

const cacheHitRate = computed(() => {
  if (!data.value || cacheTotal.value === 0) return '-';
  return ((data.value.overall.total_cache_hit / cacheTotal.value) * 100).toFixed(1);
});

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function loadData() {
  loading.value = true;
  error.value = '';
  try {
    const resp = await fetch('/api/usage/tokens');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    data.value = json;
  } catch (err: any) {
    console.error('[TokenUsage] 加载失败:', err);
    error.value = `加载失败: ${err.message || err}`;
  } finally {
    loading.value = false;
  }
}

watch(() => props.visible, (v) => {
  if (v) loadData();
});

// ── 堆叠柱状图 ──
const chartCanvas = ref<HTMLCanvasElement | null>(null);
let chartInstance: Chart | null = null;

function destroyChart() {
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
}

function renderChart() {
  if (!chartCanvas.value || !data.value || data.value.by_day.length === 0) return;
  const days = [...data.value.by_day].sort((a, b) => a.date.localeCompare(b.date));

  destroyChart();

  const isDark = document.documentElement.classList.contains('dark');
  const textColor = isDark ? '#bdc3c7' : '#7f8c8d';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

  chartInstance = new Chart(chartCanvas.value, {
    type: 'bar',
    data: {
      labels: days.map(d => d.date.slice(5)), // MM-DD
      datasets: [
        {
          label: '输入 Token',
          data: days.map(d => d.total_prompt_tokens),
          backgroundColor: isDark ? '#818cf8' : '#6366f1',
        },
        {
          label: '输出 Token',
          data: days.map(d => d.total_completion_tokens),
          backgroundColor: isDark ? '#a78bfa' : '#8b5cf6',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: textColor, padding: 16, usePointStyle: true, pointStyleWidth: 10 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${formatNumber(ctx.raw as number)}`,
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: textColor, maxRotation: 45, font: { size: 11 } },
          grid: { color: gridColor },
        },
        y: {
          stacked: true,
          ticks: { color: textColor, callback: (v) => formatNumber(v as number) },
          grid: { color: gridColor },
        },
      },
    },
  });
}

watch(activeTab, async (tab) => {
  if (tab === 'daily') { await nextTick(); renderChart(); }
  else { destroyChart(); }
});

watch(() => data.value, async (d) => {
  if (d && activeTab.value === 'daily') { await nextTick(); renderChart(); }
});

onUnmounted(() => destroyChart());
</script>

<template>
  <Transition name="fade">
    <div v-if="visible" class="usage-overlay" @mousedown.self="emit('close')">
      <div class="usage-panel">
        <!-- Header -->
        <div class="panel-header">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <h3>Token 用量统计</h3>
          <button class="close-btn" @click="emit('close')" title="关闭">&times;</button>
        </div>

        <!-- Tab bar -->
        <div class="tab-bar">
          <button :class="{ active: activeTab === 'overview' }" @click="activeTab = 'overview'">总览</button>
          <button :class="{ active: activeTab === 'agents' }" @click="activeTab = 'agents'">按 Agent</button>
          <button :class="{ active: activeTab === 'daily' }" @click="activeTab = 'daily'">按日期</button>
        </div>

        <!-- Body -->
        <div class="panel-body">
          <div v-if="loading" class="status-msg">加载中...</div>
          <div v-else-if="error" class="status-msg error">{{ error }}</div>
          <template v-else-if="data">
            <!-- ===== 总览 Tab ===== -->
            <div v-if="activeTab === 'overview'" class="overview-tab">
              <div class="stat-grid">
                <div class="stat-card">
                  <div class="stat-value">{{ formatNumber(data.overall.total_tokens) }}</div>
                  <div class="stat-label">总 Token</div>
                </div>
                <div class="stat-card">
                  <div class="stat-value">{{ formatNumber(data.overall.total_prompt_tokens) }}</div>
                  <div class="stat-label">输入 Token</div>
                </div>
                <div class="stat-card">
                  <div class="stat-value">{{ formatNumber(data.overall.total_completion_tokens) }}</div>
                  <div class="stat-label">输出 Token</div>
                </div>
                <div class="stat-card">
                  <div class="stat-value">{{ formatNumber(data.overall.total_react_turns) }}</div>
                  <div class="stat-label">ReAct 轮次</div>
                </div>
              </div>

              <div class="stat-grid">
                <div class="stat-card">
                  <div class="stat-value">{{ formatNumber(data.overall.total_cache_hit) }}</div>
                  <div class="stat-label">缓存命中</div>
                </div>
                <div class="stat-card">
                  <div class="stat-value">{{ formatNumber(data.overall.total_cache_miss) }}</div>
                  <div class="stat-label">缓存未命中</div>
                </div>
                <div class="stat-card">
                  <div class="stat-value">{{ cacheHitRate }}%</div>
                  <div class="stat-label">缓存命中率</div>
                </div>
                <div class="stat-card">
                  <div class="stat-value">{{ data.overall.total_records }}</div>
                  <div class="stat-label">总记录数</div>
                </div>
              </div>
            </div>

            <!-- ===== 按 Agent Tab ===== -->
            <div v-if="activeTab === 'agents'" class="table-tab">
              <table class="usage-table">
                <thead>
                  <tr>
                    <th class="sortable" @click="toggleSort('agent')">Agent{{ sortArrow('agent') }}</th>
                    <th class="sortable" @click="toggleSort('label')">名称{{ sortArrow('label') }}</th>
                    <th class="num sortable" @click="toggleSort('total_tokens')">总 Token{{ sortArrow('total_tokens') }}</th>
                    <th class="num sortable" @click="toggleSort('total_prompt_tokens')">输入{{ sortArrow('total_prompt_tokens') }}</th>
                    <th class="num sortable" @click="toggleSort('total_completion_tokens')">输出{{ sortArrow('total_completion_tokens') }}</th>
                    <th class="num sortable" @click="toggleSort('total_react_turns')">轮次{{ sortArrow('total_react_turns') }}</th>
                    <th class="num sortable" @click="toggleSort('total_cache_hit')">缓存命中{{ sortArrow('total_cache_hit') }}</th>
                    <th class="num sortable" @click="toggleSort('record_count')">记录数{{ sortArrow('record_count') }}</th>
                    <th class="sortable" @click="toggleSort('last_used')">最后活跃{{ sortArrow('last_used') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="agent in sortedAgents" :key="agent.agent">
                    <td class="agent-name">{{ agent.agent }}</td>
                    <td>{{ agentStore.getAgentName(agent.agent) }}</td>
                    <td class="num">{{ formatNumber(agent.total_tokens) }}</td>
                    <td class="num">{{ formatNumber(agent.total_prompt_tokens) }}</td>
                    <td class="num">{{ formatNumber(agent.total_completion_tokens) }}</td>
                    <td class="num">{{ agent.total_react_turns }}</td>
                    <td class="num">{{ formatNumber(agent.total_cache_hit) }}</td>
                    <td class="num">{{ agent.record_count }}</td>
                    <td class="date-cell">{{ formatDateTime(agent.last_used) }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-if="data.by_agent.length === 0" class="status-msg">暂无数据</div>
            </div>

            <!-- ===== 按日期 Tab ===== -->
            <div v-if="activeTab === 'daily'" class="chart-tab">
              <div class="chart-wrapper">
                <canvas ref="chartCanvas" />
              </div>
              <div v-if="data.by_day.length === 0" class="status-msg">暂无数据</div>
            </div>
          </template>
        </div>

        <!-- Footer -->
        <div class="panel-footer">
          <button class="btn-refresh" @click="loadData" :disabled="loading">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            刷新
          </button>
          <button class="btn-close" @click="emit('close')">关闭</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.usage-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.3);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
}

.usage-panel {
  background: var(--color-bg-page, #fff);
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 10px;
  width: 70vw; max-width: 900px;
  height: 70vh; max-height: 600px;
  display: flex; flex-direction: column;
  box-shadow: 0 8px 32px rgba(0,0,0,0.12);
}

.panel-header {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--color-border-secondary, #e0e0e0);
  flex-shrink: 0;
}
.panel-header h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--color-text-primary, #2c3e50); }
.close-btn { margin-left: auto; background: none; border: none; color: var(--color-text-secondary, #7f8c8d); font-size: 20px; cursor: pointer; line-height: 1; }
.close-btn:hover { color: var(--color-text-primary, #2c3e50); }

/* Tab bar */
.tab-bar {
  display: flex; gap: 0;
  border-bottom: 1px solid var(--color-border-secondary, #e0e0e0);
  flex-shrink: 0;
}
.tab-bar button {
  padding: 8px 20px; border: none; background: none;
  font-size: 13px; color: var(--color-text-tertiary, #a8abb2);
  cursor: pointer; border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}
.tab-bar button:hover { color: var(--color-text-primary, #2c3e50); }
.tab-bar button.active {
  color: var(--color-primary, #4f46e5);
  border-bottom-color: var(--color-primary, #4f46e5);
}

.panel-body {
  flex: 1; overflow-y: auto; padding: 18px;
}

.status-msg { text-align: center; padding: 40px; color: var(--color-text-tertiary, #a8abb2); font-size: 13px; }
.status-msg.error { color: #e74c3c; }

/* Stat cards */
.stat-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;
  margin-bottom: 16px;
}
.stat-card {
  background: #fff;
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 8px; padding: 14px;
  text-align: center;
}
.stat-value {
  font-size: 22px; font-weight: 700;
  color: var(--color-primary, #4f46e5);
  font-variant-numeric: tabular-nums;
}
.stat-label {
  font-size: 12px; color: var(--color-text-tertiary, #a8abb2);
  margin-top: 4px;
}

/* Table */
.table-tab { overflow-x: auto; }

/* Chart */
.chart-tab {
  display: flex; flex-direction: column; height: 100%;
}
.chart-wrapper {
  flex: 1; position: relative; min-height: 0;
}
.usage-table {
  width: 100%; border-collapse: collapse;
  font-size: 13px; font-variant-numeric: tabular-nums;
}
.usage-table th {
  text-align: left; padding: 8px 10px;
  border-bottom: 2px solid var(--color-border-secondary, #e0e0e0);
  color: var(--color-text-secondary, #7f8c8d);
  font-weight: 600; white-space: nowrap;
  user-select: none;
}
.usage-table th.sortable {
  cursor: pointer;
}
.usage-table th.sortable:hover {
  color: var(--color-primary, #4f46e5);
}
.usage-table th.num { text-align: right; }
.usage-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border-secondary, rgba(0,0,0,0.05));
  color: var(--color-text-primary, #2c3e50);
}
.usage-table td.num { text-align: right; }
.usage-table .agent-name { font-weight: 500; }
.usage-table .date-cell { color: var(--color-text-tertiary, #a8abb2); white-space: nowrap; }
.usage-table tbody tr:hover { background: var(--color-bg-hover, rgba(79,70,229,0.04)); }

/* Footer */
.panel-footer {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 10px 18px; border-top: 1px solid var(--color-border-secondary, #e0e0e0);
  flex-shrink: 0;
}
.btn-refresh {
  display: flex; align-items: center; gap: 4px;
  padding: 6px 14px; border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 6px; background: var(--color-bg-subtle, #f8f9fa);
  color: var(--color-text-secondary, #7f8c8d);
  font-size: 12px; cursor: pointer;
}
.btn-refresh:hover { color: var(--color-text-primary, #2c3e50); background: var(--color-bg-hover, rgba(0,0,0,0.05)); }
.btn-refresh:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-close {
  padding: 6px 14px; border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 6px; background: transparent;
  color: var(--color-text-secondary, #7f8c8d);
  font-size: 12px; cursor: pointer;
}
.btn-close:hover { color: var(--color-text-primary, #2c3e50); background: var(--color-bg-hover, rgba(0,0,0,0.05)); }

/* Transition —— 不能写在 scoped 里，因为 <Transition> 添加的类名不带 scoped data 属性 */
</style>

<style>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>

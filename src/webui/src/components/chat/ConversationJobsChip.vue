// ============================================================
// components/chat/ConversationJobsChip.vue —— 会话头任务清单入口
//
// 各会话头（DialogView header-actions）的「后台任务 / 子Agent 调用」
// 双清单入口：按发起会话键（conversationId）过滤 stores/jobs——本会话
// run 里启动的 bash 后台与 subagent 委派（对桶键 / singles sid / 群 gid
// 同词表）。数据与侧边栏运行跟踪面板同源（单一 store，job/started·
// settled 帧驱动刷新）；本会话无任务时不渲染（零占位）。
// 弹层形态对齐会话头 Token 仪表（token-panel：头部下挂 + 点外关闭）。
// ============================================================

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { Icon } from '../../ui';
import { useJobsStore } from '../../stores/jobs';
import {
  jobIsSubagent,
  jobOutputPreview,
  jobStatusLabel,
  jobStatusIcon,
  jobsForConversation,
  splitJobs,
  subagentMeta,
  type WireJob,
} from '../../api/jobs.ts';
import { formatDurationMs } from '../../utils/format.ts';

const props = defineProps<{
  /** 本会话键（1v1 对桶键 / singles sid / 群 gid；null = 无会话，不渲染） */
  conversationId: string | null;
}>();

const jobsStore = useJobsStore();
onMounted(() => jobsStore.ensureStarted());

const open = ref(false);
/** 运行时长秒针：仅弹层展开期间走表（收起/无任务零定时器） */
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;

function toggle() {
  open.value = !open.value;
  if (open.value) {
    now.value = Date.now();
    ticker ??= setInterval(() => {
      now.value = Date.now();
    }, 1000);
    // 点外关闭（弹层自身 @click.stop 拦截——内部点击不触发）
    setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
  } else {
    close();
  }
}

function close() {
  open.value = false;
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

/** 会话切换即收起（弹层内数据已随 props 重算，避免旧会话清单残留在屏） */
watch(() => props.conversationId, close);
onUnmounted(close);

// ── 本会话清单拆分（与运行跟踪面板同款纯函数，粒度收窄到会话）──
/** 终态展示上限（会话头弹层比侧栏面板更紧凑） */
const SETTLED_CAP = 8;

const scoped = computed(() => jobsForConversation(jobsStore.jobs ?? [], props.conversationId));
const jobsSplit = computed(() => splitJobs(scoped.value));
const bgRunning = computed(() => jobsSplit.value.running.filter((j) => !jobIsSubagent(j)));
const subRunning = computed(() => jobsSplit.value.running.filter(jobIsSubagent));
const bgSettledAll = computed(() => jobsSplit.value.settled.filter((j) => !jobIsSubagent(j)));
const subSettledAll = computed(() => jobsSplit.value.settled.filter(jobIsSubagent));
const bgSettled = computed(() => bgSettledAll.value.slice(0, SETTLED_CAP));
const subSettled = computed(() => subSettledAll.value.slice(0, SETTLED_CAP));
const total = computed(() => scoped.value.length);

/** 行 tooltip：身份 + 终态/输出预览（与面板同词汇，无名册解析——头部空间紧凑） */
function rowTitle(j: WireJob): string {
  const lines = [`${j.label}`, `${j.id} · ${j.kind}`];
  if (j.status !== 'running' && j.status !== 'stopping') {
    lines.push(`${jobStatusLabel(j.status)}${j.detail ? `：${j.detail}` : ''}`);
    const preview = jobOutputPreview(j);
    if (preview) lines.push(`${jobIsSubagent(j) ? '结果' : '输出'}：${preview}`);
  }
  return lines.join('\n');
}

/** 子 Agent 显示名（meta.name；缺省「子任务」） */
function subName(j: WireJob): string {
  return subagentMeta(j).name ?? '子任务';
}

/** 终止（运行中行的 stop 按钮；killing 态由 store 管理） */
function doKill(id: string) {
  void jobsStore.kill(id);
}
</script>

<template>
  <div
    v-if="total > 0"
    class="conv-jobs"
    :class="{ 'is-open': open }"
    :title="`本会话后台任务与子Agent 调用（运行中 ${jobsSplit.running.length} · 终态 ${jobsSplit.settled.length}）`"
    @click.stop="toggle"
  >
    <span class="cj-icon kind-job"><Icon name="terminal" :size="13" /></span>
    <span v-if="bgRunning.length > 0" class="cj-count">{{ bgRunning.length }}</span>
    <span class="cj-icon kind-sub"><Icon name="bot" :size="13" /></span>
    <span v-if="subRunning.length > 0" class="cj-count">{{ subRunning.length }}</span>

    <transition name="fade">
      <div v-if="open" class="cj-panel" @click.stop>
        <div class="cj-head">
          <span class="cj-title">本会话任务</span>
          <span class="cj-sub">运行 {{ jobsSplit.running.length }} · 终态 {{ jobsSplit.settled.length }}</span>
        </div>

        <!-- 后台任务（bash 后台等） -->
        <div class="cj-section">
          <div class="cj-section-title kind-job"><Icon name="terminal" :size="12" /> 后台任务</div>
          <div v-if="bgRunning.length + bgSettledAll.length === 0" class="cj-empty">暂无</div>
          <div v-for="j in bgRunning" :key="j.id" class="cj-row" :title="rowTitle(j)">
            <span class="cj-st" :class="'st-' + j.status"><Icon :name="jobStatusIcon(j.status)" :size="12" /></span>
            <span class="cj-label">{{ j.label }}</span>
            <span class="cj-dur">{{ formatDurationMs(now - j.startedAt) }}</span>
            <button class="cj-stop" :disabled="jobsStore.killing.has(j.id)" title="请求终止（settle 为 killed）" @click.stop="doKill(j.id)">
              <Icon name="stop" :size="9" />
            </button>
          </div>
          <div v-for="j in bgSettled" :key="j.id" class="cj-row" :title="rowTitle(j)">
            <span class="cj-st" :class="'st-' + j.status"><Icon :name="jobStatusIcon(j.status)" :size="12" /></span>
            <span class="cj-label dim">{{ j.label }}</span>
            <span class="cj-status" :class="'st-' + j.status">{{ jobStatusLabel(j.status) }}</span>
          </div>
          <div v-if="bgSettledAll.length > bgSettled.length" class="cj-more">仅显示最近 {{ bgSettled.length }} 条（终态共 {{ bgSettledAll.length }} 条）</div>
        </div>

        <!-- 子Agent 调用（kind=subagent） -->
        <div class="cj-section">
          <div class="cj-section-title kind-sub"><Icon name="bot" :size="12" /> 子Agent 调用</div>
          <div v-if="subRunning.length + subSettledAll.length === 0" class="cj-empty">暂无</div>
          <div v-for="j in subRunning" :key="j.id" class="cj-row" :title="rowTitle(j)">
            <span class="cj-st" :class="'st-' + j.status"><Icon :name="jobStatusIcon(j.status)" :size="12" /></span>
            <span class="cj-label">{{ subName(j) }}</span>
            <span class="cj-dur">{{ formatDurationMs(now - j.startedAt) }}</span>
            <button class="cj-stop" :disabled="jobsStore.killing.has(j.id)" title="请求终止（abort 子 Agent）" @click.stop="doKill(j.id)">
              <Icon name="stop" :size="9" />
            </button>
          </div>
          <div v-for="j in subSettled" :key="j.id" class="cj-row" :title="rowTitle(j)">
            <span class="cj-st" :class="'st-' + j.status"><Icon :name="jobStatusIcon(j.status)" :size="12" /></span>
            <span class="cj-label dim">{{ subName(j) }}</span>
            <span class="cj-status" :class="'st-' + j.status">{{ jobStatusLabel(j.status) }}</span>
          </div>
          <div v-if="subSettledAll.length > subSettled.length" class="cj-more">仅显示最近 {{ subSettled.length }} 条（终态共 {{ subSettledAll.length }} 条）</div>
        </div>

        <div class="cj-note">仅本会话发起的任务；全局清单（含宿主任务）见侧边栏「运行跟踪」面板。</div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
/* 入口（对齐 session-token-gauge：相对定位宿主 + hover/is-open 浮起） */
.conv-jobs{position:relative;display:flex;align-items:center;gap:3px;margin-left:6px;padding:2px 6px;flex-shrink:0;cursor:pointer;border-radius:var(--radius-sm);user-select:none}
.conv-jobs:hover,.conv-jobs.is-open{background:var(--color-bg-surface)}
.cj-icon{display:flex;align-items:center;justify-content:center}
.cj-icon.kind-job{color:#0ea5e9}
.cj-icon.kind-sub{color:#8b5cf6}
.cj-count{min-width:14px;height:14px;padding:0 3px;display:flex;align-items:center;justify-content:center;border-radius:999px;background:#ef4444;color:#fff;font-size:10px;font-weight:600;line-height:1}

/* 弹层（对齐 token-panel：头部下挂 + 右对齐） */
.cj-panel{position:absolute;top:calc(100% + 8px);right:0;z-index:60;width:min(360px,86vw);max-height:min(420px,60vh);overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--color-bg-page,#fff);border:1px solid var(--color-border-primary,#e0e0e0);border-radius:var(--radius-md,8px);box-shadow:0 4px 16px rgba(0,0,0,.12);cursor:default;text-align:left}
.cj-head{display:flex;align-items:center;justify-content:space-between}
.cj-title{font-size:12px;font-weight:600;color:var(--color-text-primary)}
.cj-sub{font-size:11px;color:var(--color-text-tertiary,#a8abb2);font-variant-numeric:tabular-nums}

.cj-section{display:flex;flex-direction:column;gap:2px}
.cj-section-title{display:flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:var(--color-text-secondary);padding:2px 0}
.cj-section-title.kind-job{color:#0ea5e9}
.cj-section-title.kind-sub{color:#8b5cf6}
.cj-empty{font-size:11px;color:var(--color-text-muted,#999);padding:0 2px}

.cj-row{display:flex;align-items:center;gap:6px;min-height:24px;padding:1px 2px;border-radius:var(--radius-sm);font-size:12px}
.cj-row:hover{background:var(--color-bg-hover,rgba(0,0,0,.04))}
.cj-st{display:flex;align-items:center;justify-content:center;flex-shrink:0}
.cj-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-text-primary)}
.cj-label.dim{color:var(--color-text-secondary)}
.cj-dur{font-size:11px;font-weight:600;color:var(--color-text-primary);font-variant-numeric:tabular-nums;flex-shrink:0}
.cj-status{font-size:11px;font-weight:600;flex-shrink:0}
.cj-more{font-size:11px;color:var(--color-text-muted,#999);padding:0 2px}

/* 状态色（与运行跟踪面板 st-* 同词汇） */
.st-running{color:#f59e0b}
.st-stopping{color:var(--color-text-tertiary,#a8abb2)}
.st-completed{color:#22c55e}
.st-failed{color:#e74c3c}
.st-killed{color:var(--color-text-muted,#999)}

/* 终止按钮（hover 浮现） */
.cj-stop{display:flex;align-items:center;justify-content:center;width:18px;height:18px;border:none;border-radius:4px;background:none;color:#e74c3c;cursor:pointer;flex-shrink:0;opacity:0;transition:opacity var(--transition-fast)}
.cj-row:hover .cj-stop{opacity:1}
.cj-stop:hover:not(:disabled){background:rgba(231,76,60,.1)}
.cj-stop:disabled{opacity:.4;cursor:wait}

.cj-note{font-size:11px;line-height:1.5;color:var(--color-text-tertiary,#999);border-top:1px solid var(--color-border-primary,#e0e0e0);padding-top:6px}
</style>

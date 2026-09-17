<script setup lang="ts">
// run_code 程序卡（v2 时间线版）：四段式——程序体（TS）· 工具调用时间线
// （逐条 trace：图标 + 工具名 + 一句话 + 耗时 + 状态；**展示调用了哪些
// 工具**是本版核心诉求）· 返回值（return 压缩结论）· 错误。
// 数据面（useToolResult 三形归一后传入 data）：
//   调用中：{ code, ... }（参数预览——程序体即时可见；无时间线）
//   完成态：{ summary: { calls, ok, failed, computeMs, wallMs, denied,
//             serialized, trace: SubcallTrace[], traceTruncated? },
//             programHash, value?, error? }
import { computed, ref, onBeforeUnmount } from 'vue';
import { useMarkdown } from 'ac-client-ui-renderer/client/useMarkdown.ts';
import ScrollableViewport from 'ac-client-ui-renderer/client/ScrollableViewport.vue';
import { Icon } from '@agentchat/webui-kit';
import { toolIconName } from 'ac-client-ui-tool/client/toolIcon.ts';

const props = defineProps<{ data: Record<string, unknown>; toolName?: string; loading?: boolean }>();

const { render } = useMarkdown();

// ---- 程序体 ----
const code = computed(() => {
  const c = props.data.code;
  return typeof c === 'string' ? c : '';
});
const lineCount = computed(() => (code.value ? code.value.split('\n').length : 0));
function fenceOf(text: string): string {
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return fence;
}
const renderedCode = computed(() => {
  if (!code.value) return '';
  return render(`${fenceOf(code.value)}typescript\n${code.value}\n${fenceOf(code.value)}`);
});

// ---- 执行摘要 + 时间线 ----
interface SubcallTrace {
  seq: number; name: string; ok: boolean; ms: number;
  brief: string; error?: string;
}
const summary = computed<{
  calls: number; ok: number; failed: number; computeMs: number; wallMs: number;
  denied: Array<{ name: string; error: string }>;
  serialized: number[];
  trace: SubcallTrace[];
  traceTruncated?: number;
} | null>(() => {
  const s = props.data.summary;
  if (s === null || typeof s !== 'object') return null;
  return s as never;
});
const programHash = computed(() => {
  const h = props.data.programHash;
  return typeof h === 'string' ? h : '';
});
const trace = computed<SubcallTrace[]>(() => summary.value?.trace ?? []);
const serialSet = computed(() => new Set(summary.value?.serialized ?? []));
const traceTruncated = computed(() => summary.value?.traceTruncated ?? 0);
/** 耗时条宽度（相对最长调用——并行/串行的相对时长一眼可见） */
const maxMs = computed(() => Math.max(1, ...trace.value.map((t) => t.ms)));
function barWidth(t: SubcallTrace): string {
  return `${Math.max(4, Math.round((t.ms / maxMs.value) * 100))}%`;
}
/** 时间线可视化展开态（超过 8 条默认折叠为一行统计） */
const TRACE_FOLD = 8;
const traceExpanded = ref(false);
const traceVisible = computed(() =>
  traceExpanded.value ? trace.value : trace.value.slice(0, TRACE_FOLD),
);

/** 汇总徽章 */
const badges = computed(() => {
  if (!summary.value) return [] as Array<{ text: string; cls: string; title?: string }>;
  const s = summary.value;
  const out: Array<{ text: string; cls: string; title?: string }> = [];
  out.push({ text: `调用 ${s.ok}/${s.calls}`, cls: s.failed > 0 ? 'rc-badge-warn' : 'rc-badge-ok', title: `子调用 ${s.ok} 成功 / ${s.failed} 失败` });
  if (s.serialized.length > 0) out.push({ text: `串行 ${s.serialized.length}`, cls: 'rc-badge-dim', title: '写路径/命令类按提交序串行执行' });
  out.push({ text: `${s.computeMs}ms 计算`, cls: 'rc-badge-dim', title: `子调用累计 ${s.computeMs}ms（墙钟 ${s.wallMs}ms）` });
  return out;
});
const deniedList = computed(() => summary.value?.denied ?? []);

// ---- 返回值 ----
const value = computed<unknown>(() => props.data.value);
const valueText = computed(() => {
  if (value.value === undefined) return '';
  // BigInt 等不可 JSON 化的值会让 stringify 抛错（整个卡崩）——回落字符串形态
  try {
    return JSON.stringify(value.value, null, 2) ?? 'null';
  } catch {
    return String(value.value);
  }
});
const VALUE_CLIP = 600;
const valueExpanded = ref(false);
const valueIsLong = computed(() => valueText.value.length > VALUE_CLIP);
// 折叠态只截文本本体；「已截断」提示在代码块外单列（json 高亮下非法尾缀观感差）
const renderedValue = computed(() => {
  if (valueText.value === '') return '';
  const body = valueExpanded.value || !valueIsLong.value ? valueText.value : valueText.value.slice(0, VALUE_CLIP);
  return render(`${fenceOf(body)}json\n${body}\n${fenceOf(body)}`);
});

// ---- 错误 ----
const errorText = computed(() => {
  const e = props.data.error;
  return typeof e === 'string' && e ? e : '';
});
const isError = computed(() => errorText.value !== '');

// ---- 复制程序 ----
const copyState = ref<'idle' | 'copied'>('idle');
let copyTimer: ReturnType<typeof setTimeout> | null = null;
onBeforeUnmount(() => { if (copyTimer) clearTimeout(copyTimer); });
async function copyCode() {
  try {
    await navigator.clipboard.writeText(code.value);
    copyState.value = 'copied';
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copyState.value = 'idle'; }, 2000);
  } catch { /* ignore */ }
}
</script>

<template>
  <div class="tool-result-run-code" :class="{ 'is-error': isError }">
    <!-- ============ ① 程序体 ============ -->
    <div v-if="code" class="rc-section rc-code">
      <div class="rc-head">
        <span class="rc-head-label">program.ts</span>
        <span class="rc-head-meta">
          <span class="rc-lang-badge">TypeScript</span>
          <span class="rc-meta-dim">{{ lineCount }} 行</span>
          <span v-if="programHash" class="rc-meta-dim rc-hash" :title="`程序体哈希 ${programHash}（全文在宿主日志按哈希回捞）`">#{{ programHash }}</span>
        </span>
        <button class="rc-copy-btn" :class="{ copied: copyState === 'copied' }" @click="copyCode" title="复制程序全文">
          <svg v-if="copyState !== 'copied'" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          <svg v-else xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>{{ copyState === 'copied' ? '已复制' : '复制' }}</span>
        </button>
      </div>
      <ScrollableViewport max-height="40vh" class="rc-viewport">
        <div class="rc-code-body" v-html="renderedCode" />
      </ScrollableViewport>
    </div>

    <!-- 执行中（无摘要返回时） -->
    <div v-if="loading || (!summary && !errorText)" class="rc-running">
      <span class="loading-dot dot-yellow"></span>
      <span class="loading-dot dot-gray"></span>
      <span class="loading-dot dot-gray"></span>
      <span class="rc-running-text">程序执行中…（中间调用不回上下文，仅 return 值返回）</span>
    </div>

    <!-- ============ ② 工具调用时间线（本卡核心段） ============ -->
    <div v-if="summary" class="rc-section rc-trace">
      <div class="rc-trace-head">
        <span class="rc-trace-title">工具调用</span>
        <span v-for="b in badges" :key="b.text" class="rc-badge" :class="b.cls" :title="b.title">{{ b.text }}</span>
        <span v-if="deniedList.length" class="rc-badge rc-badge-denied" :title="deniedList.map(d => `${d.name}: ${d.error}`).join('\n')">
          <Icon name="ban" :size="11" /> 被拒 {{ deniedList.length }}
        </span>
      </div>

      <!-- 逐条时间线 -->
      <div v-if="trace.length" class="rc-trace-list">
        <div
          v-for="t in traceVisible"
          :key="t.seq"
          class="rc-trace-row"
          :class="{ 'rc-trace-fail': !t.ok }"
          :title="t.ok ? `${t.name} · ${t.ms}ms` : t.error || `${t.name} 失败`"
        >
          <!-- 状态点（绿=成功 红=失败） -->
          <span class="rc-dot" :class="t.ok ? 'rc-dot-ok' : 'rc-dot-fail'"></span>
          <!-- 工具图标（复用工具卡图标词表——与模型直接调用的卡片同象形） -->
          <Icon :name="toolIconName(t.name)" :size="13" class="rc-trace-icon" />
          <!-- 工具名 + 简述 -->
          <span class="rc-trace-name">{{ t.name }}</span>
          <span v-if="serialSet.has(t.seq)" class="rc-trace-serial" title="写路径/命令类——按提交序串行执行">串行</span>
          <span class="rc-trace-brief">{{ t.brief }}</span>
          <!-- 耗时条 + 毫秒数（相对最长调用的比例条——并行簇里谁慢一眼可见） -->
          <span class="rc-trace-ms">{{ t.ms }}ms</span>
          <span class="rc-trace-bar" :style="{ width: barWidth(t) }" :class="t.ok ? 'rc-bar-ok' : 'rc-bar-fail'"></span>
        </div>
        <!-- 折叠控制（超 8 条） -->
        <button v-if="trace.length > TRACE_FOLD" class="rc-trace-toggle" @click="traceExpanded = !traceExpanded">
          {{ traceExpanded ? '收起时间线' : `展开全部 ${trace.length} 条调用` }}
        </button>
        <div v-if="traceTruncated > 0" class="rc-trace-more">另有 {{ traceTruncated }} 条未逐一记录（超出 50 条上限）</div>
      </div>
      <div v-else class="rc-trace-empty">（无子调用——纯计算程序）</div>
    </div>

    <!-- ============ ③ 返回值 / 错误 ============ -->
    <div v-if="errorText" class="rc-section rc-error">
      <div class="rc-error-title"><Icon name="alert-circle" :size="12" /> 程序失败</div>
      <pre class="rc-error-text"><code>{{ errorText }}</code></pre>
    </div>
    <div v-else-if="value !== undefined" class="rc-section rc-value">
      <div class="rc-head">
        <span class="rc-head-label">return</span>
        <span v-if="valueIsLong && !valueExpanded" class="rc-meta-dim">已折叠（{{ valueText.length }} 字符）</span>
        <button v-if="valueIsLong" class="rc-expand-btn" @click="valueExpanded = !valueExpanded">
          {{ valueExpanded ? '收起' : `展开全部（${valueText.length} 字符）` }}
        </button>
      </div>
      <ScrollableViewport max-height="30vh" class="rc-viewport">
        <div class="rc-value-body" v-html="renderedValue" />
      </ScrollableViewport>
    </div>
    <div v-else-if="summary" class="rc-section rc-empty-return">
      <span class="rc-meta-dim">（程序无返回值——仅执行了副作用）</span>
    </div>
  </div>
</template>

<style scoped>
.tool-result-run-code {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 2px 0;
}

.rc-section {
  background: var(--color-bg-secondary, rgba(148, 163, 184, 0.06));
  border: 1px solid var(--color-border-secondary, rgba(148, 163, 184, 0.16));
  border-radius: 8px;
  overflow: hidden;
}

/* ---- 头部条 ---- */
.rc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--color-border-secondary, rgba(148, 163, 184, 0.14));
  background: var(--color-bg-tertiary, rgba(148, 163, 184, 0.05));
  font-size: 11px;
  user-select: none;
}
.rc-head-label {
  font-weight: 600;
  color: var(--color-text-secondary);
  font-family: 'SF Mono', 'Consolas', monospace;
}
.rc-head-meta { display: flex; align-items: center; gap: 8px; min-width: 0; }
.rc-lang-badge { color: #3178c6; font-weight: 600; font-size: 10px; }
.rc-meta-dim { color: var(--color-text-tertiary); font-size: 10.5px; }
.rc-hash { font-family: 'SF Mono', 'Consolas', monospace; cursor: help; }

.rc-copy-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: all 0.15s;
  flex-shrink: 0;
}
.rc-copy-btn:hover { color: var(--color-text-primary); background: var(--color-bg-hover, rgba(148, 163, 184, 0.12)); }
.rc-copy-btn.copied { color: #4ade80; }

/* 嵌套代码块按卡内规格覆盖（markdown.css 的 .md-code-block 系列全挂
   .markdown-body 前缀——工具卡在 .tool-body 内不命中；同处置见
   ToolResultWrite/ToolResultCode）：banner 隐藏（卡头已有标题 + 复制按钮，
   其样式与复制点击委托均在 markdown 上下文外 = 死控件） */
.rc-code-body :deep(.md-code-block),
.rc-value-body :deep(.md-code-block) { margin: 0; border: none; border-radius: 0; background: transparent; min-width: 0; }
.rc-code-body :deep(.md-code-block-banner),
.rc-value-body :deep(.md-code-block-banner) { display: none; }
.rc-code-body :deep(.md-code-block pre),
.rc-value-body :deep(pre) { margin: 0; padding: 8px 12px; font-size: 12px; line-height: 1.6; }
.rc-code-body :deep(code),
.rc-value-body :deep(code) { font-family: 'SF Mono', 'Monaco', 'Consolas', monospace; }

/* ---- 执行中 ---- */
.rc-running {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  color: var(--color-text-tertiary);
  font-size: 11.5px;
  user-select: none;
}
.rc-running .loading-dot { width: 5px; height: 5px; border-radius: 50%; animation: rc-dot-pulse 1.4s infinite ease-in-out; }
.rc-running .loading-dot.dot-yellow { background: #e6a817; }
.rc-running .loading-dot.dot-gray { background: #a8abb2; animation-delay: 0.3s; }
.rc-running .loading-dot.dot-gray:last-child { animation-delay: 0.6s; }
@keyframes rc-dot-pulse { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }
.rc-running-text { margin-left: 2px; }

/* ---- 时间线段 ---- */
.rc-trace { border: none; background: transparent; }
.rc-trace-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 5px;
}
.rc-trace-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--color-text-secondary);
}
.rc-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 10px;
  user-select: none;
  white-space: nowrap;
}
.rc-badge-ok { color: #4ade80; background: rgba(74, 222, 128, 0.1); }
.rc-badge-warn { color: #fbbf24; background: rgba(251, 191, 36, 0.1); }
.rc-badge-dim { color: var(--color-text-tertiary); background: var(--color-bg-secondary, rgba(148, 163, 184, 0.08)); }
.rc-badge-denied { color: #f87171; background: rgba(248, 113, 113, 0.1); cursor: help; }

.rc-trace-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border-left: 2px solid var(--color-border-secondary, rgba(148, 163, 184, 0.18));
  padding-left: 8px;
  margin-left: 4px;
}
.rc-trace-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  padding: 2.5px 4px;
  border-radius: 4px;
  min-width: 0;
}
.rc-trace-row:hover { background: var(--color-bg-hover, rgba(148, 163, 184, 0.07)); }

.rc-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.rc-dot-ok { background: #4ade80; }
.rc-dot-fail { background: #f87171; }

.rc-trace-icon { color: var(--color-text-tertiary); flex-shrink: 0; }
.rc-trace-name {
  font-family: 'SF Mono', 'Consolas', monospace;
  font-weight: 600;
  color: var(--color-text-primary, var(--color-text-secondary));
  flex-shrink: 0;
}
.rc-trace-serial {
  font-size: 9.5px;
  color: #fbbf24;
  border: 1px solid rgba(251, 191, 36, 0.4);
  border-radius: 3px;
  padding: 0 3px;
  flex-shrink: 0;
  cursor: help;
  user-select: none;
}
.rc-trace-brief {
  color: var(--color-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 0 1 auto;
}
.rc-trace-fail .rc-trace-brief { color: var(--color-error, #f87171); }
.rc-trace-ms {
  margin-left: auto;
  color: var(--color-text-tertiary);
  font-family: 'SF Mono', 'Consolas', monospace;
  font-size: 10.5px;
  flex-shrink: 0;
}
.rc-trace-bar {
  height: 3px;
  border-radius: 2px;
  flex: 0 0 44px;
  align-self: center;
  opacity: 0.55;
}
.rc-bar-ok { background: #4ade80; }
.rc-bar-fail { background: #f87171; }

.rc-trace-toggle {
  align-self: flex-start;
  border: none;
  background: transparent;
  color: var(--color-accent, #4a90d9);
  font-size: 11px;
  cursor: pointer;
  padding: 3px 4px;
  border-radius: 4px;
}
.rc-trace-toggle:hover { background: var(--color-bg-hover, rgba(148, 163, 184, 0.12)); }
.rc-trace-more {
  font-size: 10.5px;
  color: var(--color-text-tertiary);
  padding: 2px 4px;
}
.rc-trace-empty {
  font-size: 11.5px;
  color: var(--color-text-tertiary);
  font-style: italic;
  padding-left: 4px;
}

/* ---- 错误 ---- */
.rc-error-title {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--color-error, #f87171);
  font-size: 11.5px;
  font-weight: 600;
  padding: 6px 10px 0;
}
.rc-error-text {
  margin: 4px 10px 8px;
  color: var(--color-error, #f87171);
  font-family: 'SF Mono', 'Consolas', monospace;
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---- 返回值 ---- */
.rc-expand-btn {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--color-accent, #4a90d9);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}
.rc-expand-btn:hover { background: var(--color-bg-hover, rgba(148, 163, 184, 0.12)); }

.rc-empty-return { border: none; background: transparent; padding: 0; }
</style>

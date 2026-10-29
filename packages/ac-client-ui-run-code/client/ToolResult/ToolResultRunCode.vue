<script setup lang="ts">
// run_code 程序卡：三段式——程序体（TS）· 执行摘要徽章 · 返回值（return
// 压缩结论；纯 string 按普通文本直显，其余走 JSON 代码块）/ 错误。
// 卡内逐条「工具调用」时间线已退役（cr-764）——每个子调用由紧随本卡的
// subcall 平铺卡完整展示（图标/参数/结果/状态），卡内只留汇总徽章
// （调用计数、串行数、机器耗时、被拒；被拒徽章是 denied 子调用
// ——before-execute 被 veto、无 started/after-execute 帧——唯一的前端可见面）。
// 数据面（useToolResult 三形归一后传入 data）：
//   调用中：{ code, ... }（参数预览——程序体即时可见）
//   完成态：{ summary: { calls, ok, failed, computeMs, wallMs, denied,
//             serialized, trace: SubcallTrace[], traceTruncated?, frozenMs?,
//             programHash, value?, error? }（trace 数据面保留——协议形状
//             镜像，卡内不再逐条渲染）
import { computed, ref, onBeforeUnmount } from 'vue';
import { useMarkdown } from 'ac-client-ui-renderer/client/useMarkdown.ts';
import ScrollableViewport from 'ac-client-ui-renderer/client/ScrollableViewport.vue';
import { Icon } from '@agentchat/webui-kit';
import { fenceOf } from 'ac-client-ui-renderer/client/codeFence.ts';

const props = defineProps<{ data: Record<string, unknown>; loading?: boolean }>();

const { render } = useMarkdown();

// ---- 程序体 ----
const code = computed(() => {
  const c = props.data.code;
  return typeof c === 'string' ? c : '';
});
const lineCount = computed(() => (code.value ? code.value.split('\n').length : 0));
const renderedCode = computed(() => {
  if (!code.value) return '';
  return render(`${fenceOf(code.value)}typescript\n${code.value}\n${fenceOf(code.value)}`);
});

// ---- 执行摘要 ----
// 形状镜像 ac-run-code/src/protocol.ts（RunSummary/SubcallTrace）——RPC 结果
// 信封不引类型（行独立可摘除），前端卡内注释投影（subagent SubagentInfo 同款惯例）
interface SubcallTrace {
  seq: number; name: string; ok: boolean; ms: number;
  brief: string; error?: string;
}
interface RunSummaryShape {
  calls: number; ok: number; failed: number; computeMs: number; wallMs: number;
  /** 预算冻结区间毫秒（ask_questions/approval 用户应答等待期；后端可选省略） */
  frozenMs?: number;
  denied: Array<{ name: string; error: string }>;
  serialized: number[];
  /** 逐条子调用轨迹——数据面保留（协议形状镜像），卡内不渲染（cr-764） */
  trace: SubcallTrace[];
  traceTruncated?: number;
}
const summary = computed<RunSummaryShape | null>(() => {
  const s = props.data.summary;
  if (s === null || typeof s !== 'object') return null;
  return s as RunSummaryShape;
});
const programHash = computed(() => {
  const h = props.data.programHash;
  return typeof h === 'string' ? h : '';
});
/** 汇总徽章 */
const badges = computed(() => {
  if (!summary.value) return [] as Array<{ text: string; cls: string; title?: string }>;
  const s = summary.value;
  const out: Array<{ text: string; cls: string; title?: string }> = [];
  out.push({ text: `调用 ${s.ok}/${s.calls}`, cls: s.failed > 0 ? 'warn' : 'ok', title: `子调用 ${s.ok} 成功 / ${s.failed} 失败` });
  if (s.serialized.length > 0) out.push({ text: `串行 ${s.serialized.length}`, cls: 'dim', title: '写路径/命令类按提交序串行执行' });
  const freezeNote = s.frozenMs ? `，其中用户应答等待 ${s.frozenMs}ms 不计机器预算` : '';
  out.push({ text: `${s.computeMs}ms 计算`, cls: 'dim', title: `子调用累计 ${s.computeMs}ms（墙钟 ${s.wallMs}ms${freezeNote}）` });
  return out;
});
const deniedList = computed(() => summary.value?.denied ?? []);

// ---- 返回值 ----
const value = computed<unknown>(() => props.data.value);
// 纯 string 返回值（如 ask_questions 的「用户已答复」）按普通文本渲染——
// 不 stringify 成带引号的 JSON（多行文本会全变 \n 转义，可读性差）
const valueIsPlain = computed(() => typeof value.value === 'string');
const valueText = computed(() => {
  if (value.value === undefined) return '';
  if (typeof value.value === 'string') return value.value;
  // BigInt 等不可 JSON 化的值会让 stringify 抛错（整个卡崩）——回落字符串形态
  try {
    return JSON.stringify(value.value, null, 2);
  } catch {
    return String(value.value);
  }
});
const VALUE_CLIP = 600;
const valueExpanded = ref(false);
const valueIsLong = computed(() => valueText.value.length > VALUE_CLIP);
// 折叠态只截文本本体；「已截断」提示在代码块外单列（json 高亮下非法尾缀观感差）
const valueBody = computed(() =>
  valueExpanded.value || !valueIsLong.value ? valueText.value : valueText.value.slice(0, VALUE_CLIP),
);
const renderedValue = computed(() => {
  if (valueBody.value === '' || valueIsPlain.value) return '';
  return render(`${fenceOf(valueBody.value)}json\n${valueBody.value}\n${fenceOf(valueBody.value)}`);
});

// ---- 错误 ----
const errorText = computed(() => {
  const e = props.data.error;
  return typeof e === 'string' && e ? e : '';
});

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
  <div class="tool-result-run-code">
    <!-- ============ ① 程序体 ============ -->
    <div v-if="code" class="rc-section rc-code">
      <div class="rc-head">
        <span class="rc-head-label">program.ts</span>
        <span class="rc-head-meta">
          <span class="ui-badge kind rc-lang-badge">TypeScript</span>
          <span class="rc-meta-dim">{{ lineCount }} 行</span>
          <span v-if="programHash" class="rc-meta-dim rc-hash" :title="`程序体哈希 ${programHash}（全文在宿主日志按哈希回捞）`">#{{ programHash }}</span>
        </span>
        <!-- cr-226：原生 title——Tooltip ::after 会超出 .rc-section（overflow:hidden）右缘被裁剪 -->
        <button class="rc-copy-btn" :class="{ copied: copyState === 'copied' }" :title="copyState === 'copied' ? '已复制' : '复制程序全文'" :aria-label="copyState === 'copied' ? '已复制' : '复制程序全文'" @click="copyCode">
            <Icon :name="copyState === 'copied' ? 'check' : 'copy'" :size="13" />
            <span>{{ copyState === 'copied' ? '已复制' : '复制' }}</span>
        </button>
      </div>
      <ScrollableViewport class="rc-viewport">
        <div class="rc-code-body" v-html="renderedCode" />
      </ScrollableViewport>
    </div>

    <!-- 执行中（无摘要返回时）：琥珀旋转环——2026-09-18 全前端"忙"指示统一
         （tool-spin-ring 同款；类名复用以进 prefers-reduced-motion 豁免清单）。
         参数流式阶段（code 尚未到场——prep 占位 arguments 空，升级点在 delta-end）
         明示「程序体生成中」——此前该窗口只显示裸 spinner，观感即「代码面板被
         隐藏」（2026-09-21 前端反馈 #1）。 -->
    <div v-if="loading || (!summary && !errorText)" class="rc-running">
      <span class="tool-spin-ring rc-spin" aria-hidden="true"></span>
      <span class="rc-running-text">{{ code ? '程序执行中…（中间调用不回上下文，仅 return 值返回）' : '程序体生成中…（模型正在写代码/参数）' }}</span>
    </div>

    <!-- ============ ② 执行摘要（逐条子调用见紧随本卡的 subcall 平铺卡） ============ -->
    <div v-if="summary" class="rc-summary">
      <span v-for="b in badges" :key="b.text" class="ui-badge" :class="b.cls" :title="b.title">{{ b.text }}</span>
      <span v-if="deniedList.length" class="ui-badge err rc-badge-denied" :title="deniedList.map(d => `${d.name}: ${d.error}`).join('\n')">
        <Icon name="ban" :size="11" /> 被拒 {{ deniedList.length }}
      </span>
    </div>

    <!-- ============ ③ 返回值 / 错误 ============ -->
    <div v-if="errorText" class="rc-section rc-error">
      <div class="rc-error-title"><Icon name="alert-circle" :size="12" /> 程序失败</div>
      <pre class="rc-error-text"><code>{{ errorText }}</code></pre>
    </div>
    <div v-else-if="value !== undefined" class="rc-section rc-value" :class="{ 'rc-value-plain': valueIsPlain }">
      <div v-if="!valueIsPlain" class="rc-head">
        <span class="rc-head-label">return</span>
        <span v-if="valueIsLong && !valueExpanded" class="rc-meta-dim">已折叠（{{ valueText.length }} 字符）</span>
        <button v-if="valueIsLong" class="rc-expand-btn" @click="valueExpanded = !valueExpanded">
          {{ valueExpanded ? '收起' : `展开全部（${valueText.length} 字符）` }}
        </button>
      </div>
      <!-- 纯 string 返回值：普通文本直显（保留换行，无引号无转义）；其余：json 代码块 -->
      <div v-if="valueIsPlain && valueIsLong" class="rc-plain-fold">
        <span v-if="!valueExpanded" class="rc-meta-dim">已折叠（{{ valueText.length }} 字符）</span>
        <button class="rc-expand-btn" @click="valueExpanded = !valueExpanded">
          {{ valueExpanded ? '收起' : `展开全部（${valueText.length} 字符）` }}
        </button>
      </div>
      <ScrollableViewport v-if="valueIsPlain" class="rc-viewport">
        <pre class="rc-value-text"><code>{{ valueBody }}</code></pre>
      </ScrollableViewport>
      <ScrollableViewport v-else class="rc-viewport">
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
  background: var(--bg-surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}

/* ---- 头部条 ---- */
.rc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-inset);
  font-size: 11px;
  user-select: none;
}
.rc-head-label {
  font-weight: 600;
  color: var(--text-2);
  font-family: 'SF Mono', 'Consolas', monospace;
}
.rc-head-meta { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* cr-129 R3：语言徽记 = ui-badge kind（形状/配色归 kit 徽章族） */
.rc-lang-badge { font-weight: 600; }
.rc-meta-dim { color: var(--text-3); font-size: 10.5px; }
.rc-hash { font-family: 'SF Mono', 'Consolas', monospace; cursor: help; }

.rc-copy-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: all 0.15s;
  flex-shrink: 0;
}
.rc-copy-btn:hover { color: var(--text-1); background: var(--bg-hover); }
.rc-copy-btn.copied { color: var(--ok); }

/* 代码/值区横向滚动：markdown.css 的 pre overflow-x 规则不命中本上下文
   （全挂 .markdown-body 前缀），pre 默认 nowrap——卡根 .rc-section
   overflow:hidden 会硬裁长行；此处给滚动区（同 ToolResultCode 的
   .code-area-wrapper / ToolResultEdit 的 .edit-diff-body 同款处置） */
.rc-code-body,
.rc-value-body {
  overflow-x: auto;
}

/* 嵌套代码块按卡内规格覆盖（markdown.css 的 .md-code-block 系列全挂
   .markdown-body 前缀——工具卡在 .tool-body 内不命中；同处置见
   ToolResultCode）：banner 隐藏（卡头已有标题 + 复制按钮，
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
  gap: 8px;
  padding: 6px 12px;
  color: var(--text-3);
  font-size: 11.5px;
  user-select: none;
}
/* 琥珀旋转环（tool-spin-ring 形态复刻——scoped 环境下样式自持；类名
   复用使其进入 main.css prefers-reduced-motion 豁免选择器） */
.rc-running .rc-spin {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 2px solid var(--primary-border-soft);
  border-top-color: var(--primary);
  animation: rcSpin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes rcSpin { to { transform: rotate(360deg); } }
.rc-running-text { margin-left: 0; }

/* ---- 执行摘要徽章行 ---- */
/* cr-129 R3：汇总徽章 = ui-badge 族（ok/warn/dim/err；形状与配色归 kit，
   此处只留专属修饰） */
.rc-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 0;
}
.rc-badge-denied { cursor: help; }

/* ---- 错误 ---- */
.rc-error-title {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--err);
  font-size: 11.5px;
  font-weight: 600;
  padding: 6px 10px 0;
}
.rc-error-text {
  margin: 4px 10px 8px;
  color: var(--err);
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
  color: var(--primary-strong);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}
.rc-expand-btn:hover { background: var(--bg-hover); }

/* 纯 string 返回值：退掉卡内小卡框（扁平文本直显，与错误文本同规格） */
.rc-value-plain { border: none; background: transparent; }
.rc-plain-fold {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px 2px;
  font-size: 10.5px;
  user-select: none;
}
.rc-plain-fold .rc-expand-btn { margin-left: auto; padding: 1px 4px; }
.rc-value-text {
  margin: 0;
  padding: 6px 10px;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}

.rc-empty-return { border: none; background: transparent; padding: 0; }
</style>

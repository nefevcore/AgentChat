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
import { computed, ref } from 'vue';
import { useMarkdown } from 'ac-client-ui-renderer/client/useMarkdown.ts';
import ScrollableViewport from 'ac-client-ui-renderer/client/ScrollableViewport.vue';
import { Icon } from '@agentchat/webui-kit';
import { fenceOf } from 'ac-client-ui-renderer/client/codeFence.ts';
import CodeCard from 'ac-client-ui-renderer/client/CodeCard.vue';

const props = defineProps<{ data: Record<string, unknown>; loading?: boolean; errorText?: string }>();

const { render } = useMarkdown();

// ---- 程序体 ----
const code = computed(() => {
  const c = props.data.code;
  return typeof c === 'string' ? c : '';
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
/** 汇总徽章（cr-765 #10：拆两处下沉——调用计数/被拒进程序体卡头，
 *  computeMs 进 return 段卡头；中间独立徽章行整行删除） */
const callBadges = computed(() => {
  if (!summary.value) return [] as Array<{ text: string; cls: string; title?: string }>;
  const s = summary.value;
  const out: Array<{ text: string; cls: string; title?: string }> = [];
  out.push({ text: `调用 ${s.ok}/${s.calls}`, cls: s.failed > 0 ? 'warn' : 'ok', title: `子调用 ${s.ok} 成功 / ${s.failed} 失败` });
  if (s.serialized.length > 0) out.push({ text: `串行 ${s.serialized.length}`, cls: 'dim', title: '写路径/命令类按提交序串行执行' });
  return out;
});
/** return 段卡头 meta：机器耗时（含墙钟/冻结注记） */
const computeMsText = computed(() => {
  const s = summary.value;
  if (!s) return '';
  const freezeNote = s.frozenMs ? `，其中用户应答等待 ${s.frozenMs}ms 不计机器预算` : '';
  return `${s.computeMs}ms${freezeNote ? '（含冻结）' : ''}`;
});
const computeMsTitle = computed(() => {
  const s = summary.value;
  if (!s) return '';
  const freezeNote = s.frozenMs ? `，其中用户应答等待 ${s.frozenMs}ms 不计机器预算` : '';
  return `子调用累计 ${s.computeMs}ms（墙钟 ${s.wallMs}ms${freezeNote}）`;
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
// 反馈 #3：return 默认全量直出（折叠只是 CSS 截断、值本就全量在手——不折叠零数据成本，
// 渲染增量 = hljs 全量高亮 + DOM 节点，常规 KB 级可忽略）。50KB 极端护栏保留：
// MB 级 return 全量高亮会拖帧，此时折叠 + 手动展开。
const VALUE_CLIP = 50 * 1024;
const valueExpanded = ref(false);
const valueIsLong = computed(() => valueText.value.length > VALUE_CLIP);
const valueBody = computed(() =>
  valueExpanded.value || !valueIsLong.value ? valueText.value : valueText.value.slice(0, VALUE_CLIP),
);
/** 反馈 #4：字节量 KB 计量（UTF-8 字节数——比字符数贴近「文件大小」直觉） */
const valueSizeText = computed(() => {
  const bytes = new TextEncoder().encode(valueText.value).length;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
});
const renderedValue = computed(() => {
  if (valueBody.value === '' || valueIsPlain.value) return '';
  return render(`${fenceOf(valueBody.value)}json\n${valueBody.value}\n${fenceOf(valueBody.value)}`);
});

// ---- 错误（cr-765 A-1：errorText prop 统一通道——信封错误不在 data 里，
//      此前 data.error 恒空 = rc-error 分支死代码；保留 data.error 供 preview 形兜底） ----
const errorText = computed(() => {
  if (props.errorText) return props.errorText;
  const e = props.data.error;
  return typeof e === 'string' && e ? e : '';
});

</script>

<template>
  <div class="tool-result-run-code">
    <!-- 程序体缺席（历史行无 args 投影等）时调用徽章独立一行（cr-765 #10：
         徽章数据不因程序体缺席而丢失——被拒徽章是 denied 唯一前端可见面） -->
    <div v-if="!code && summary" class="rc-summary">
      <span v-for="b in callBadges" :key="b.text" class="ui-badge" :class="b.cls" :title="b.title">{{ b.text }}</span>
      <span v-if="deniedList.length" class="ui-badge err rc-badge-denied" :title="deniedList.map(d => `${d.name}: ${d.error}`).join('\n')">
        <Icon name="ban" :size="11" /> 被拒 {{ deniedList.length }}
      </span>
    </div>

    <!-- ============ ① 程序体（cr-765 #17A：CodeCard 统一形态） ============ -->
    <CodeCard v-if="code" class="rc-code-card" :code="code" lang="typescript" title="program.ts" :hash="programHash">
      <template #controls>
        <!-- cr-765 #10：调用徽章进卡头（被拒徽章是 denied 子调用唯一前端可见面，红色） -->
        <span v-if="summary" class="rc-head-badges">
          <span v-for="b in callBadges" :key="b.text" class="ui-badge" :class="b.cls" :title="b.title">{{ b.text }}</span>
          <span v-if="deniedList.length" class="ui-badge err rc-badge-denied" :title="deniedList.map(d => `${d.name}: ${d.error}`).join('\n')">
            <Icon name="ban" :size="11" /> 被拒 {{ deniedList.length }}
          </span>
        </span>
      </template>
    </CodeCard>

    <!-- 执行中（无摘要返回时）：琥珀旋转环——2026-09-18 全前端"忙"指示统一
         （tool-spin-ring 同款；类名复用以进 prefers-reduced-motion 豁免清单）。
         参数流式阶段（code 尚未到场——prep 占位 arguments 空，升级点在 delta-end）
         明示「程序体生成中」——此前该窗口只显示裸 spinner，观感即「代码面板被
         隐藏」（2026-09-21 前端反馈 #1）。 -->
    <div v-if="loading || (!summary && !errorText)" class="rc-running">
      <span class="tool-spin-ring rc-spin" aria-hidden="true"></span>
      <span class="rc-running-text">{{ code ? '程序执行中…（中间调用不回上下文，仅 return 值返回）' : '程序体生成中…（模型正在写代码/参数）' }}</span>
    </div>

    <!-- cr-765 #10：独立徽章行删除——调用计数/被拒在程序体卡头，
         computeMs 在 return 段卡头；逐条子调用见紧随本卡的 subcall 平铺卡 -->

    <!-- ============ ③ return 区（cr-765 #11：统一容器——失败是该容器的
         状态而非另一块；容器头 return + 状态徽章，体 = 值或错误文本） ============ -->
    <div v-if="errorText" class="rc-section rc-error">
      <div class="rc-head">
        <span class="rc-head-label">return</span>
        <span class="ui-badge err">失败</span>
        <span v-if="computeMsText" class="rc-meta-dim" :title="computeMsTitle">{{ computeMsText }}</span>
      </div>
      <pre class="rc-error-text"><code>{{ errorText }}</code></pre>
      <!-- 抛错但有部分返回值：并入「部分返回值」小节 -->
      <div v-if="value !== undefined" class="rc-partial">
        <div class="rc-head"><span class="rc-head-label">部分返回值</span></div>
        <ScrollableViewport class="rc-viewport">
          <div v-if="valueIsPlain" class="rc-value-text"><code>{{ valueText }}</code></div>
          <div v-else class="rc-value-body" v-html="renderedValue" />
        </ScrollableViewport>
      </div>
    </div>
    <div v-else-if="value !== undefined" class="rc-section rc-value" :class="{ 'rc-value-plain': valueIsPlain }">
      <div v-if="!valueIsPlain" class="rc-head">
        <span class="rc-head-label">return</span>
        <span v-if="computeMsText" class="rc-meta-dim" :title="computeMsTitle">{{ computeMsText }}</span>
        <span v-if="valueSizeText" class="rc-meta-dim">{{ valueSizeText }}</span>
        <span v-if="valueIsLong && !valueExpanded" class="rc-meta-dim">已折叠（护栏 {{ valueSizeText }}）</span>
        <button v-if="valueIsLong" class="rc-expand-btn" @click="valueExpanded = !valueExpanded">
          {{ valueExpanded ? '收起' : `展开全部（${valueText.length} 字符）` }}
        </button>
      </div>
      <!-- 纯 string 返回值：普通文本直显（保留换行，无引号无转义）；其余：json 代码块 -->
      <div v-if="valueIsPlain && valueIsLong" class="rc-plain-fold">
        <span v-if="!valueExpanded" class="rc-meta-dim">已折叠（护栏 {{ valueSizeText }}）</span>
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
/* CodeCard 程序段（#17A）：与 rc-section 同视觉位 */
.rc-code-card { min-width: 0; }

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
/* 调用徽章区（#10 下沉）：卡头 meta 与复制钮之间 */
.rc-head-badges { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; flex-shrink: 0; }
/* 抛错 + 部分返回值小节（#11） */
.rc-partial { border-top: 1px solid var(--line); }
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

/* 徽章独立行（程序体缺席分支；cr-129 R3：徽章 = ui-badge 族） */
.rc-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 0;
}
.rc-badge-denied { cursor: help; }

/* ---- 错误（#11：return 容器状态——rc-error-title 退役，rc-head 承载） ---- */
.rc-error-text {
  margin: 6px 10px 8px;
  color: var(--err);
  font-family: 'SF Mono', 'Consolas', monospace;
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: var(--card-viewport-max);
  overflow-y: auto;
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
  max-height: var(--card-viewport-max);
  overflow-y: auto;
}

.rc-empty-return { border: none; background: transparent; padding: 0; }
</style>

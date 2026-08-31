<!-- ToolResultBrowser.vue —— browser 工具结果展示
     支持：
       - 单动作：open / content / screenshot / click / type / press / eval / html / close
       - 批量：steps 模式 {status, count, results:[{step, action, repeat, params, result}]}
       - 错误：{status:'error', message, results?}（批量部分成功也完整展示）
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { fetchWorkspaceFile } from '../../../api/files';

const props = defineProps<{ data: Record<string, unknown>; loading?: boolean }>();

// ── 批量模式识别：results 数组且首项含 action（区别于 web_search 的 results）──
const isBatch = computed(() => {
  const arr = props.data.results;
  return Array.isArray(arr) && arr.length > 0 && !!(arr[0] as any)?.action;
});

const batchItems = computed<any[]>(() => (isBatch.value ? (props.data.results as any[]) : []));
const batchOk = computed(() => batchItems.value.filter((i) => !isStepErr(i)).length);
const batchErr = computed(() => batchItems.value.length - batchOk.value);
const errorMessage = computed(() => String(props.data.message || props.data.error || ''));
const failedStep = computed(() => Number(props.data.failedStep ?? 0));

// ── 单动作数据 ──
const url = computed(() => String(props.data.url || ''));
const title = computed(() => String(props.data.title || ''));
const text = computed(() => String(props.data.text || ''));
const file = computed(() => String(props.data.file || ''));
const relPath = computed(() => String(props.data.relPath || ''));
const evalResult = computed(() => (props.data.result != null ? String(props.data.result) : ''));
const htmlLength = computed(() => Number(props.data.html_length ?? 0));

const singleType = computed<'screenshot' | 'page' | 'eval' | 'html' | 'ok'>(() => {
  if (relPath.value || file.value) return 'screenshot';
  if (url.value || text.value) return 'page';
  if (evalResult.value) return 'eval';
  if (htmlLength.value > 0) return 'html';
  return 'ok';
});

// ── action 元信息 ──
const ACTION_META: Record<string, { icon: string; label: string; color: string }> = {
  open: { icon: '🔗', label: '打开', color: '#3b82f6' },
  click: { icon: '🖱️', label: '点击', color: '#8b5cf6' },
  type: { icon: '⌨️', label: '输入', color: '#06b6d4' },
  press: { icon: '⏎', label: '按键', color: '#06b6d4' },
  content: { icon: '📄', label: '提取内容', color: '#22c55e' },
  screenshot: { icon: '🖼️', label: '截图', color: '#f59e0b' },
  html: { icon: '🌐', label: 'HTML', color: '#f97316' },
  eval: { icon: '⚡', label: '执行 JS', color: '#ef4444' },
  close: { icon: '🚪', label: '关闭', color: '#6b7280' },
};
function actionMeta(action: string) {
  return ACTION_META[action] || { icon: '🔧', label: action, color: '#6b7280' };
}

function isStepErr(item: any): boolean {
  return item.status === 'error' || item.result?.status === 'error';
}

/** 步骤摘要文本（参数 + 结果要点） */
function stepSummary(item: any): string {
  if (isStepErr(item)) return String(item.message || item.result?.message || '执行失败');
  const p = item.params || {};
  const r = item.result || {};
  switch (item.action) {
    case 'open':
      return r.url || p.url || '';
    case 'content':
      return (r.text || '').slice(0, 200) + ((r.text || '').length > 200 ? '…' : '');
    case 'screenshot':
      return r.relPath || r.file || p.name || '';
    case 'click':
      return p.selector ? `选择器: ${p.selector}` : 'OK';
    case 'type':
      return `${p.selector || ''}${p.text ? ` → "${String(p.text).slice(0, 50)}"` : ''}`;
    case 'press':
      return p.key ? `按键: ${p.key}` : 'OK';
    case 'eval':
      return String(r.result ?? '').slice(0, 200);
    case 'html':
      return r.html_length != null ? `${r.html_length} 字符` : 'OK';
    case 'close':
      return '';
    default:
      return r.status === 'ok' ? 'OK' : '';
  }
}

/** 步骤完整内容（用于展开显示） */
function stepDetail(item: any): string {
  const r = item.result || {};
  if (isStepErr(item)) return String(item.message || r.message || '');
  if (item.action === 'content' && r.text) return r.text;
  return JSON.stringify(r, null, 2);
}

function hasDetail(item: any): boolean {
  if (item.action === 'content') return !!(item.result?.text && String(item.result.text).length > 200);
  if (item.action === 'eval') return !!(item.result?.result && String(item.result.result).length > 80);
  return false;
}

/** 仅放行 http(s)：浏览器工具产出的 URL 来自外部页面（不可信），
 *  javascript:/data: 协议注入 :href 会在点击时执行脚本。 */
function safeUrl(u: unknown): string {
  const s = String(u ?? '');
  return /^https?:\/\//i.test(s) ? s : '#';
}

// ── 展开控制 ──
const textExpanded = ref(false);
const expandedSteps = ref<Record<number, boolean>>({});
function toggleStep(i: number) {
  expandedSteps.value[i] = !expandedSteps.value[i];
}

// ── 截图预览（单动作）：/api/workspace/file 加载 base64 ──
const screenshotSrc = ref('');
const screenshotLoading = ref(false);
const screenshotError = ref('');
async function loadScreenshot() {
  if (!relPath.value || screenshotSrc.value || screenshotLoading.value) return;
  screenshotLoading.value = true;
  screenshotError.value = '';
  try {
    const j = await fetchWorkspaceFile(relPath.value);
    if (j.base64) {
      screenshotSrc.value = 'data:' + (j.contentType || 'image/png') + ';base64,' + j.content;
    } else if (j.error) {
      screenshotError.value = String(j.error);
    } else {
      screenshotError.value = '无法加载截图';
    }
  } catch (e: any) {
    screenshotError.value = String(e.message || e);
  } finally {
    screenshotLoading.value = false;
  }
}

const displayUrl = computed(() => {
  const u = url.value;
  if (!u) return '';
  return u.replace(/^https?:\/\//, '').length > 60 ? u.replace(/^https?:\/\//, '').slice(0, 60) + '…' : u.replace(/^https?:\/\//, '');
});
</script>

<template>
  <div class="tool-result-browser">
    <!-- ════════ 批量模式 ════════ -->
    <template v-if="isBatch">
      <div class="brw-batch-header">
        <span class="brw-batch-count">{{ batchItems.length }} 步</span>
        <span v-if="batchOk" class="brw-batch-ok">✓ {{ batchOk }}</span>
        <span v-if="batchErr" class="brw-batch-err">✗ {{ batchErr }}</span>
        <span v-if="failedStep" class="brw-batch-failed">第 {{ failedStep }} 步失败</span>
      </div>

      <div v-if="errorMessage" class="brw-error">{{ errorMessage }}</div>

      <div class="brw-steps">
        <div
          v-for="(item, idx) in batchItems"
          :key="idx"
          class="brw-step"
          :class="{ 'brw-step-err': isStepErr(item) }"
        >
          <span class="brw-step-badge" :style="{ color: actionMeta(item.action).color, background: actionMeta(item.action).color + '1a' }">
            {{ actionMeta(item.action).icon }} {{ actionMeta(item.action).label }}
          </span>
          <span class="brw-step-no">#{{ item.step }}<template v-if="item.repeat > 1">.{{ item.repeat }}</template></span>
          <span class="brw-step-status" :class="{ 'st-err': isStepErr(item) }">{{ isStepErr(item) ? '✗' : '✓' }}</span>

          <div class="brw-step-body">
            <div v-if="item.action === 'open' && item.result?.url" class="brw-step-open">
              <a :href="safeUrl(item.result.url)" target="_blank" rel="noopener">{{ item.result.url }}</a>
            </div>
            <div v-else-if="item.action === 'screenshot' && (item.result?.relPath || item.result?.file)" class="brw-step-file">
              📷 {{ item.result?.relPath || item.result?.file }}
            </div>
            <div v-else class="brw-step-summary">{{ stepSummary(item) }}</div>

            <!-- 可展开详情 -->
            <button
              v-if="hasDetail(item)"
              class="brw-expand-btn"
              @click="toggleStep(idx)"
            >
              {{ expandedSteps[idx] ? '收起' : '展开' }}
            </button>
            <pre v-if="expandedSteps[idx] && hasDetail(item)" class="brw-detail"><code>{{ stepDetail(item) }}</code></pre>
          </div>
        </div>
      </div>
    </template>

    <!-- ════════ 单动作：截图 ════════ -->
    <div v-else-if="singleType === 'screenshot'" class="brw-screenshot">
      <div class="brw-screenshot-meta">
        <span class="brw-badge">🖼️ 截图</span>
        <span class="brw-file-path">{{ relPath || file }}</span>
      </div>
      <template v-if="screenshotSrc">
        <img :src="screenshotSrc" class="brw-shot-img" alt="browser 截图" />
      </template>
      <template v-else-if="screenshotError">
        <div class="brw-error">{{ screenshotError }}</div>
      </template>
      <button v-else class="brw-expand-btn" @click="loadScreenshot">
        {{ screenshotLoading ? '加载中...' : '预览截图' }}
      </button>
    </div>

    <!-- ════════ 单动作：页面内容 ════════ -->
    <div v-else-if="singleType === 'page'" class="brw-page">
      <a v-if="url" :href="safeUrl(url)" target="_blank" rel="noopener" class="brw-page-url" :title="url">
        🔗 {{ displayUrl }}
      </a>
      <div v-if="title" class="brw-page-title">{{ title }}</div>
      <template v-if="text">
        <pre class="brw-text" :class="{ 'brw-text-expanded': textExpanded }"><code>{{ text }}</code></pre>
        <button v-if="text.length > 300" class="brw-expand-btn" @click="textExpanded = !textExpanded">
          {{ textExpanded ? '收起' : '展开全文' }}
        </button>
      </template>
    </div>

    <!-- ════════ 单动作：eval / html / 其他 ════════ -->
    <div v-else-if="singleType === 'eval'" class="brw-eval">
      <span class="brw-badge">⚡ 执行结果</span>
      <pre class="brw-text brw-text-expanded"><code>{{ evalResult }}</code></pre>
    </div>
    <div v-else-if="singleType === 'html'" class="brw-eval">
      <span class="brw-badge">🌐 HTML</span>
      <div class="brw-html-meta">{{ htmlLength }} 字符</div>
    </div>
    <div v-else class="brw-ok">
      <span class="brw-badge brw-badge-ok">✓ 完成</span>
    </div>
  </div>
</template>

<style scoped>
.tool-result-browser { padding: 2px 0; font-size: 12px; }

/* ── 批量 ── */
.brw-batch-header {
  display: flex; align-items: center; gap: 10px;
  font-size: 12px; margin-bottom: 6px; flex-wrap: wrap;
}
.brw-batch-count { font-weight: 600; color: var(--color-text-primary); }
.brw-batch-ok { color: #22c55e; }
.brw-batch-err { color: #ef4444; }
.brw-batch-failed { color: #f59e0b; font-weight: 600; }

.brw-error {
  color: var(--color-error, #e74c3c); font-size: 12px; margin: 2px 0 6px;
  white-space: pre-wrap; word-break: break-word;
  background: color-mix(in srgb, var(--color-error, #e74c3c) 10%, transparent); border-radius: 6px; padding: 6px 10px;
}

.brw-steps { display: flex; flex-direction: column; gap: 4px; }

.brw-step {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 5px 8px; border-radius: 6px;
  background: var(--color-bg-surface, #f8f8f8);
  border: 1px solid var(--color-border-light, #e5e7eb);
  flex-wrap: wrap;
}
.brw-step-err { border-color: #ef444466; background: #ef44440d; }

.brw-step-badge {
  font-size: 11px; font-weight: 600;
  padding: 1px 8px; border-radius: 10px;
  white-space: nowrap; flex-shrink: 0;
}
.brw-step-no { font-size: 11px; color: var(--color-text-tertiary); font-family: monospace; flex-shrink: 0; }
.brw-step-status { font-size: 12px; font-weight: 700; color: #22c55e; flex-shrink: 0; }
.brw-step-status.st-err { color: #ef4444; }

.brw-step-body { flex: 1; min-width: 160px; }
.brw-step-summary {
  font-size: 12px; color: var(--color-text-secondary);
  white-space: pre-wrap; word-break: break-word; line-height: 1.5;
}
.brw-step-open a {
  color: var(--color-link, #3b82f6); font-size: 12px;
  word-break: break-all; text-decoration: none;
}
.brw-step-open a:hover { text-decoration: underline; }
.brw-step-file { font-size: 11px; color: var(--color-text-tertiary); font-family: monospace; word-break: break-all; }

.brw-expand-btn {
  background: none; border: none; color: var(--color-link, #3b82f6);
  font-size: 11px; cursor: pointer; padding: 1px 0; margin-top: 2px;
}
.brw-detail {
  margin: 4px 0 0; font-size: 11px; line-height: 1.5;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  color: var(--color-text-secondary); white-space: pre-wrap; word-break: break-word;
  max-height: 160px; overflow: auto; background: var(--color-bg-surface, #f8f8f8);
  padding: 6px 8px; border-radius: 4px;
}
.brw-detail code { font-family: inherit; color: inherit; }

/* ── 单动作：截图 ── */
.brw-screenshot { display: flex; flex-direction: column; gap: 6px; }
.brw-screenshot-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.brw-file-path { font-size: 11px; color: var(--color-text-tertiary); font-family: monospace; word-break: break-all; }
.brw-shot-img {
  max-width: 100%; max-height: 320px; border-radius: 8px;
  border: 1px solid var(--color-border-light, #e5e7eb); cursor: zoom-in;
}
.brw-shot-img:hover { max-height: none; }

/* ── 单动作：页面 ── */
.brw-page { display: flex; flex-direction: column; gap: 4px; }
.brw-page-url {
  color: var(--color-link, #3b82f6); font-size: 12px; text-decoration: none;
  word-break: break-all;
}
.brw-page-url:hover { text-decoration: underline; }
.brw-page-title { font-size: 12px; font-weight: 600; color: var(--color-text-primary); }
.brw-text {
  margin: 0; font-size: 12px; line-height: 1.6;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  color: var(--color-text-secondary); white-space: pre-wrap; word-break: break-word;
  max-height: 200px; overflow: hidden;
}
.brw-text-expanded { max-height: none; }
.brw-text code { font-family: inherit; color: inherit; }

/* ── 单动作：其他 ── */
.brw-badge {
  font-size: 11px; font-weight: 600; color: var(--color-text-secondary);
  background: var(--color-bg-surface, #f8f8f8); padding: 1px 8px; border-radius: 10px;
  display: inline-flex; align-items: center; gap: 4px;
}
.brw-badge-ok { color: #22c55e; }
.brw-html-meta { font-size: 12px; color: var(--color-text-tertiary); margin-top: 4px; }
.brw-eval { display: flex; flex-direction: column; gap: 4px; }
.brw-ok { padding: 2px 0; }
</style>

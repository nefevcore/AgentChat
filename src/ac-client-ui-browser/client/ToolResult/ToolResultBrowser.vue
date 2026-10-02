<!-- ToolResultBrowser.vue —— browser 工具结果展示
     支持：
       - 单动作：open / content / screenshot / click / type / press / eval / html / close
       - 批量：steps 模式 {status, count, results:[{step, action, repeat, params, result}]}
       - 错误：{status:'error', message, results?}（批量部分成功也完整展示）
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { fetchWorkspaceFile } from 'ac-client-ui-workspace/client/workspaceFile.ts';
import { Icon } from '@agentchat/webui-kit';

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

const elements = computed<string[]>(() => Array.isArray(props.data.elements) ? (props.data.elements as string[]) : []);
const consoleLogs = computed<Array<{ seq: number; level?: string; text: string }>>(() => Array.isArray(props.data.console) ? (props.data.console as Array<{ seq: number; level?: string; text: string }>) : []);
const netLogs = computed<Array<{ seq: number; method?: string; url: string; status?: number; state?: string; error?: string }>>(() => Array.isArray(props.data.network) ? (props.data.network as Array<{ seq: number; method?: string; url: string; status?: number; state?: string; error?: string }>) : []);
const tabsList = computed<Array<{ index: number; title: string; url: string; active?: boolean }>>(() => Array.isArray(props.data.tabs) ? (props.data.tabs as Array<{ index: number; title: string; url: string; active?: boolean }>) : []);
const logTab = ref<'console' | 'network'>('console');

const singleType = computed<'screenshot' | 'page' | 'eval' | 'html' | 'elements' | 'logs' | 'tabs' | 'ok'>(() => {
  if (relPath.value || file.value) return 'screenshot';
  if (elements.value.length > 0) return 'elements';
  if (consoleLogs.value.length > 0 || netLogs.value.length > 0) return 'logs';
  if (tabsList.value.length > 0) return 'tabs';
  if (url.value || text.value) return 'page';
  if (evalResult.value) return 'eval';
  if (htmlLength.value > 0) return 'html';
  return 'ok';
});

// ── action 元信息（icon = lucide 图标名，经 ui/Icon 渲染——不用符号文本） ──
// 色板口径（cr-128）：本表是「动作类型分类色板」（每动作一色 = 类型标识，非状态语义），
// 按 R1 例外保持独立色板——不把 --ok/--warn/--err 语义色拉进分类板；徽章形态归 kit
// .ui-badge.tag，色相经 --tag-hue / --tag-hue-rgb 内联注入（tagHueRgb 派生）。
const ACTION_META: Partial<Record<string, { icon: string; label: string; color: string }>> = {
  open: { icon: 'external-link', label: '打开', color: '#3b82f6' },
  read: { icon: 'book-open', label: '读正文', color: '#22c55e' },
  elements: { icon: 'list', label: '元素索引', color: '#0ea5e9' },
  click: { icon: 'mouse-pointer-click', label: '点击', color: '#8b5cf6' },
  hover: { icon: 'mouse-pointer-2', label: '悬停', color: '#8b5cf6' },
  type: { icon: 'keyboard', label: '输入', color: '#06b6d4' },
  press: { icon: 'corner-down-left', label: '按键', color: '#06b6d4' },
  scroll: { icon: 'arrow-down', label: '滚动', color: '#94a3b8' },
  wait: { icon: 'clock', label: '等待', color: '#94a3b8' },
  logs: { icon: 'scroll-text', label: '日志', color: '#f59e0b' },
  response_body: { icon: 'file-json', label: '响应体', color: '#f97316' },
  tabs: { icon: 'app-window', label: '标签页', color: '#64748b' },
  content: { icon: 'file-text', label: '提取内容', color: '#22c55e' },
  screenshot: { icon: 'image', label: '截图', color: '#f59e0b' },
  html: { icon: 'globe', label: 'HTML', color: '#f97316' },
  eval: { icon: 'zap', label: '执行 JS', color: '#ef4444' },
  close: { icon: 'x', label: '关闭', color: '#6b7280' },
};
function actionMeta(action: string) {
  // 未登记动作 = 分类板中性灰（同属独立分类色板）
  return ACTION_META[action] ?? { icon: 'wrench', label: action, color: '#6b7280' };
}

/** 分类色 → 标签徽章色相三元组（badge.css .ui-badge.tag 消费 --tag-hue-rgb："r, g, b"）。
 *  分类色板单源仍是 ACTION_META 的 hex——此处只派生三元组，不新增色值。 */
function tagHueRgb(hex: string): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255);
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
    case 'hover':
      return p.ref ? `ref #${p.ref}` : (p.selector ? `选择器: ${p.selector}` : 'OK');
    case 'type':
      return `${p.selector || ''}${p.text ? ` → "${String(p.text).slice(0, 50)}"` : ''}`;
    case 'press':
      return p.key ? `按键: ${p.key}` : 'OK';
    case 'eval':
      return String(r.result ?? '').slice(0, 200);
    case 'html':
      return r.html_length != null ? `${r.html_length} 字符` : 'OK';
    case 'read':
      return (r.text || '').slice(0, 200) + ((r.text || '').length > 200 ? '…' : '');
    case 'elements':
      return r.count != null ? `${r.count} 个可交互元素` : 'OK';
    case 'logs':
      return `${(r.console || []).length} 条日志 / ${(r.network || []).length} 个请求`;
    case 'tabs':
      return `${(r.tabs || []).length} 个标签页`;
    case 'scroll':
      return r.scrollY != null ? `scrollY ${r.scrollY}` : 'OK';
    case 'wait':
      return r.found === true ? `等到文本「${p.text}」` : (p.ms ? `${p.ms}ms` : 'OK');
    case 'response_body':
      return (r.body || '').slice(0, 120);
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
  if ((item.action === 'content' || item.action === 'read') && r.text) return r.text;
  if (item.action === 'elements' && Array.isArray(r.elements)) return r.elements.join('\n');
  if (item.action === 'logs') {
    const c = (r.console || []).map((e: any) => `[${e.level}] ${e.text}`).join('\n');
    const n = (r.network || []).map((e: any) => `[${e.state}] ${e.method || ''} ${e.url}${e.error ? ` — ${e.error}` : ''}`).join('\n');
    return [c, n].filter(Boolean).join('\n');
  }
  if (item.action === 'response_body' && r.body) return r.body;
  return JSON.stringify(r, null, 2);
}

function hasDetail(item: any): boolean {
  if (item.action === 'content' || item.action === 'read') return !!(item.result?.text && String(item.result.text).length > 200);
  if (item.action === 'eval') return !!(item.result?.result && String(item.result.result).length > 80);
  if (item.action === 'elements') return (item.result?.elements || []).length > 0;
  if (item.action === 'logs') return !!((item.result?.console || []).length || (item.result?.network || []).length);
  if (item.action === 'response_body') return !!item.result?.body;
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
        <span v-if="batchOk" class="brw-batch-ok"><Icon name="check" :size="11" /> {{ batchOk }}</span>
        <span v-if="batchErr" class="brw-batch-err"><Icon name="x" :size="11" /> {{ batchErr }}</span>
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
          <span class="ui-badge tag brw-step-badge" :style="{ '--tag-hue': actionMeta(item.action).color, '--tag-hue-rgb': tagHueRgb(actionMeta(item.action).color) }">
            <Icon :name="actionMeta(item.action).icon" :size="11" /> {{ actionMeta(item.action).label }}
          </span>
          <span class="brw-step-no">#{{ item.step }}<template v-if="item.repeat > 1">.{{ item.repeat }}</template></span>
          <span class="brw-step-status" :class="{ 'st-err': isStepErr(item) }"><Icon :name="isStepErr(item) ? 'x' : 'check'" :size="11" /></span>

          <div class="brw-step-body">
            <div v-if="item.action === 'open' && item.result?.url" class="brw-step-open">
              <a :href="safeUrl(item.result.url)" target="_blank" rel="noopener">{{ item.result.url }}</a>
            </div>
            <div v-else-if="item.action === 'screenshot' && (item.result?.relPath || item.result?.file)" class="brw-step-file">
              <Icon name="image" :size="12" class="brw-step-file-icon" />{{ item.result?.relPath || item.result?.file }}
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
        <span class="ui-badge dim"><Icon name="image" :size="11" />截图</span>
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

    <!-- ════════ 单动作：元素索引 ════════ -->
    <div v-else-if="singleType === 'elements'" class="brw-elements">
      <span class="ui-badge dim"><Icon name="list" :size="11" />可交互元素 × {{ elements.length }}</span>
      <pre class="brw-text brw-text-expanded"><code>{{ elements.join('\n') }}</code></pre>
    </div>

    <!-- ════════ 单动作：日志（console/network 分栏）════════ -->
    <div v-else-if="singleType === 'logs'" class="brw-logs">
      <div class="brw-logs-tabs">
        <button class="brw-log-tab" :class="{ active: logTab === 'console' }" @click="logTab = 'console'">控制台 {{ consoleLogs.length }}</button>
        <button class="brw-log-tab" :class="{ active: logTab === 'network' }" @click="logTab = 'network'">网络 {{ netLogs.length }}</button>
      </div>
      <div v-if="logTab === 'console'" class="brw-log-list">
        <div v-for="e in consoleLogs" :key="e.seq" class="brw-log-row" :class="'lv-' + (e.level || 'info')">
          <span class="brw-log-level">{{ e.level || 'info' }}</span>
          <span class="brw-log-text">{{ e.text }}</span>
        </div>
        <div v-if="!consoleLogs.length" class="brw-empty-hint">无控制台日志</div>
      </div>
      <div v-else class="brw-log-list">
        <div v-for="e in netLogs" :key="e.seq" class="brw-log-row" :class="e.state === 'failed' ? 'lv-error' : 'lv-info'">
          <span class="brw-log-status" :class="{ err: e.state === 'failed' || (e.status && e.status >= 400) }">{{ e.status ?? (e.state === 'failed' ? '✕' : '…') }}</span>
          <span class="brw-log-text">{{ (e.method || 'GET') + ' ' + e.url }}<template v-if="e.error"> — {{ e.error }}</template></span>
        </div>
        <div v-if="!netLogs.length" class="brw-empty-hint">无网络请求</div>
      </div>
    </div>

    <!-- ════════ 单动作：标签页 ════════ -->
    <div v-else-if="singleType === 'tabs'" class="brw-tabs">
      <div v-for="t in tabsList" :key="t.index" class="brw-tab-row" :class="{ active: t.active }">
        <Icon :name="t.active ? 'circle-dot' : 'circle'" :size="11" />
        <span class="brw-tab-title">{{ t.title || '(无标题)' }}</span>
        <span class="brw-tab-url">{{ t.url }}</span>
      </div>
    </div>

    <!-- ════════ 单动作：页面内容 ════════ -->
    <div v-else-if="singleType === 'page'" class="brw-page">
      <a v-if="url" :href="safeUrl(url)" target="_blank" rel="noopener" class="brw-page-url" :title="url">
        <Icon name="link" :size="12" class="brw-page-url-icon" />{{ displayUrl }}
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
      <span class="ui-badge dim"><Icon name="zap" :size="11" />执行结果</span>
      <pre class="brw-text brw-text-expanded"><code>{{ evalResult }}</code></pre>
    </div>
    <div v-else-if="singleType === 'html'" class="brw-eval">
      <span class="ui-badge dim"><Icon name="globe" :size="11" />HTML</span>
      <div class="brw-html-meta">{{ htmlLength }} 字符</div>
    </div>
    <div v-else class="brw-ok">
      <span class="ui-badge ok"><Icon name="check" :size="11" /> 完成</span>
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
.brw-batch-count { font-weight: 600; color: var(--text-1); }
/* 批量汇总计数（图标 + 数字，数字是文字）→ 墨色档；单独字形走图形档，见 .brw-step-status */
.brw-batch-ok { color: var(--ok); display: inline-flex; align-items: center; gap: 3px; }
.brw-batch-err { color: var(--err); display: inline-flex; align-items: center; gap: 3px; }
.brw-batch-failed { color: var(--warn); font-weight: 600; }

.brw-error {
  color: var(--err); font-size: 12px; margin: 2px 0 6px;
  white-space: pre-wrap; word-break: break-word;
  /* cr-131（P7）：legacy 别名 --color-error-rgb 归本源三元组（定义 = var(--err-rgb)，视觉零差）——
     原保活引用退役，别名条目随死条剪除（css-color-tokens 测试③）；已删硬编码回退 231,76,60（R1 铁律不留 hex） */
  background: rgba(var(--err-rgb), 0.1); border-radius: 6px; padding: 6px 10px;
}

.brw-steps { display: flex; flex-direction: column; gap: 4px; }

/* 步骤行 = 工具结果卡内的内容步骤区（保留盒装形态：R4 的「设置域清单行」口径，
   见 cr-128 报告待裁决），色值全令牌化 */
.brw-step {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 5px 8px; border-radius: 6px;
  background: var(--bg-surface);
  border: 1px solid var(--line);
  flex-wrap: wrap;
}
.brw-step-err { border-color: rgba(var(--err-rgb), 0.4); background: rgba(var(--err-rgb), 0.05); }

/* .brw-step-badge 自建徽章样式已退役（cr-128）：动作类型徽记归 kit .ui-badge.tag
   （色相经 --tag-hue / --tag-hue-rgb 内联注入，形状与配色单源 badge.css） */
.brw-step-no { font-size: 11px; color: var(--text-3); font-family: monospace; flex-shrink: 0; }
/* 步骤状态字形（纯图形件、无文字）→ 图形档（cr-123 · 3.0 线；同 StatusDot 口径） */
.brw-step-status { font-weight: 700; color: var(--ok-graphic); flex-shrink: 0; display: inline-flex; align-items: center; }
.brw-step-status.st-err { color: var(--err-graphic); }

.brw-step-body { flex: 1; min-width: 160px; }
.brw-step-summary {
  font-size: 12px; color: var(--text-2);
  white-space: pre-wrap; word-break: break-word; line-height: 1.5;
}
.brw-step-open a {
  color: var(--primary-strong); font-size: 12px;
  word-break: break-all; text-decoration: none;
}
.brw-step-open a:hover { text-decoration: underline; }
.brw-step-file { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-3); font-family: monospace; word-break: break-all; }
.brw-step-file-icon { flex-shrink: 0; }

.brw-expand-btn {
  background: none; border: none; color: var(--primary-strong);
  font-size: 11px; cursor: pointer; padding: 1px 0; margin-top: 2px;
}
.brw-detail {
  margin: 4px 0 0; font-size: 11px; line-height: 1.5;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  color: var(--text-2); white-space: pre-wrap; word-break: break-word;
  max-height: 160px; overflow: auto; background: var(--bg-surface);
  padding: 6px 8px; border-radius: 4px;
}
.brw-detail code { font-family: inherit; color: inherit; }

/* ── 单动作：截图 ── */
.brw-screenshot { display: flex; flex-direction: column; gap: 6px; }
.brw-screenshot-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.brw-file-path { font-size: 11px; color: var(--text-3); font-family: monospace; word-break: break-all; }
.brw-shot-img {
  max-width: 100%; max-height: 320px; border-radius: 8px;
  border: 1px solid var(--line); cursor: zoom-in;
}
.brw-shot-img:hover { max-height: none; }

/* ── 单动作：页面 ── */
.brw-page { display: flex; flex-direction: column; gap: 4px; }
.brw-page-url {
  display: inline-flex; align-items: center; gap: 4px;
  color: var(--primary-strong); font-size: 12px; text-decoration: none;
  word-break: break-all;
}
.brw-page-url-icon { flex-shrink: 0; }
.brw-page-url:hover { text-decoration: underline; }
.brw-page-title { font-size: 12px; font-weight: 600; color: var(--text-1); }
.brw-text {
  margin: 0; font-size: 12px; line-height: 1.6;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  color: var(--text-2); white-space: pre-wrap; word-break: break-word;
  max-height: 200px; overflow: hidden;
}
.brw-text-expanded { max-height: none; }
.brw-text code { font-family: inherit; color: inherit; }

/* ── 单动作：元素索引/日志/标签页 ── */
.brw-elements { display: flex; flex-direction: column; gap: 6px; }
.brw-logs { display: flex; flex-direction: column; gap: 6px; }
.brw-logs-tabs { display: flex; gap: 4px; }
.brw-log-tab {
  background: none; border: 1px solid var(--line); border-radius: 6px;
  color: var(--text-3); font-size: 11px; padding: 2px 10px; cursor: pointer;
}
.brw-log-tab.active { color: var(--primary-strong); border-color: var(--primary-strong); }
.brw-log-list { display: flex; flex-direction: column; gap: 2px; max-height: 240px; overflow: auto; }
.brw-log-row { display: flex; gap: 6px; font-size: 11px; align-items: baseline; }
.brw-log-level, .brw-log-status { flex-shrink: 0; font-family: monospace; color: var(--text-3); min-width: 34px; }
/* 日志级别/状态码是文字（error / 404 / failed）→ 墨色档 */
.brw-log-row.lv-error .brw-log-level, .brw-log-row.lv-error .brw-log-status { color: var(--err); }
.brw-log-row.lv-warning .brw-log-level { color: var(--warn); }
.brw-log-status.err { color: var(--err); font-weight: 700; }
.brw-log-text { color: var(--text-2); word-break: break-all; }
.brw-empty-hint { font-size: 11px; color: var(--text-3); padding: 4px 0; }
.brw-tabs { display: flex; flex-direction: column; gap: 4px; }
.brw-tab-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); padding: 2px 0; }
.brw-tab-row.active .brw-tab-title { color: var(--text-1); font-weight: 600; }
.brw-tab-row svg { flex-shrink: 0; color: var(--text-3); }
.brw-tab-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
.brw-tab-url { font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── 单动作：其他 ── */
/* .brw-badge / .brw-badge-icon / .brw-badge-ok 自建徽章样式已退役（cr-128）：
   标签徽章归 kit .ui-badge 族（dim = 中性标签；ok = 完成态），模板 class 已切换 */
.brw-html-meta { font-size: 12px; color: var(--text-3); margin-top: 4px; }
.brw-eval { display: flex; flex-direction: column; gap: 4px; }
.brw-ok { padding: 2px 0; }
</style>

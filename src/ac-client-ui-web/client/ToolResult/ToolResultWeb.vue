<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon } from '@agentchat/webui-kit';
import { useWebSearchTabsStore, openSearchPanel } from '../searchTabs.ts';
import { partialSearchOf } from '../partialSearch.ts';

const props = defineProps<{ data: Record<string, unknown>; loading?: boolean }>();

const searchTabs = useWebSearchTabsStore();

// ---- Search mode fields ----
// 正常形读 data；截断恢复形（历史 subcall 补行 2KB 截断 → {__truncated,bytes,head}）
// 经 partialSearchOf 部分恢复（纯库——解析住独立模块，node 直测）
const partial = computed(() => partialSearchOf(props.data));
const query = computed(() => String(props.data.query || partial.value?.query || ''));
const answer = computed(() => String(props.data.answer || partial.value?.answer || ''));
// response_time 直读 data（截断恢复形从未提取它——web_search 键序里它住 results 之后）
const responseTime = computed(() => Number(props.data.response_time ?? 0));

interface SearchResultItem {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string | null;
}
const searchResults = computed<SearchResultItem[]>(() => {
  if (partial.value) {
    // 截断恢复形：字段宽松化（title/url/content/score 可缺）——展示几条算几条
    return partial.value.results as unknown as SearchResultItem[];
  }
  return props.data.results as SearchResultItem[];
});

const isSearch = computed(() => {
  if (partial.value) return partial.value.results.length > 0; // 截断形按恢复结果判
  return 'results' in props.data && searchResults.value.length > 0;
});

// ---- Expand/collapse for individual search results ----
const expandedResults = ref<Record<number, boolean>>({});
function toggleResult(idx: number) {
  expandedResults.value[idx] = !expandedResults.value[idx];
}

// ---- 搜索结果 → 辅助侧边栏（write 直达 preview 同款交互）----
// 宽屏：卡片行点击 = openSearchPanel（共享 helper——同 query 复用刷新 +
// 显式选区 + 舒适宽 + 展开）；窄屏（抽屉形态）：保持原地展开。
const resultCount = computed(() => searchResults.value.length);
function openInSidebar() {
  if (!isSearch.value) return;
  if (!openSearchPanel({
    query: query.value,
    provider: String(props.data.provider || '') || undefined,
    answer: answer.value || null,
    response_time: responseTime.value || undefined,
    credits_used: (props.data.credits_used ?? null) as number | null,
    results: searchResults.value,
  })) {
    inlineExpanded.value = !inlineExpanded.value; // 窄屏兜底：原地展开
  }
}

/** 窄屏原地展开态（宽屏走侧栏——卡片行即终点，同 write Label 语义） */
const inlineExpanded = ref(false);

/** 摘要行悬浮提示 */
const rowTitle = computed(() => `在侧边栏查看 "${query.value}" 的搜索结果（${resultCount.value} 条）`);

/** 仅放行 http(s) 链接：搜索结果 URL 来自外部网络（不可信），javascript:/data:
 *  协议写入 :href 会在点击时执行任意脚本（XSS）。 */
function safeUrl(u: unknown): string {
  const s = String(u ?? '');
  return /^https?:\/\//i.test(s) ? s : '#';
}
</script>

<template>
  <div class="tool-result-web">
    <!-- ============ 搜索结果（点击 → 辅助侧边栏展开；窄屏原地展开） ============ -->
    <template v-if="isSearch">
      <!-- 可点击摘要行（write Label 直达 preview 同款：行即终点） -->
      <div class="web-search-row" :title="rowTitle" @click="openInSidebar">
        <Icon name="search" :size="14" class="web-hint-icon" />
        <span class="web-search-row-query">"{{ query }}"</span>
        <span class="web-search-meta">
          <span v-if="resultCount">{{ resultCount }} 条结果</span>
          <span v-if="partial" class="web-search-partial" title="历史记录中该结果被截断——仅显示可恢复的部分结果">部分结果</span>
          <span v-if="responseTime">{{ responseTime.toFixed(2) }}s</span>
        </span>
        <Icon name="chevron-right" :size="12" class="web-search-row-arrow" :class="{ open: inlineExpanded }" />
      </div>

      <!-- 窄屏原地体（宽屏不渲染——详情在侧栏面板） -->
      <template v-if="inlineExpanded">
        <div v-if="answer" class="web-search-answer">
          <div class="web-answer-label"><Icon name="file-text" :size="12" class="web-answer-icon" />AI 摘要</div>
          <div class="web-answer-text">{{ answer }}</div>
        </div>

        <div class="web-search-results">
          <div
            v-for="(r, idx) in searchResults"
            :key="idx"
            class="web-search-item"
          >
            <a :href="safeUrl(r.url)" target="_blank" rel="noopener" class="web-search-title">
              {{ r.title }}
            </a>
            <div class="web-search-url">{{ r.url }}</div>
            <div class="web-search-content" :class="{ expanded: expandedResults[idx] }">
              {{ r.content }}
            </div>
            <div class="web-search-footer">
              <span v-if="typeof r.score === 'number'" class="web-search-score">相关性: {{ r.score.toFixed(4) }}</span>
              <button
                v-if="r.content && r.content.length > 200"
                class="web-expand-btn"
                @click="toggleResult(idx)"
              >
                {{ expandedResults[idx] ? '收起' : '展开' }}
              </button>
            </div>
          </div>
        </div>
      </template>
    </template>

    <!-- ============ 无数据 ============ -->
    <div v-else class="web-empty">
      <span>无搜索结果</span>
    </div>
  </div>
</template>

<style scoped>
.tool-result-web { padding: 4px 0; }

/* ---- 搜索摘要行 ---- */
/* 可点击摘要行：hover 强调可点（同 write-link 交互语言）；宽屏点击 →
   侧栏面板，窄屏点击 → 原地展开（箭头随 inlineExpanded 翻转） */
.web-search-row {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--text-2);
  cursor: pointer; flex-wrap: wrap;
  padding: 2px 0;
  border-radius: 4px;
}
.web-search-row:hover { color: var(--text-1); }
.web-search-row-query {
  font-weight: 600; color: var(--text-1);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 260px;
}
.web-hint-icon { flex-shrink: 0; color: var(--text-3); }
.web-search-row:hover .web-hint-icon { color: var(--primary-strong); }
.web-search-row-arrow {
  flex-shrink: 0; margin-left: auto; color: var(--text-3);
  transition: transform 0.15s;
}
.web-search-row-arrow.open { transform: rotate(90deg); }
.web-search-meta {
  display: flex; gap: 8px;
  font-size: 11px; color: var(--text-3);
}
.web-search-partial {
  color: var(--warn);
}

/* ---- 窄屏原地展开体（同侧栏面板形态——wsp-* 的同域词汇） ---- */
.web-search-answer {
  margin-top: 8px;
  background: var(--bg-surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 12px;
}
.web-answer-label {
  display: flex; align-items: center; gap: 5px;
  font-size: 12px; font-weight: 600;
  color: var(--text-3);
  margin-bottom: 6px;
}
.web-answer-icon { flex-shrink: 0; }
.web-answer-text {
  font-size: 12px; color: var(--text-1);
  line-height: 1.6; white-space: pre-wrap;
}
.web-search-results {
  margin-top: 8px;
  display: flex; flex-direction: column; gap: 10px;
}
.web-search-item {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg-surface);
  border: 1px solid var(--line);
}
.web-search-title {
  font-size: 12px; font-weight: 600;
  color: var(--primary-strong);
  text-decoration: none;
  display: block; margin-bottom: 2px;
}
.web-search-title:hover { text-decoration: underline; }
.web-search-url {
  font-size: 11px; color: var(--text-3);
  word-break: break-all; margin-bottom: 6px;
}
.web-search-content {
  font-size: 12px; color: var(--text-2);
  line-height: 1.6;
  max-height: 80px; overflow: hidden;
}
.web-search-content.expanded { max-height: none; }
.web-search-footer {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: 6px;
}
.web-search-score {
  font-size: 11px; color: var(--text-3);
}

/* ---- 展开按钮（单条结果共用） ---- */
.web-expand-btn {
  background: none; border: none; color: var(--primary-strong);
  font-size: 11px; cursor: pointer; padding: 2px 0; margin-top: 4px;
}
.web-expand-btn:hover { text-decoration: underline; }

.web-empty {
  font-size: 12px; color: var(--text-3);
  padding: 8px 0;
}
</style>

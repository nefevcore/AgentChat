<script setup lang="ts">
import { computed, ref } from 'vue';

const props = defineProps<{ data: Record<string, unknown> }>();

// ---- Search mode fields ----
const query = computed(() => String(props.data.query || ''));
const answer = computed(() => String(props.data.answer || ''));
const responseTime = computed(() => Number(props.data.response_time ?? 0));
const usage = computed(() => props.data.usage as { credits?: number } | null);

interface SearchResultItem {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string | null;
}
const searchResults = computed<SearchResultItem[]>(() => {
  return (props.data.results as SearchResultItem[]) || [];
});

// ---- Fetch mode fields ----
const url = computed(() => String(props.data.url || ''));
const textContent = computed(() => String(props.data.text || ''));
const contentType = computed(() => String(props.data.content_type || ''));
const size = computed(() => String(props.data.size || ''));
const truncated = computed(() => Boolean(props.data.truncated));
const textExtracted = computed(() => props.data.text_extracted !== false);

const isSearch = computed(() => 'results' in props.data && searchResults.value.length > 0);
const isFetch = computed(() => !isSearch.value && (!!url.value || !!textContent.value));
const isBinary = computed(() => isFetch.value && props.data.text_extracted === false);

// ---- Expand/collapse for fetch text ----
const textExpanded = ref(false);
function toggleTextExpand() {
  textExpanded.value = !textExpanded.value;
}

// ---- Expand/collapse for individual search results ----
const expandedResults = ref<Record<number, boolean>>({});
function toggleResult(idx: number) {
  expandedResults.value[idx] = !expandedResults.value[idx];
}

const displayUrl = computed(() => {
  const u = url.value;
  if (!u) return '';
  const stripped = u.replace(/^https?:\/\//, '');
  return stripped.length > 60 ? stripped.slice(0, 60) + '...' : stripped;
});

const displayContentType = computed(() => {
  const ct = contentType.value.toLowerCase();
  const map: Record<string, string> = {
    'text/html': 'HTML',
    'text/plain': '纯文本',
    'application/json': 'JSON',
    'image/png': 'PNG 图片',
    'image/jpeg': 'JPEG 图片',
    'image/gif': 'GIF 图片',
    'image/webp': 'WebP 图片',
    'image/svg+xml': 'SVG 图片',
    'video/mp4': 'MP4 视频',
    'audio/mpeg': 'MP3 音频',
  };
  for (const [key, label] of Object.entries(map)) {
    if (ct.includes(key)) return label;
  }
  return contentType.value || '未知类型';
});
</script>

<template>
  <div class="tool-result-web">
    <!-- ============ 搜索结果 ============ -->
    <template v-if="isSearch">
      <!-- 搜索摘要 -->
      <div class="web-search-header">
        <div class="web-search-hint">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            class="web-hint-icon">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
          </svg>
          <span>搜索 "<strong>{{ query }}</strong>"</span>
          <span class="web-search-meta">
            <span v-if="responseTime">{{ responseTime.toFixed(2) }}s</span>
            <span v-if="searchResults.length">{{ searchResults.length }} 条结果</span>
            <span v-if="usage?.credits != null">{{ usage.credits }} 积分</span>
          </span>
        </div>
      </div>

      <!-- AI 生成的答案摘要 -->
      <div v-if="answer" class="web-search-answer">
        <div class="web-answer-label">📝 AI 摘要</div>
        <div class="web-answer-text">{{ answer }}</div>
      </div>

      <!-- 搜索结果列表 -->
      <div class="web-search-results">
        <div
          v-for="(r, idx) in searchResults"
          :key="idx"
          class="web-search-item"
        >
          <a :href="r.url" target="_blank" rel="noopener" class="web-search-title">
            {{ r.title }}
          </a>
          <div class="web-search-url">{{ r.url }}</div>
          <div class="web-search-content" :class="{ expanded: expandedResults[idx] }">
            {{ r.content }}
          </div>
          <div class="web-search-footer">
            <span class="web-search-score">相关性: {{ r.score.toFixed(4) }}</span>
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

    <!-- ============ 网页抓取 ============ -->
    <template v-if="isFetch">
      <a v-if="url" :href="url" target="_blank" rel="noopener" class="web-fetch-url" :title="url">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          class="web-link-icon">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        <span class="web-fetch-domain">{{ displayUrl }}</span>
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          class="web-external-icon">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
      </a>

      <div class="web-fetch-tags">
        <span v-if="size" class="web-tag web-tag-size">{{ size }}</span>
        <span v-if="contentType" class="web-tag web-tag-type">{{ displayContentType }}</span>
        <span v-if="truncated" class="web-tag web-tag-truncated">已截断</span>
      </div>

      <template v-if="textExtracted && textContent">
        <div class="web-text" :class="{ 'web-text-expanded': textExpanded }">
          <pre><code>{{ textContent }}</code></pre>
        </div>
        <button class="web-expand-btn" @click="toggleTextExpand">
          {{ textExpanded ? '收起' : '展开全文' }}
        </button>
      </template>

      <div v-else-if="isBinary" class="web-binary">
        无法提取文本内容（{{ displayContentType }}）
      </div>
    </template>

    <!-- ============ 无数据 ============ -->
    <div v-if="!isSearch && !isFetch" class="web-empty">
      <span>无网页内容</span>
    </div>
  </div>
</template>

<style scoped>
.tool-result-web { padding: 4px 0; }

/* ---- Search mode ---- */
.web-search-header { margin-bottom: 10px; }
.web-search-hint {
  display: flex; align-items: center; gap: 6px;
  font-size: 13px; color: var(--color-text-secondary);
  flex-wrap: wrap;
}
.web-hint-icon { flex-shrink: 0; color: var(--color-text-tertiary); }
.web-search-meta {
  display: flex; gap: 8px;
  font-size: 11px; color: var(--color-text-tertiary);
}

.web-search-answer {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-light);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 12px;
}
.web-answer-label {
  font-size: 12px; font-weight: 600;
  color: var(--color-text-tertiary);
  margin-bottom: 6px;
}
.web-answer-text {
  font-size: 13px; color: var(--color-text-primary);
  line-height: 1.6; white-space: pre-wrap;
}

.web-search-results {
  display: flex; flex-direction: column; gap: 10px;
}
.web-search-item {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-light);
}
.web-search-title {
  font-size: 14px; font-weight: 600;
  color: var(--color-link);
  text-decoration: none;
  display: block; margin-bottom: 2px;
}
.web-search-title:hover { text-decoration: underline; }
.web-search-url {
  font-size: 11px; color: var(--color-text-tertiary);
  word-break: break-all; margin-bottom: 6px;
}
.web-search-content {
  font-size: 13px; color: var(--color-text-secondary);
  line-height: 1.6;
  max-height: 80px; overflow: hidden;
}
.web-search-content.expanded { max-height: none; }
.web-search-footer {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: 6px;
}
.web-search-score {
  font-size: 11px; color: var(--color-text-tertiary);
}

/* ---- Fetch mode ---- */
.web-fetch-url {
  display: flex; align-items: center; gap: 6px;
  font-size: 13px; color: var(--color-link); text-decoration: none;
  margin-bottom: 6px;
}
.web-fetch-url:hover { text-decoration: underline; }
.web-link-icon, .web-external-icon { flex-shrink: 0; }
.web-fetch-domain { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.web-fetch-tags { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
.web-tag {
  font-size: 11px; padding: 1px 8px; border-radius: 4px;
  background: var(--color-bg-secondary); color: var(--color-text-tertiary);
}
.web-tag-truncated { color: var(--color-warning); }
.web-text { max-height: 200px; overflow: hidden; position: relative; }
.web-text-expanded { max-height: none; }
.web-text pre {
  margin: 0; font-size: 12px; font-family: 'SF Mono', 'Fira Code', monospace;
  white-space: pre-wrap; word-break: break-word;
  color: var(--color-text-secondary);
}
.web-expand-btn {
  background: none; border: none; color: var(--color-link);
  font-size: 12px; cursor: pointer; padding: 2px 0; margin-top: 4px;
}
.web-binary {
  font-size: 13px; color: var(--color-text-tertiary); font-style: italic;
}
.web-empty {
  font-size: 13px; color: var(--color-text-tertiary);
  padding: 8px 0;
}
</style>

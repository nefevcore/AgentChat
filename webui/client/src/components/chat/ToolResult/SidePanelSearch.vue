<script setup lang="ts">
interface SearchResult {
  title: string;
  url: string;
  site_name?: string;
  date_published?: string;
  snippet?: string;
}

defineProps<{
  title: string;
  results: SearchResult[];
  totalEstimated: number;
  returned: number;
  warning: string;
}>();
</script>

<template>
  <div class="side-panel-search">
    <div class="search-summary">
      搜索 <strong>{{ title }}</strong> — 约 {{ totalEstimated }} 条，返回 {{ returned }} 条
    </div>
    <div v-if="warning" class="search-warning">{{ warning }}</div>
    <div class="search-results">
      <a
        v-for="(r, i) in results" :key="i"
        :href="r.url" target="_blank" rel="noopener"
        class="search-item"
      >
        <div class="search-item-title">{{ r.title }}</div>
        <div v-if="r.site_name || r.date_published" class="search-item-meta">
          <span v-if="r.site_name">{{ r.site_name }}</span>
          <span v-if="r.date_published">{{ r.date_published }}</span>
        </div>
        <div v-if="r.snippet" class="search-item-snippet">{{ r.snippet }}</div>
      </a>
    </div>
  </div>
</template>

<style scoped>
.side-panel-search {
  padding: 4px 0;
}
.search-summary {
  font-size: 12px;
  color: var(--color-text-tertiary);
  margin-bottom: 12px;
}
.search-warning {
  font-size: 12px;
  color: #f59e0b;
  margin-bottom: 8px;
}
.search-results {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.search-item {
  display: block;
  padding: 10px 8px;
  margin: 0 -8px;
  text-decoration: none;
  color: inherit;
  border-radius: 6px;
  transition: background 0.15s;
}
.search-item:hover {
  background: var(--color-bg-secondary);
}
.search-item-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-link);
  margin-bottom: 2px;
}
.search-item-meta {
  font-size: 11px;
  color: var(--color-text-tertiary);
  display: flex;
  gap: 8px;
  margin-bottom: 3px;
}
.search-item-snippet {
  font-size: 13px;
  color: var(--color-text-secondary);
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
</style>

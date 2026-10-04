<script setup lang="ts">
// ============================================================
// client/WebSearchPanel.vue —— aux 搜索选区面板（多 tab 搜索结果）
//
// tab 条（query + × 关闭 + 全部关闭）+ 多 pane（v-show 保活——
// 展开态跨 tab 切换不丢）。数据 = searchTabs 快照（工具卡点击时
// 全量入 tab，无需按需拉取）。结果行：标题外链 + URL + 摘要 +
// 展开全文（>200 字）。URL 白名单只放行 http(s)（同 ToolResultWeb
// safeUrl——搜索结果来自外部网络，javascript:/data: 进 :href 即
// 点击执行任意脚本）。
// ============================================================
import { ref } from 'vue';
import { computed } from 'vue';
import { DocTabs, Icon, Tooltip } from '@agentchat/webui-kit';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { useWebSearchTabsStore, type SearchTab } from './searchTabs.ts';

const ui = useUiStore();
const tabs = useWebSearchTabsStore();

/** tab 标题 = query（超长省略，title 悬浮全文） */
function titleOf(t: SearchTab): string {
  return t.query.length > 24 ? t.query.slice(0, 24) + '…' : t.query;
}

/** DocTabs 数据面（cr-157）：search 图标 + query 标题（悬浮全文） */
const docTabs = computed(() =>
  tabs.tabs.map((t) => ({ key: t.key, title: titleOf(t), icon: 'search' }))
);

function onTabClick(key: string) {
  tabs.activate(key); // panelOpen 已真——tab 条只在面板在场时渲染
}

function onTabClose(key: string) {
  tabs.closeTab(key);
  // 全关 → 收起 aux 区域（panelOpen 已随 closeTab 置假；active() 谓词
  // 失活 → 区域整体消失——同步收 auxVisible 让收起即时生效）
  if (tabs.count === 0) {
    ui.auxVisible = false;
    ui.selectAuxPanel(null);
  }
}

/** 全部关闭（清空 tab + 收起区域） */
function onCloseAll() {
  tabs.closeAll();
  ui.auxVisible = false;
  ui.selectAuxPanel(null);
}

/** 面板关闭按钮（头部区域级关闭——收面板不清 tab） */
function onClose() {
  tabs.closePanel();
  ui.auxVisible = false;
}

/** 仅放行 http(s) 链接（同 ToolResultWeb.safeUrl——XSS 防线） */
function safeUrl(u: unknown): string {
  const s = String(u ?? '');
  return /^https?:\/\//i.test(s) ? s : '#';
}

/** 域名展示（URL 去协议截断） */
function hostOf(u: string): string {
  const stripped = u.replace(/^https?:\/\//, '').split('/')[0] ?? u;
  return stripped.length > 48 ? stripped.slice(0, 48) + '…' : stripped;
}

/** 单条结果展开态（per-tab 内 per-idx） */
const expanded = ref<Record<string, boolean>>({});
function toggleExpand(k: string) {
  expanded.value[k] = !expanded.value[k];
}
function keyOf(tabKey: string, idx: number): string {
  return tabKey + '#' + idx;
}
</script>

<template>
  <div class="wsp-panel">
    <!-- tab 条（kit DocTabs——cr-157 归一 fpp-tab/wsp-tab 双副本） -->
    <DocTabs
      :tabs="docTabs"
      :active-key="tabs.activeKey"
      @select="onTabClick"
      @close="onTabClose"
    >
      <template #actions>
        <Tooltip v-if="tabs.count > 1" text="关闭全部" placement="bottom">
          <button class="wsp-action" aria-label="关闭全部" @click="onCloseAll">全部关闭</button>
        </Tooltip>
        <Tooltip text="收起面板" placement="bottom">
          <button class="wsp-action" aria-label="收起面板" @click="onClose">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        </Tooltip>
      </template>
    </DocTabs>

    <!-- pane 列（v-show 保活——切 tab 不丢展开态） -->
    <div class="wsp-panes">
      <div v-for="t in tabs.tabs" :key="t.key" v-show="t.key === tabs.activeKey" class="wsp-pane">
        <!-- 搜索元信息 -->
        <div class="wsp-meta">
          <Icon name="search" :size="13" class="wsp-meta-icon" />
          <span class="wsp-meta-query">{{ t.query }}</span>
          <span class="wsp-meta-sub">
            <span v-if="t.provider">{{ t.provider }}</span>
            <span v-if="t.results.length">{{ t.results.length }} 条</span>
            <span v-if="t.responseTime">{{ t.responseTime.toFixed(2) }}s</span>
            <span v-if="t.credits != null">{{ t.credits }} 积分</span>
          </span>
        </div>

        <!-- AI 摘要 -->
        <div v-if="t.answer" class="wsp-answer">
          <div class="wsp-answer-label"><Icon name="file-text" :size="12" class="wsp-answer-icon" />AI 摘要</div>
          <div class="wsp-answer-text">{{ t.answer }}</div>
        </div>

        <!-- 结果列表 -->
        <div v-if="t.results.length" class="wsp-results">
          <div v-for="(r, idx) in t.results" :key="idx" class="wsp-item">
            <a :href="safeUrl(r.url)" target="_blank" rel="noopener" class="wsp-item-title" :title="r.title">{{ r.title }}</a>
            <div class="wsp-item-url">{{ hostOf(r.url) }}</div>
            <div class="wsp-item-content" :class="{ expanded: expanded[keyOf(t.key, idx)] }">{{ r.content }}</div>
            <div class="wsp-item-footer">
              <span v-if="typeof r.score === 'number'" class="wsp-item-score">相关性 {{ r.score.toFixed(4) }}</span>
              <button
                v-if="r.content && r.content.length > 200"
                class="wsp-expand-btn"
                @click="toggleExpand(keyOf(t.key, idx))"
              >{{ expanded[keyOf(t.key, idx)] ? '收起' : '展开' }}</button>
            </div>
          </div>
        </div>
        <div v-else class="wsp-empty">无搜索结果</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wsp-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  overflow: hidden;
  background: var(--bg-base);
}

/* ── tab 条已迁 kit DocTabs（cr-157）；高度对齐会话头 ── */
.wsp-panel :deep(.ui-doc-tabs-strip) { height: var(--layout-header-height, 48px); }
.wsp-panel :deep(.ui-doc-tabs-actions) { border-left: 1px solid var(--line); }
.wsp-action {
  border: none;
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 4px;
}
.wsp-action:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

/* ── pane ── */
.wsp-panes {
  flex: 1;
  min-height: 0;
  display: flex;
}
.wsp-pane {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 12px 14px;
}

/* ── 元信息行 ── */
.wsp-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 10px;
}
.wsp-meta-icon { flex-shrink: 0; color: var(--text-3); }
.wsp-meta-query {
  font-weight: 600;
  color: var(--text-1);
  word-break: break-all;
}
.wsp-meta-sub {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--text-3);
}

/* ── AI 摘要（同 web-search-answer 形态） ── */
.wsp-answer {
  background: var(--bg-surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 12px;
}
.wsp-answer-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
  margin-bottom: 6px;
}
.wsp-answer-icon { flex-shrink: 0; }
.wsp-answer-text {
  font-size: 12px;
  color: var(--text-1);
  line-height: 1.6;
  white-space: pre-wrap;
}

/* ── 结果列表（同 web-search-item 形态） ── */
.wsp-results {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wsp-item {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg-surface);
  border: 1px solid var(--line);
}
.wsp-item-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--primary-strong);
  text-decoration: none;
  display: block;
  margin-bottom: 2px;
  word-break: break-word;
}
.wsp-item-title:hover { text-decoration: underline; }
.wsp-item-url {
  font-size: 11px;
  color: var(--text-3);
  word-break: break-all;
  margin-bottom: 6px;
}
.wsp-item-content {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.wsp-item-content.expanded {
  display: block;
  overflow: visible;
  -webkit-line-clamp: unset;
}
.wsp-item-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
}
.wsp-item-score {
  font-size: 11px;
  color: var(--text-3);
  font-family: 'SF Mono', 'Consolas', monospace;
}
.wsp-expand-btn {
  border: none;
  background: transparent;
  color: var(--primary-strong);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 4px;
}
.wsp-expand-btn:hover { text-decoration: underline; }

.wsp-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
}
</style>

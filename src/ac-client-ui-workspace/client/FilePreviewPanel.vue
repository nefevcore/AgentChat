<!-- FilePreviewPanel.vue —— aux 预览选区面板（多 tab 文件预览）
  结构：tab 条（文件名 + × 关闭 + 全部关闭）+ 多 pane（v-show 保活）。
  与 aux 区域的联动：
    · active() 谓词 = previewTabs.panelOpen（域内意愿，壳零域知识）；
    · 面板挂载时若 panelOpen 为真 → 同步 ui.auxVisible + 显式选区，
      收起（ui.auxVisible=false）不关 tab——重开恢复。
  数据：各 pane 自取数（filePreviewContent composable）。
  移动端（≤768）：本面板不渲染（同席位 ownerProps mobileBehavior=
  workspace-overlay 语义——窄屏走 Modal 全屏形态，FilePreviewHost
  分派）。 -->
<script setup lang="ts">
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { usePreviewTabsStore } from './previewTabs.ts';
import type { PreviewViewMode } from './filePreviewContent.ts';
import FilePreviewTabPane from './FilePreviewTabPane.vue';

const ui = useUiStore();
const tabs = usePreviewTabsStore();

/** tab 标题 = 文件名（去目录段） */
function titleOf(key: string): string {
  return key.split(/[/\\]/).pop() || key;
}

/** tab 条点击 = 激活（panelOpen 已真——tab 条只在面板在场时渲染） */
function onTabClick(key: string) {
  tabs.activate(key);
}

function onTabClose(key: string) {
  tabs.closeTab(key);
  // 全关 → 收起 aux 区域（panelOpen 已随 closeTab 置假；active() 谓词
  // 失活 → 区域整体消失——这里同步收 auxVisible 让收起即时生效）
  if (tabs.count === 0) {
    ui.auxVisible = false;
    ui.selectAuxPanel(null);
  }
}

/** 全部关闭（清空 tab + 收起区域） */
function onCloseAll() {
  for (const t of [...tabs.tabs]) tabs.closeTab(t.key);
  ui.auxVisible = false;
  ui.selectAuxPanel(null);
}

/** 面板关闭按钮（头部区域级关闭——收面板不清 tab） */
function onClose() {
  tabs.closePanel();
  ui.auxVisible = false;
}
</script>

<template>
  <div class="fpp-panel">
    <!-- tab 条 -->
    <div class="fpp-tabs" role="tablist" aria-label="文件预览">
      <div class="fpp-tab-scroll">
        <button
          v-for="t in tabs.tabs"
          :key="t.key"
          class="fpp-tab"
          :class="{ active: t.key === tabs.activeKey }"
          role="tab"
          :aria-selected="t.key === tabs.activeKey"
          :title="t.key"
          @click="onTabClick(t.key)"
        >
          <span class="fpp-tab-title">{{ titleOf(t.key) }}</span>
          <span
            class="fpp-tab-close"
            title="关闭"
            @click.stop="onTabClose(t.key)"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </span>
        </button>
      </div>
      <div class="fpp-tabs-actions">
        <button
          v-if="tabs.count > 1"
          class="fpp-action"
          title="关闭全部"
          @click="onCloseAll"
        >全部关闭</button>
        <button class="fpp-action" title="收起面板" @click="onClose">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- pane 列（v-show 保活——切 tab 不丢滚动/展开态） -->
    <div class="fpp-panes">
      <FilePreviewTabPane
        v-for="t in tabs.tabs"
        :key="t.key"
        class="fpp-pane"
        v-show="t.key === tabs.activeKey"
        :path="t.key"
        :fallback-agent-id="t.fallbackAgentId"
        :conversation-id="t.conversationId"
        :active="t.key === tabs.activeKey"
        :panel-open="ui.auxVisible"
        :wrap="!!t.wrap"
        :view-mode="t.viewMode ?? 'auto'"
        :on-toggle-wrap="() => tabs.toggleWrap(t.key)"
        :on-set-view-mode="(m: PreviewViewMode) => tabs.setViewMode(t.key, m)"
      />
    </div>
  </div>
</template>

<style scoped>
.fpp-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  overflow: hidden;
  background: var(--color-bg-page, #1e1e2e);
  /* 左缘分界线退役：分界统一由布局骨架 ResizeHandle 细线担当（重叠曾呈双线） */
}

/* ── tab 条 ── */
.fpp-tabs {
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--color-border, rgba(255,255,255,0.06));
  flex-shrink: 0;
  /* 高度对齐会话头（--layout-header-height）——三区顶部齐线，减少视觉割裂 */
  height: var(--layout-header-height, 48px);
}
.fpp-tab-scroll {
  display: flex;
  align-items: stretch;
  overflow-x: auto;
  flex: 1;
  min-width: 0;
  scrollbar-width: thin;
}
.fpp-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 8px 0 10px;
  border: none;
  border-right: 1px solid var(--color-border, rgba(255,255,255,0.05));
  background: transparent;
  color: var(--color-text-secondary, rgba(255,255,255,0.55));
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
  max-width: 160px;
  transition: background 0.15s, color 0.15s;
}
.fpp-tab:hover {
  background: var(--color-bg-hover, rgba(255,255,255,0.05));
  color: var(--color-text-primary, #e0e0e0);
}
.fpp-tab.active {
  background: var(--color-bg-surface, rgba(255,255,255,0.04));
  color: var(--color-text-primary, #e0e0e0);
  box-shadow: inset 0 -2px 0 var(--color-primary, #6366f1);
}
.fpp-tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
}
.fpp-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  color: var(--color-text-tertiary, rgba(255,255,255,0.35));
  flex-shrink: 0;
  transition: background 0.12s, color 0.12s;
}
.fpp-tab-close:hover {
  background: var(--color-bg-hover, rgba(255,255,255,0.12));
  color: var(--color-text-primary, #e0e0e0);
}
.fpp-tabs-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px;
  border-left: 1px solid var(--color-border, rgba(255,255,255,0.05));
  flex-shrink: 0;
}
.fpp-action {
  display: inline-flex;
  align-items: center;
  padding: 3px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary, rgba(255,255,255,0.4));
  cursor: pointer;
  font-size: 11px;
  transition: background 0.12s, color 0.12s;
}
.fpp-action:hover {
  background: var(--color-bg-hover, rgba(255,255,255,0.08));
  color: var(--color-text-primary, #e0e0e0);
}

/* ── pane 列 ── */
.fpp-panes {
  flex: 1;
  display: flex;
  min-height: 0;
  position: relative;
}
.fpp-pane {
  flex: 1;
  min-width: 0;
}

/* ── 亮色模式 ── */
:global(:root.light) .fpp-panel {
  background: #ffffff;
  border-left-color: rgba(0,0,0,0.06);
}
:global(:root.light) .fpp-tabs { border-bottom-color: rgba(0,0,0,0.06); }
:global(:root.light) .fpp-tab { border-right-color: rgba(0,0,0,0.05); color: #666; }
:global(:root.light) .fpp-tab.active {
  background: #f4f4f6;
  color: #222;
}
</style>

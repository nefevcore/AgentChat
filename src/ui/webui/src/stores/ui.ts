// ============================================================
// stores/ui.ts —— 布局与面板状态（从 App.vue 抽出）
//
// 职责：
//   · 面板可见性：列表 / 工作区 / 设置 / Token 用量 / 版本 / 文件预览
//   · 面板宽度（列表 / 工作区）+ 拖拽 resize 逻辑
//   · 移动端侧边栏
// ============================================================

import { defineStore } from 'pinia';
import { ref } from 'vue';

const MIN_LIST = 160;
const MIN_CHAT = 320;
const MIN_WORKSPACE = 180;
const MAX_WORKSPACE = 480;

/** 列表页签持久化键（agents / sessions；刷新后保持上次所在列表页） */
const LIST_PANEL_KEY = 'agentchat.listPanel';

function loadListPanel(): 'agents' | 'sessions' {
  try {
    return localStorage.getItem(LIST_PANEL_KEY) === 'sessions' ? 'sessions' : 'agents';
  } catch { return 'agents'; }
}

export const useUiStore = defineStore('ui', () => {
  // ── 列表面板 ──
  const listVisible = ref(true);
  const listWidth = ref(260);
  /** 列表槽位当前展示的页面：agents = Agent/群组列表，sessions = 会话列表（独立会话页）；
   *  初始化自 localStorage（刷新保持），切换时写回 */
  const listPanel = ref<'agents' | 'sessions'>(loadListPanel());
  // ── 移动端侧边栏 ──
  const sidebarVisible = ref(false);
  // ── 右侧工作区分屏 ──
  const workspaceVisible = ref(false);
  const workspaceWidth = ref(280);
  // ── 全局面板 ──
  const globalSettingsVisible = ref(false);
  /** 打开设置面板时定位到的 Agent（空=不定位） */
  const settingsAgentTarget = ref('');
  const tokenUsageVisible = ref(false);
  const versionVisible = ref(false);
  // ── 文件预览（全局单例）──
  const previewVisible = ref(false);
  const previewFilePath = ref('');
  /** 预览 fallback：Agent 回复常写相对路径，用于 files/<agentId>/ 回退 */
  const previewFallbackAgentId = ref('');

  function isNarrow(): boolean { return window.innerWidth <= 768; }

  /** 切换列表面板（窄屏 = 侧边栏抽屉） */
  function toggleList() {
    if (isNarrow()) {
      sidebarVisible.value = !sidebarVisible.value;
    } else {
      listVisible.value = !listVisible.value;
    }
    if (listVisible.value && isNarrow()) sidebarVisible.value = true;
  }

  /** 活动栏入口：切换列表槽位页面（点当前页 = 收起/展开，点另一页 = 切换并展开）；页签写回持久化 */
  function openListPanel(panel: 'agents' | 'sessions') {
    if (listPanel.value === panel) {
      toggleList();
      return;
    }
    listPanel.value = panel;
    try { localStorage.setItem(LIST_PANEL_KEY, panel); } catch { /* ignore */ }
    listVisible.value = true;
    if (isNarrow()) sidebarVisible.value = true;
  }
  function toggleSidebar() { sidebarVisible.value = !sidebarVisible.value; }
  function closeSidebar() { sidebarVisible.value = false; }

  /** 切换右侧工作区分屏（与会话共存，不影响 Agent 列表） */
  function toggleWorkspace() {
    workspaceVisible.value = !workspaceVisible.value;
  }

  function openAgentSettings(agentId: string) {
    settingsAgentTarget.value = agentId;
    globalSettingsVisible.value = true;
  }
  function openGlobalSettings() {
    settingsAgentTarget.value = '';
    globalSettingsVisible.value = true;
  }
  function closeSettings() { globalSettingsVisible.value = false; }

  function openTokenUsage() { tokenUsageVisible.value = true; }
  function closeTokenUsage() { tokenUsageVisible.value = false; }

  function openVersion() { versionVisible.value = true; }
  function closeVersion() { versionVisible.value = false; }

  function openPreview(filePath: string, fallbackAgentId = '') {
    previewFilePath.value = filePath;
    previewFallbackAgentId.value = fallbackAgentId;
    previewVisible.value = true;
  }
  function closePreview() {
    previewVisible.value = false;
    previewFilePath.value = '';
    previewFallbackAgentId.value = '';
  }

  // ── 拖拽 resize（列表 / 工作区方向相反）──
  const resizing = ref(false);
  let resizeKind: 'list' | 'workspace' = 'list';
  let resizeStartX = 0;
  let resizeStartW = 0;

  function onResizeMove(e: MouseEvent) {
    if (!resizing.value) return;
    const delta = e.clientX - resizeStartX;
    if (resizeKind === 'list') {
      const maxWidth = window.innerWidth - 48 - MIN_CHAT;
      listWidth.value = Math.max(MIN_LIST, Math.min(resizeStartW + delta, maxWidth));
    } else {
      // handle 在工作区左缘：右移 = 工作区变窄
      workspaceWidth.value = Math.max(MIN_WORKSPACE, Math.min(resizeStartW - delta, MAX_WORKSPACE));
    }
  }
  function onResizeEnd() {
    resizing.value = false;
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeEnd);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
  function startResize(kind: 'list' | 'workspace', e: MouseEvent) {
    e.preventDefault();
    resizeKind = kind;
    resizeStartX = e.clientX;
    resizeStartW = kind === 'list' ? listWidth.value : workspaceWidth.value;
    resizing.value = true;
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeEnd);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  return {
    // 面板
    listVisible, listWidth, listPanel, sidebarVisible,
    workspaceVisible, workspaceWidth,
    globalSettingsVisible, settingsAgentTarget,
    tokenUsageVisible, versionVisible,
    previewVisible, previewFilePath, previewFallbackAgentId,
    // 动作
    isNarrow, toggleList, openListPanel, toggleSidebar, closeSidebar, toggleWorkspace,
    openAgentSettings, openGlobalSettings, closeSettings,
    openTokenUsage, closeTokenUsage,
    openVersion, closeVersion,
    openPreview, closePreview,
    // resize
    resizing, startResize,
  };
});

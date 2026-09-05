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

/** 列表页签持久化键（agents / sessions / tracking；刷新后保持上次所在列表页） */
const LIST_PANEL_KEY = 'agentchat.listPanel';

/** 思维链显示开关持久化键（'1' 显示 / '0' 隐藏；默认显示） */
const SHOW_THINKING_KEY = 'agentchat.showThinking';

/** 列表槽位页面：agents = Agent/群组列表，sessions = 会话列表，tracking = 运行跟踪（清单面板） */
type ListPanelId = 'agents' | 'sessions' | 'tracking';

function loadListPanel(): ListPanelId {
  try {
    const v = localStorage.getItem(LIST_PANEL_KEY);
    return v === 'sessions' || v === 'tracking' ? v : 'agents';
  } catch { return 'agents'; }
}

function loadShowThinking(): boolean {
  try {
    return localStorage.getItem(SHOW_THINKING_KEY) !== '0';
  } catch { return true; }
}

export const useUiStore = defineStore('ui', () => {
  // ── 列表面板 ──
  const listVisible = ref(true);
  const listWidth = ref(260);
  /** 列表槽位当前展示的页面：agents = Agent/群组列表，sessions = 会话列表（独立会话页），
   *  tracking = 运行跟踪清单面板；初始化自 localStorage（刷新保持），切换时写回。
   *  标准模型：活动栏只换侧边栏面板，不直接决定主区 */
  const listPanel = ref<ListPanelId>(loadListPanel());
  // ── 思维链可见性（全局开关）：关闭后整条思维链不渲染（思考文本、工具
  //    卡片与折叠栏一并隐藏，仅显示正文回复），刷新保持；由会话头部 switch 切换 ──
  const showThinking = ref(loadShowThinking());
  // ── 主区「运行矩阵」视图（大画布）：由清单面板入口打开；选中 Agent/群/会话时让位回聊天 ──
  const trackingViewVisible = ref(false);
  // ── 主区「Agent 会话对」只读视角（pair）：矩阵格子点击进入，两端点都非 viewer ──
  //    注册在 talk 之前的视角（App.vue），active 期间覆盖聊天视角；关闭/选中别处即回退
  const pairView = ref<{ a: string; b: string } | null>(null);
  // ── 移动端侧边栏 ──
  const sidebarVisible = ref(false);
  // ── 右侧工作区分屏 ──
  const workspaceVisible = ref(false);
  const workspaceWidth = ref(280);
  // ── 全局面板 ──
  const globalSettingsVisible = ref(false);
  /** 打开设置面板时定位到的 Agent（空=不定位） */
  const settingsAgentTarget = ref('');
  /** 打开设置面板时定位到的设置页签 id（空=不定位；如 sys.timer——/timer 快捷命令入口） */
  const settingsSectionTarget = ref('');
  const tokenUsageVisible = ref(false);
  const versionVisible = ref(false);
  // ── 文件预览（全局单例）──
  const previewVisible = ref(false);
  const previewFilePath = ref('');
  /** 预览 fallback：Agent 回复常写相对路径，用于 files/<agentId>/ 回退 */
  const previewFallbackAgentId = ref('');

  function isNarrow(): boolean { return window.innerWidth <= 768; }

  /** 切换列表面板（窄屏 = 侧边栏抽屉）。
   *  窄屏只翻转抽屉可见性后立即返回——此前末尾的"listVisible 时强制展开抽屉"
   *  会把刚关上的抽屉又打开（活动栏图标在移动端永远关不掉抽屉）。 */
  function toggleList() {
    if (isNarrow()) {
      sidebarVisible.value = !sidebarVisible.value;
      return;
    }
    listVisible.value = !listVisible.value;
  }

  /** 活动栏入口：切换列表槽位页面（点当前页 = 收起/展开，点另一页 = 切换并展开）；页签写回持久化。
   *  标准模型：活动栏只控制侧边栏，不动主区（矩阵视图/聊天区保持原状） */
  function openListPanel(panel: ListPanelId) {
    if (listPanel.value === panel) {
      toggleList();
      return;
    }
    listPanel.value = panel;
    try { localStorage.setItem(LIST_PANEL_KEY, panel); } catch { /* ignore */ }
    listVisible.value = true;
    if (isNarrow()) sidebarVisible.value = true;
  }

  /** 主区「运行矩阵」视图：由运行清单面板入口打开（大画布需主区宽度） */
  function openTrackingView() { trackingViewVisible.value = true; }
  /** 关闭矩阵视图：连带关闭 pair 只读视角（避免悬挂的 pair 独占主区） */
  function closeTrackingView() {
    trackingViewVisible.value = false;
    pairView.value = null;
  }

  /** 主区「Agent 会话对」只读视角（矩阵格子进入）：a/b 为两端点 id（排序与否均可）。
   *  进入时不关矩阵视图 —— 返回（closePairView）即回到矩阵，而非空白聊天区 */
  function openPairView(a: string, b: string) { pairView.value = { a, b }; }
  function closePairView() { pairView.value = null; }
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
  /** 打开全局设置（可选定位到某页签，如 'sys.timer'——/timer 快捷命令） */
  function openGlobalSettings(section?: string) {
    settingsAgentTarget.value = '';
    settingsSectionTarget.value = section ?? '';
    globalSettingsVisible.value = true;
  }
  function closeSettings() { globalSettingsVisible.value = false; }

  function openTokenUsage() { tokenUsageVisible.value = true; }
  function closeTokenUsage() { tokenUsageVisible.value = false; }

  /** 设置思维链可见性（全局；写回 localStorage 刷新保持） */
  function setShowThinking(v: boolean) {
    showThinking.value = v;
    try { localStorage.setItem(SHOW_THINKING_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  }

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
    // 兜底：鼠标移出窗口后松开时 document 收不到 mouseup（无 pointer capture），
    // 拖拽态会永久悬挂（col-resize 光标 + userSelect:none 残留，未按键的移动
    // 仍持续改宽度）。检测 buttons 归零即视为释放。
    if (!e.buttons) {
      onResizeEnd();
      return;
    }
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
    showThinking, setShowThinking,
    trackingViewVisible, pairView,
    workspaceVisible, workspaceWidth,
    globalSettingsVisible, settingsAgentTarget, settingsSectionTarget,
    tokenUsageVisible, versionVisible,
    previewVisible, previewFilePath, previewFallbackAgentId,
    // 动作
    isNarrow, toggleList, openListPanel, openTrackingView, closeTrackingView,
    openPairView, closePairView, toggleSidebar, closeSidebar, toggleWorkspace,
    openAgentSettings, openGlobalSettings, closeSettings,
    openTokenUsage, closeTokenUsage,
    openVersion, closeVersion,
    openPreview, closePreview,
    // resize
    resizing, startResize,
  };
});

// ============================================================
// client/uiStore.ts —— 布局与面板状态（2026-11 自 ac-client-ui-sidebar 行归并壳件——布局状态归位壳件）
//（原 webui stores/ui.ts 原样迁入——M27.2-2 随 sidebar 件出包；
// webui stores/ui 门面 re-export 维持旧路径〔同一 pinia id =
// 同一 store 实例〕）
//
// 职责：
//   · 面板可见性：列表 / aside（右侧区域）/ 设置 / Token 用量 / 版本 / 文件预览
//   · 面板宽度（列表 / aside）+ 拖拽 resize 逻辑
//   · 移动端侧边栏
// ============================================================

import { defineStore } from 'pinia';
import { ref } from 'vue';

const MIN_PRIMARY = 160;
const MIN_CHAT = 320;
const MIN_AUX = 180;
const MAX_AUX = 480;

/** 列表页签持久化键（agents / sessions / tracking；刷新后保持上次所在列表页） */
const PRIMARY_PANEL_KEY = 'agentchat.primaryPanel'; // 2026-11 键名随主侧边栏改名（旧键 agentchat.listPanel 弃用——面板选中一次性回落默认）

/** 思维链显示开关持久化键（'1' 显示 / '0' 隐藏；默认显示） */
const SHOW_THINKING_KEY = 'agentchat.showThinking';

/** 列表槽位页面：agents = Agent/群组列表，sessions = 会话列表，tracking = 运行跟踪（清单面板） */
type ListPanelId = 'agents' | 'sessions' | 'tracking';

function loadPrimaryPanel(): ListPanelId {
  try {
    const v = localStorage.getItem(PRIMARY_PANEL_KEY);
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
  const primaryVisible = ref(true);
  const primaryWidth = ref(260);
  /** 列表槽位当前展示的页面：agents = Agent/群组列表，sessions = 会话列表（独立会话页），
   *  tracking = 运行跟踪清单面板；初始化自 localStorage（刷新保持），切换时写回。
   *  标准模型：活动栏只换侧边栏面板，不直接决定主区 */
  const primaryPanel = ref<ListPanelId>(loadPrimaryPanel());
  // ── 思维链可见性（全局开关）：关闭后整条思维链不渲染（思考文本、工具
  //    卡片与折叠栏一并隐藏，仅显示正文回复），刷新保持；由会话头部 switch 切换 ──
  const showThinking = ref(loadShowThinking());
  // ── 主区「运行矩阵」视图（大画布）：由清单面板入口打开；选中 Agent/群/会话时让位回聊天 ──
  const trackingViewVisible = ref(false);
  // ── 主区「Agent 会话对」只读视角（pair）：矩阵格子点击进入，两端点都非 viewer ──
  //    注册在 talk 之前的视角（App.vue），active 期间覆盖聊天视角；关闭/选中别处即回退
  const pairView = ref<{ a: string; b: string } | null>(null);
  // ── 移动端侧边栏 ──
  const drawerVisible = ref(false); // 移动端抽屉（primary-sidebar 移动形态）
  // ── 右侧区域（aside 席位——第四层；区域级状态，面板内容经选举条目供） ──
  const auxVisible = ref(false);
  const auxWidth = ref(280);
  /** aux 显式选区（会话区重构·切换条交互）：切换条按钮点击置位——
   *  当选举区以此为准（显式选择优先于谓词选举回落）；null = 未显式
   *  选择（沿 active() 谓词选举，如 workspace 恒真兜底）。与 auxVisible
   *  分立：选区记忆 + 区域开合正交（活动栏同款交互语义） */
  const auxPanel = ref<string | null>(null);
  // ── 全局面板 ──
  const globalSettingsVisible = ref(false);
  /** 打开设置面板时定位到的 Agent（空=不定位） */
  const settingsAgentTarget = ref('');
  /** 打开设置面板时定位到的设置页签 id（空=不定位；如 sys.timer——/timer 快捷命令入口） */
  const settingsSectionTarget = ref('');
  const tokenUsageVisible = ref(false);
  const versionVisible = ref(false);
  // ── System Prompt 预览弹窗（会话区重构：自 ConversationView 内联迁出，
  //    overlay 席位 conversation 出厂贡献消费——开关态全局单例，TokenUsage 同款）──
  const systemPromptOpen = ref(false);
  /** 弹窗标题用的目标 Agent 显示名（打开时快照） */
  const systemPromptAgentName = ref('');
  // ── 文件预览（全局单例）──
  const previewVisible = ref(false);
  const previewFilePath = ref('');
  /** 预览 fallback：Agent 回复常写相对路径，用于 files/<agentId>/ 回退 */
  const previewFallbackAgentId = ref('');

  function isNarrow(): boolean { return window.innerWidth <= 768; }

  /** 切换列表面板（窄屏 = 侧边栏抽屉）。
   *  窄屏只翻转抽屉可见性后立即返回——此前末尾的"primaryVisible 时强制展开抽屉"
   *  会把刚关上的抽屉又打开（活动栏图标在移动端永远关不掉抽屉）。 */
  function togglePrimary() {
    if (isNarrow()) {
      drawerVisible.value = !drawerVisible.value;
      return;
    }
    primaryVisible.value = !primaryVisible.value;
  }

  /** 活动栏入口：切换列表槽位页面（点当前页 = 收起/展开，点另一页 = 切换并展开）；页签写回持久化。
   *  标准模型：活动栏只控制侧边栏，不动主区（矩阵视图/聊天区保持原状） */
  function openPrimaryPanel(panel: ListPanelId) {
    if (primaryPanel.value === panel) {
      togglePrimary();
      return;
    }
    primaryPanel.value = panel;
    try { localStorage.setItem(PRIMARY_PANEL_KEY, panel); } catch { /* ignore */ }
    primaryVisible.value = true;
    if (isNarrow()) drawerVisible.value = true;
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
  function toggleDrawer() { drawerVisible.value = !drawerVisible.value; }
  function closeDrawer() { drawerVisible.value = false; }

  /** 切换右侧区域（aside 席位开合；与会话共存，不影响 Agent 列表） */
  function toggleAux() {
    auxVisible.value = !auxVisible.value;
  }
  /** 展开右侧区域（切换条按钮「点非当选区」路径：选区置位 + 展开） */
  function openAux() {
    auxVisible.value = true;
  }
  /** 显式选择 aux 选区（切换条按钮点击；null = 回落谓词选举） */
  function selectAuxPanel(id: string | null) {
    auxPanel.value = id;
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

  /** 打开 System Prompt 预览（agentName = 弹窗标题快照；内容请求由
   *  触发方〔ConversationView 头部按钮〕经 chatStore 发起） */
  function openSystemPrompt(agentName = '') {
    systemPromptAgentName.value = agentName;
    systemPromptOpen.value = true;
  }
  function closeSystemPrompt() {
    systemPromptOpen.value = false;
    systemPromptAgentName.value = '';
  }

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

  // ── 拖拽 resize（列表 / aside 方向相反）──
  const resizing = ref(false);
  let resizeKind: 'primary' | 'aux' = 'primary';
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
    if (resizeKind === 'primary') {
      const maxWidth = window.innerWidth - 48 - MIN_CHAT;
      primaryWidth.value = Math.max(MIN_PRIMARY, Math.min(resizeStartW + delta, maxWidth));
    } else {
      // handle 在 aside 区域左缘：右移 = 区域变窄
      auxWidth.value = Math.max(MIN_AUX, Math.min(resizeStartW - delta, MAX_AUX));
    }
  }
  function onResizeEnd() {
    resizing.value = false;
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeEnd);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
  function startResize(kind: 'primary' | 'aux', e: MouseEvent) {
    e.preventDefault();
    resizeKind = kind;
    resizeStartX = e.clientX;
    resizeStartW = kind === 'primary' ? primaryWidth.value : auxWidth.value;
    resizing.value = true;
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeEnd);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  return {
    // 面板
    primaryVisible, primaryWidth, primaryPanel, drawerVisible,
    showThinking, setShowThinking,
    trackingViewVisible, pairView,
    auxVisible, auxWidth, auxPanel,
    globalSettingsVisible, settingsAgentTarget, settingsSectionTarget,
    tokenUsageVisible, versionVisible,
    systemPromptOpen, systemPromptAgentName,
    previewVisible, previewFilePath, previewFallbackAgentId,
    // 动作
    isNarrow, togglePrimary, openPrimaryPanel, openTrackingView, closeTrackingView,
    openPairView, closePairView, toggleDrawer, closeDrawer, toggleAux, openAux, selectAuxPanel,
    openAgentSettings, openGlobalSettings, closeSettings,
    openTokenUsage, closeTokenUsage, openSystemPrompt, closeSystemPrompt,
    openVersion, closeVersion,
    openPreview, closePreview,
    // resize
    resizing, startResize,
  };
});

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
import { auxSidebarPanelDefs } from './auxSidebarViews.ts';

const MIN_PRIMARY = 160;
const MIN_CHAT = 320;
const MIN_AUX = 180;
/** 主/辅侧边栏默认宽度（双击把手还原值） */
const DEFAULT_PRIMARY = 260;
const DEFAULT_AUX = 280;

/** 半屏宽（preview 舒适宽——代码/文档对照的横向空间；受 maxAux 钳制 + 主区保底） */
function halfScreenWidth(): number {
  const bars = 48 + 40;
  const primary = 0; // 让位场景主栏通常已收；在场时 maxAux 钳制兜底
  return Math.floor((window.innerWidth - bars - primary) / 2);
}

/** aux 拖动上限：视口 70%，且不超过「视口 - 88px 双活动栏 - 320 主区保底」
 *  （窄屏〔≤768 抽屉形态〕退回静态上限）。70% 场景拖动必先经过 30% 让位
 *  （主栏已收），主区实际软下限由第二项钳制保证 ≥ MIN_CHAT——1360px 以下
 *  视口上限随主区保底自动回落（如 1280 屏实际 872px/68%）。主区
 *  flex:1+min-width:0（AppFrame/MainViewHost）不被侧栏挤压出滚动条。 */
function maxAux(): number {
  if (window.innerWidth <= 768) return 480;
  return Math.max(480, Math.min(
    Math.floor(window.innerWidth * 0.7),
    window.innerWidth - 88 - MIN_CHAT,
  ));
}

/** aux 超宽让位阈：aux 拖过视口 30% → 主侧边栏自动收起（主区让位——
 *  半屏预览/监视场景主栏是空间冗余）。只收不展：拖回窄宽不自动展开，
 *  下次展开（活动栏图标点击 = togglePrimary/openPrimaryPanel）恢复——
 *  用户显式动作优先于隐式让位。窄屏（≤768 抽屉形态）不适用。 */
const AUX_YIELD_RATIO = 0.3;
function auxYieldAt(): number {
  return Math.floor(window.innerWidth * AUX_YIELD_RATIO);
}

/** 列表页签持久化键（agents / sessions / tracking；刷新后保持上次所在列表页） */
const PRIMARY_PANEL_KEY = 'agentchat.primaryPanel'; // 2026-11 键名随主侧边栏改名（旧键 agentchat.listPanel 弃用——面板选中一次性回落默认）

/** aux 选区持久化键（选区 id；刷新后恢复上次选区。展开状态不持久化——
 *  刷新后收起是保守选择（监视面板一键重开），避免「刷新后突然被占半屏」） */
const AUX_PANEL_KEY = 'agentchat.auxPanel';

/** aux 宽度持久化键（用户拖调/铺开过的宽度；刷新保持分屏比例） */
const AUX_WIDTH_KEY = 'agentchat.auxWidth';

/** 思维链显示开关持久化键（'1' 显示 / '0' 隐藏；默认显示） */
const SHOW_THINKING_KEY = 'agentchat.showThinking';

/** 列表槽位页面：agents = Agent/群组列表，sessions = 会话列表，tracking = 运行跟踪（清单面板） */
type ListPanelId = 'agents' | 'sessions' | 'tracking';

/** 缺省面板：sessions（独立会话）——首次启动无记录时默认进入独立会话页
 *  （2026-12 首启体验：开箱即会话页；已写过偏好的用户不受影响）。 */
const DEFAULT_PRIMARY_PANEL: ListPanelId = 'sessions';

function loadPrimaryPanel(): ListPanelId {
  try {
    const v = localStorage.getItem(PRIMARY_PANEL_KEY);
    return v === 'sessions' || v === 'tracking' ? v : v === 'agents' ? v : DEFAULT_PRIMARY_PANEL;
  } catch { return DEFAULT_PRIMARY_PANEL; }
}

function loadShowThinking(): boolean {
  try {
    return localStorage.getItem(SHOW_THINKING_KEY) !== '0';
  } catch { return true; }
}

/** 持久化 aux 选区（null 清除——回落谓词选举也记下，刷新一致） */
function persistAuxPanel(id: string | null): void {
  try {
    if (id) localStorage.setItem(AUX_PANEL_KEY, id);
    else localStorage.removeItem(AUX_PANEL_KEY);
  } catch { /* ignore */ }
}

/** 恢复 aux 选区（刷新保持；无记录 = null 走谓词选举） */
function loadAuxPanel(): string | null {
  try { return localStorage.getItem(AUX_PANEL_KEY); } catch { return null; }
}

/** 恢复 aux 宽度（用户拖调/铺开过的值；无效/缺省回落 DEFAULT_AUX） */
function loadAuxWidth(): number {
  try {
    const v = Number(localStorage.getItem(AUX_WIDTH_KEY));
    return Number.isFinite(v) && v >= MIN_AUX && v <= Math.max(480, Math.floor(window.innerWidth * 0.7))
      ? Math.floor(v) : DEFAULT_AUX;
  } catch { return DEFAULT_AUX; }
}

/** 持久化 aux 宽度（去抖内联在写点——拖动 mousemove 高频不写盘，仅终值写） */
function persistAuxWidth(w: number): void {
  try { localStorage.setItem(AUX_WIDTH_KEY, String(Math.round(w))); } catch { /* ignore */ }
}

export const useUiStore = defineStore('ui', () => {
  // ── 列表面板 ──
  const primaryVisible = ref(true);
  const primaryWidth = ref(DEFAULT_PRIMARY);
  /** 列表槽位当前展示的页面：agents = Agent/群组列表，sessions = 会话列表（独立会话页），
   *  tracking = 运行跟踪清单面板；初始化自 localStorage（刷新保持），切换时写回。
   *  标准模型：活动栏只换侧边栏面板，不直接决定主区 */
  const primaryPanel = ref<ListPanelId>(loadPrimaryPanel());
  // ── 思维链可见性（全局开关）：关闭后整条思维链不渲染（思考文本、工具
  //    卡片与折叠栏一并隐藏，仅显示正文回复），刷新保持；由会话头部 switch 切换 ──
  const showThinking = ref(loadShowThinking());
  // ── 主区「运行矩阵」视图（大画布）：由清单面板入口打开；选中 Agent/群/会话时让位回聊天 ──
  const trackingViewVisible = ref(false);
  // ── 主区「Agent 会话对」只读视角（pair）：矩阵格子/面板运行中行点击进入，
  //    两端点都非 viewer。注册在 talk 之前的视角，active 期间覆盖聊天视角；
  //    进入即收矩阵（openPairView 单点互斥），选中别处让位（exitOverlays）──
  const pairView = ref<{ a: string; b: string } | null>(null);
  // ── 主区「子 Agent 会话」只读视角（subagent）：运行跟踪面板子Agent 行点击
  //    进入（subagent-session-view-plan R7）——与 pair 同款让位协议：选中
  //    Agent/群/独立会话即回退；与 pairView 互斥（open 时互清）。
  const subagentView = ref<{ subId: string; name?: string; parentId?: string } | null>(null);
  // ── 移动端侧边栏 ──
  const drawerVisible = ref(false); // 移动端抽屉（primary-sidebar 移动形态）
  // ── 右侧区域（aside 席位——第四层；区域级状态，面板内容经选举条目供） ──
  const auxVisible = ref(false);
  const auxWidth = ref(loadAuxWidth());
  /** aux 显式选区（会话区重构·切换条交互）：切换条按钮点击置位——
   *  当选举区以此为准（显式选择优先于谓词选举回落）；null = 未显式
   *  选择（沿 active() 谓词选举，如 workspace 恒真兜底）。与 auxVisible
   *  分立：选区记忆 + 区域开合正交（活动栏同款交互语义） */
  const auxPanel = ref<string | null>(loadAuxPanel());
  // ── 全局面板 ──
  const globalSettingsVisible = ref(false);
  /** 打开设置面板时定位到的 Agent（空=不定位） */
  const settingsAgentTarget = ref('');
  /** 打开设置面板时定位到的设置页签 id（空=不定位；如 sys.timer——/timer 快捷命令入口） */
  const settingsSectionTarget = ref('');
  /** Agent 编辑器内有未保存编辑（M29 P1-3b 收口余留：发布方 = ui-agents
   *  AgentSettingsHost〔编辑编排已归域，壳不引编辑态〕；消费方 = 设置壳
   *  关闭/切节守护——节宿主卸载即弃置编辑，需在卸载前拦截确认） */
  const agentEditorDirty = ref(false);
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
  /** 预览会话键（M32 工作区推导）：single 会话挂载工作区的服务端基准 */
  const previewConversationId = ref('');
  /** 桌面多 tab 预览意图载体：路径 + fallback 随帧（意图 seq 住通用
   *  auxIntent；FilePreviewHost watch 消费——开 tab + 切 'preview' 选区） */
  const previewIntentFallback = ref('');
  /** 意图帧会话键（同 previewIntentFallback——FilePreviewHost 消费） */
  const previewIntentConversationId = ref('');

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
    if (primaryVisible.value) {
      primaryYielded.value = false; // 显式展开 = 让位态复位
      shrinkAuxForPrimary(); // 展开护距：aux 超宽时收缩（防两栏总宽溢出视口）
    }
  }

  /** 展开主栏的 aux 护距：primary + aux + 88 双活动栏 + MIN_CHAT 主区
   *  超出视口时收缩 aux（让位期 aux 常停在 70% 上限，展开若不收则
   *  aux 被推出屏幕/主区压没——「展开占位空白」的一种形态）。收缩保
   *  aux ≥ MIN_AUX；空间仍不足由主区 min-width:0 兜底（不溢出）。 */
  function shrinkAuxForPrimary() {
    if (!auxVisible.value) return;
    const budget = window.innerWidth - 88 - MIN_CHAT - primaryWidth.value;
    const cap = Math.max(MIN_AUX, budget);
    if (auxWidth.value > cap) auxWidth.value = cap;
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
    primaryYielded.value = false; // 显式展开 = 让位态复位
    shrinkAuxForPrimary(); // 展开护距（同 togglePrimary）
    if (isNarrow()) drawerVisible.value = true;
  }

  /** 主区「矩阵快照」视图：由运行面板「矩阵快照」入口打开（大画布需
   *  主区宽度）。显式导航互斥：进矩阵清 pair/subagent 视角（会话态与
   *  矩阵态不叠——视角由进入路径拥有，非当选即静默） */
  function openTrackingView() {
    pairView.value = null;
    subagentView.value = null;
    trackingViewVisible.value = true;
  }
  /** 运行跟踪 aux 选区入口（A5：活动栏 tracking 按钮宽屏直达侧栏——
   *  通用意图 panel='tracking'；RunTrackingSidebarHost 消费展开） */
  function auxOpenTracking() {
    if (!isNarrow()) sendAuxIntent('tracking');
    else openPrimaryPanel('tracking'); // 窄屏兜底（抽屉面板页）
  }
  /** 定时任务 aux 选区入口（/timer 快捷命令等——settings sys.timer 节
   *  已撤，本动作是唯一全局任务入口；TimersPanelHost 消费展开） */
  function openTimers() {
    sendAuxIntent('timers');
  }
  /** 关闭矩阵视图（不连带清视角——各 open* 单点互斥，见下） */
  function closeTrackingView() {
    trackingViewVisible.value = false;
  }

  /** 进入会话的完整导航意图（列表/矩阵/面板入口统一）：收矩阵 + 清
   *  pair/subagent 视角。覆盖同值重选边界——选中三元组不变时让位
   *  watch 不触发，须显式收口全部覆盖层（返回按钮已退役，无其他
   *  退出路径）。 */
  function exitOverlays() {
    trackingViewVisible.value = false;
    pairView.value = null;
    subagentView.value = null;
  }

  /** 主区「Agent 会话对」只读视角（矩阵格子/面板运行中行进入）：a/b 为
   *  两端点 id（排序与否均可）。显式导航互斥：进入会话即收起矩阵——
   *  不做「返回回矩阵」联动（返回按钮已退役）。 */
  function openPairView(a: string, b: string) {
    subagentView.value = null; // 反向互斥（subagent 视角让位给 pair）
    trackingViewVisible.value = false; // 进会话收矩阵（显式导航互斥）
    pairView.value = { a, b };
  }
  function closePairView() { pairView.value = null; }

  /** 主区「子 Agent 会话」只读视角（运行跟踪面板子Agent 行进入）：
   *  与 pairView 互斥；显式导航互斥同 pair——进会话收矩阵（无返回联动）。
   *  关闭即回到此前选中上下文（选中三元组未变）。 */
  function openSubagentView(subId: string, name?: string, parentId?: string) {
    pairView.value = null;
    trackingViewVisible.value = false;
    subagentView.value = { subId, ...(name ? { name } : {}), ...(parentId ? { parentId } : {}) };
  }
  function closeSubagentView() { subagentView.value = null; }
  function toggleDrawer() { drawerVisible.value = !drawerVisible.value; }
  function closeDrawer() { drawerVisible.value = false; }

  /** 切换右侧区域（aside 席位开合；与会话共存，不影响 Agent 列表） */
  function toggleAux() {
    if (auxVisible.value) {
      auxVisible.value = false;
    } else {
      openAux();
    }
  }
  /** 展开右侧区域（切换条按钮「点非当选区」路径：选区置位 + 展开）。
   *  无专属舒适宽的选区（prompt/tasks/timers/tracking/workspace 等）以
   *  缺省宽 DEFAULT_AUX（280）展开——窄面板更舒服，主区保留最大空间；
   *  用户拖调/意图铺开后沿用已调宽（auxWidth !== DEFAULT_AUX 即已调）。 */
  function openAux() {
    auxVisible.value = true;
  }
  /** 显式选择 aux 选区（切换条按钮点击；null = 回落谓词选举）——写回持久化（刷新保持） */
  function selectAuxPanel(id: string | null) {
    auxPanel.value = id;
    persistAuxPanel(id);
  }

  // ── 通用 aux 意图通道（宽屏直达选区的统一机制；C1 收敛——取代
  //    previewIntent/usageIntent 双轨）：seq 计数 + 目标选区。消费面 =
  //    各域行常驻 overlay 宿主组件 watch 此意图（不能住行插件——插件级
  //    watch 绑死建立时的 active pinia 实例，踩坑锚见 usage 行注释）。
  //    宽度形态单源住 def.comfyWidth（注册处声明）——意图消费统一走
  //    applyAuxPanelWidth(panelId) 解析：'half' 半屏 / number 固定宽 /
  //    缺省窄面板 280。 **/
  const auxIntent = ref(0);
  const auxIntentPanel = ref('');
  function sendAuxIntent(panel: string) {
    auxIntentPanel.value = panel;
    auxIntent.value += 1;
  }

  /** 按选区 id 重整宽度（选区切换路径统一入口——壳 togglePanel 与意图
   *  消费共用）：查该选区的 comfyWidth 声明（auxSidebarViews def）铺开
   *  对应形态；无声明 = 窄面板回缺省 280。消除了「全局 auxWidth 沿用
   *  上一选区铺开值」的串宽（preview 半屏被 tasks 沿用的事故）。 */
  function applyAuxPanelWidth(panelId: string) {
    let comfy: number | 'half' | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const def = auxSidebarPanelDefs().find((d) => d.id === panelId);
      comfy = def?.comfyWidth;
    } catch { /* runtime 缺席（测试）——按窄面板处理 */ }
    if (comfy === 'half') {
      auxWidth.value = Math.max(MIN_AUX, Math.min(halfScreenWidth(), maxAux()));
    } else if (typeof comfy === 'number') {
      auxWidth.value = Math.max(MIN_AUX, Math.min(comfy, maxAux()));
    } else {
      auxWidth.value = DEFAULT_AUX;
    }
    persistAuxWidth(auxWidth.value);
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

  /** Token 用量入口（宽窄分派）：宽屏写通用 aux 意图；窄屏维持 Modal 弹窗。
   *  舒适宽住 def.comfyWidth（840）——意图只指选区，宽度由 applyAuxPanelWidth 单源解析。 */
  function openTokenUsage() {
    if (isNarrow()) {
      tokenUsageVisible.value = true;
    } else {
      sendAuxIntent('usage');
    }
  }
  function closeTokenUsage() { tokenUsageVisible.value = false; }

  /** 打开 System Prompt 预览：宽屏 = aux 'prompt' 选区（对照会话阅读）；
   *  窄屏 = Modal 弹窗。内容请求仍由触发方经 chatStore 发起（选区宿主
   *  watch systemPromptOpen 族取数——与 modal 同源）。 */
  function openSystemPrompt(agentName = '') {
    systemPromptAgentName.value = agentName;
    if (isNarrow()) {
      systemPromptOpen.value = true;
    } else {
      sendAuxIntent('prompt'); // 默认宽（纯文本阅读无需铺开）
    }
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

  function openPreview(filePath: string, fallbackAgentId = '', conversationId = '') {
    previewFilePath.value = filePath;
    previewFallbackAgentId.value = fallbackAgentId;
    previewConversationId.value = conversationId;
    if (isNarrow()) {
      // 窄屏：Modal 全屏形态（原行为不变）
      previewVisible.value = true;
    } else {
      // 宽屏：预览意图（舒适宽 'half' 住 def——applyAuxPanelWidth 单源解析）
      previewIntentFallback.value = fallbackAgentId;
      previewIntentConversationId.value = conversationId;
      sendAuxIntent('preview');
    }
  }
  function closePreview() {
    previewVisible.value = false;
    previewFilePath.value = '';
    previewFallbackAgentId.value = '';
    previewConversationId.value = '';
  }

  // ── 拖拽 resize（列表 / aside 方向相反）──
  const resizing = ref(false);
  let resizeKind: 'primary' | 'aux' = 'primary';
  let resizeStartX = 0;
  let resizeStartW = 0;
  /** 主栏让位标志：aux 超宽收起主栏时置真——区分「让位收起」与「用户手动
   *  收起」（活动栏 toggle 语义同——下次展开照常；标志只供诊断/测试断言） */
  const primaryYielded = ref(false);

  /** 双击把手：还原默认宽度（primary 260 / aux 280——与初始缺省同源常量） */
  function resetWidth(kind: 'primary' | 'aux') {
    if (kind === 'primary') {
      const maxWidth = window.innerWidth - 48 - MIN_CHAT;
      primaryWidth.value = Math.min(DEFAULT_PRIMARY, maxWidth);
    } else {
      auxWidth.value = DEFAULT_AUX;
    }
  }

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
      // handle 在 aside 区域左缘：右移 = 区域变窄（上限随视口走——maxAux）
      auxWidth.value = Math.max(MIN_AUX, Math.min(resizeStartW - delta, maxAux()));
      // 超宽让位：aux 拖过视口 30% → 收起主侧边栏（主区让位——见
      // auxYieldAt 注释）。只收不展（拖回窄宽不自动展开主栏——
      // 恢复走用户显式动作：活动栏图标点击）
      if (!isNarrow() && auxWidth.value > auxYieldAt()) {
        if (primaryVisible.value) {
          primaryVisible.value = false;
          primaryYielded.value = true;
        }
      }
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
    trackingViewVisible, pairView, subagentView,
    auxVisible, auxWidth, auxPanel,
    globalSettingsVisible, settingsAgentTarget, settingsSectionTarget, agentEditorDirty,
    tokenUsageVisible, versionVisible,
    auxIntent, auxIntentPanel, applyAuxPanelWidth,
    systemPromptOpen, systemPromptAgentName,
    previewVisible, previewFilePath, previewFallbackAgentId,
    previewConversationId,
    previewIntentFallback, previewIntentConversationId,
    // 动作
    isNarrow, togglePrimary, openPrimaryPanel, openTrackingView, closeTrackingView, auxOpenTracking, openTimers,
    openPairView, closePairView, openSubagentView, closeSubagentView, exitOverlays,
    toggleDrawer, closeDrawer, toggleAux, openAux, selectAuxPanel,
    openAgentSettings, openGlobalSettings, closeSettings,
    openTokenUsage, closeTokenUsage, openSystemPrompt, closeSystemPrompt,
    openVersion, closeVersion,
    openPreview, closePreview,
    // resize
    resizing, startResize, resetWidth, primaryYielded,
  };
});

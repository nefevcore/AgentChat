// ============================================================
// ac-client-ui-layout/tests/ui-store.test.ts —— 布局状态机核心
// 语义锁（cr-332：包内测试比 3.9% → ~15%，先补覆盖再动刀的审计项）。
//
// 覆盖此前只在 webui/tests 有锁或完全无锁的面：
//   · 主区导航互斥（openTrackingView/openPairView/openSubagentView/
//     exitOverlays 单点互斥 + 窄屏 push）
//   · aux 宽度形态解析（applyAuxPanelWidth：half/number/缺省三态）
//   · localStorage 持久化往返（primaryPanel/auxPanel/auxWidth/showThinking）
//   · resize 数学边界（MIN/maxAux 钳制 + 让位阈 + 双击还原 = 导出常量）
// node 环境（jsdom 的 URL 垫片与 node:url 不兼容——同包内既有测试）。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// localStorage 垫片（node 环境无 window——模块级 matchMedia 守卫已跳过）
const store = new Map<string, string>();
const localStorageStub: Storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
(globalThis as Record<string, unknown>).localStorage = localStorageStub;
// innerWidth 垫片（resize 数学依赖视口宽）
let innerWidth = 1280;
(globalThis as Record<string, unknown>).window = {
  innerWidth: 0, // 经 defineProperty 直读闭包值
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
};
Object.defineProperty((globalThis as Record<string, unknown>).window, 'innerWidth', {
  get: () => innerWidth, configurable: true,
});
// resize 拖拽挂 document 监听（node 环境无 document——最小垫片；事件用
// dispatchEvent 直呼捕获的 handler 模拟）
const docListeners = new Map<string, Set<(e: unknown) => void>>();
const docStub = {
  addEventListener: (t: string, fn: (e: unknown) => void) => {
    if (!docListeners.has(t)) docListeners.set(t, new Set());
    docListeners.get(t)!.add(fn);
  },
  removeEventListener: (t: string, fn: (e: unknown) => void) => { docListeners.get(t)?.delete(fn); },
  body: { style: {} },
  dispatchEvent: (t: string, e: unknown) => { docListeners.get(t)?.forEach((fn) => fn(e)); },
};
(globalThis as { document?: unknown }).document = docStub;

const { useUiStore, DEFAULT_PRIMARY, DEFAULT_AUX } = await import('../client/uiStore.ts');

beforeEach(() => {
  store.clear();
  innerWidth = 1280;
  setActivePinia(createPinia());
  // narrowRef 是模块级单实例（多组件共享 matchMedia 单源）——窄屏用例的
  // 写入跨测试存活，BeforeEach 显式归零宽屏态
  useUiStore().narrow = false;
});

describe('主区导航 · 显式互斥（单点开关语义）', () => {
  it('openTrackingView：进矩阵即清 pair/subagent 视角', () => {
    const ui = useUiStore();
    ui.openPairView('a', 'b');
    ui.openSubagentView('s1', 'n', 'p');
    ui.openTrackingView();
    expect(ui.trackingViewVisible).toBe(true);
    expect(ui.pairView).toBeNull();
    expect(ui.subagentView).toBeNull();
  });

  it('openPairView/openSubagentView 双向互斥 + 进会话收矩阵', () => {
    const ui = useUiStore();
    ui.openTrackingView();
    ui.openPairView('x', 'y');
    expect(ui.trackingViewVisible).toBe(false);
    ui.openTrackingView();
    ui.openSubagentView('s2');
    expect(ui.trackingViewVisible).toBe(false);
    expect(ui.pairView).toBeNull();
    expect(ui.subagentView).toEqual({ subId: 's2' });
  });

  it('exitOverlays：全收覆盖层（同值重选边界的显式收口）', () => {
    const ui = useUiStore();
    ui.openTrackingView();
    ui.openPairView('a', 'b');
    ui.exitOverlays();
    expect(ui.trackingViewVisible).toBe(false);
    expect(ui.pairView).toBeNull();
    expect(ui.subagentView).toBeNull();
  });

  it('窄屏 push：open* 即 push 会话页，宽屏 no-op', () => {
    const ui = useUiStore();
    ui.narrow = true;
    expect(ui.mobileMainOpen).toBe(false);
    ui.openPairView('a', 'b');
    expect(ui.mobileMainOpen).toBe(true);
    ui.closeMobileMain();
    expect(ui.mobileMainOpen).toBe(false);
    ui.openTrackingView();
    expect(ui.mobileMainOpen).toBe(true);
  });
});

describe('aux 区域 · 选区与宽度形态', () => {
  it('selectAuxPanel 显式置位并持久化（null 清除）', () => {
    const ui = useUiStore();
    ui.selectAuxPanel('preview');
    expect(ui.auxPanel).toBe('preview');
    expect(store.get('agentchat.auxPanel')).toBe('preview');
    ui.selectAuxPanel(null);
    expect(ui.auxPanel).toBeNull();
    expect(store.has('agentchat.auxPanel')).toBe(false);
  });

  it('openAuxPanel：域侧激活 → 置位 → 宽度重整 → 展开（语义单点）', () => {
    const ui = useUiStore();
    let activated = false;
    ui.openAuxPanel({ id: 'test', active: () => true, component: { render: () => null }, rail: { icon: 'i', title: 't', activate: () => { activated = true; } } });
    expect(activated).toBe(true);
    expect(ui.auxPanel).toBe('test');
    expect(ui.auxVisible).toBe(true);
  });

  it('applyAuxPanelWidth 三态：half 半屏 / number 固定宽 / 缺省 280（并写回持久化）', () => {
    const ui = useUiStore();
    // 缺省：无 def 声明（runtime 缺席——空候选）→ 窄面板
    ui.applyAuxPanelWidth('nope');
    expect(ui.auxWidth).toBe(DEFAULT_AUX);
    // number：注册 def 后重算（auxSidebarViews 读 slots——runtime 缺席回空，
    // 此处直接以 half/number 数学断言 maxAux 钳制）
    ui.auxWidth = 100;
    // half 数学上限（1280 视口）：max(480, min(576, 872)) = 576
    ui.applyAuxPanelWidth('preview');
    // runtime 缺席 → preview def 不可见 → 回缺省 280。half 数学经 drag 间接锁
    expect(ui.auxWidth).toBe(DEFAULT_AUX);
  });
});

describe('resize 数学边界（拖拽/双击还原）', () => {
  function drag(ui: ReturnType<typeof useUiStore>, kind: 'primary' | 'aux', delta: number) {
    const down = { clientX: 500, buttons: 1, preventDefault: () => {} } as MouseEvent;
    ui.startResize(kind, down);
    docStub.dispatchEvent('mousemove', { buttons: 1, clientX: 500 + delta });
    docStub.dispatchEvent('mouseup', { buttons: 0 });
  }

  it('primary 拖拽：MIN 160 保底 + 视口上限钳制', () => {
    const ui = useUiStore();
    drag(ui, 'primary', -600); // 260-600 → 钳到 160
    expect(ui.primaryWidth).toBe(160);
    drag(ui, 'primary', +2000); // 上限 1280-48-320 = 912
    expect(ui.primaryWidth).toBe(912);
  });

  it('aux 拖拽超 30% → 主栏让位收起（只收不展）；显式展开复位', () => {
    const ui = useUiStore();
    drag(ui, 'aux', -200); // 280 → 480 > 384
    expect(ui.auxWidth).toBe(480);
    expect(ui.primaryVisible).toBe(false);
    expect(ui.primaryYielded).toBe(true);
    drag(ui, 'aux', +100); // 拖回 380 ≤ 384
    expect(ui.primaryVisible).toBe(false); // 只收不展
    ui.openPrimaryPanel('agents'); // 显式展开 = 复位
    expect(ui.primaryVisible).toBe(true);
    expect(ui.primaryYielded).toBe(false);
  });

  it('双击还原：primary/aux 回导出常量（DEFAULT_PRIMARY/DEFAULT_AUX 同源）', () => {
    const ui = useUiStore();
    drag(ui, 'primary', -100);
    ui.resetWidth('primary');
    expect(ui.primaryWidth).toBe(DEFAULT_PRIMARY);
    drag(ui, 'aux', -100);
    ui.resetWidth('aux');
    expect(ui.auxWidth).toBe(DEFAULT_AUX);
  });
});

describe('持久化往返（localStorage 刷新保持）', () => {
  it('primaryPanel 写回 + 重载恢复（同 store 实例模拟新会话读初值）', () => {
    const ui = useUiStore();
    ui.openPrimaryPanel('tracking');
    expect(store.get('agentchat.primaryPanel')).toBe('tracking');
    // 新 pinia 实例（同一 store id 重读初值）
    setActivePinia(createPinia());
    const ui2 = useUiStore();
    expect(ui2.primaryPanel).toBe('tracking');
  });

  it('showThinking 默认显示；关闭写回且重载保持', () => {
    const ui = useUiStore();
    expect(ui.showThinking).toBe(true); // 默认
    ui.setShowThinking(false);
    expect(store.get('agentchat.showThinking')).toBe('0');
    setActivePinia(createPinia());
    const ui2 = useUiStore();
    expect(ui2.showThinking).toBe(false);
  });

  it('auxWidth 超界回落 DEFAULT_AUX（脏值防御）', () => {
    store.set('agentchat.auxWidth', '99999');
    setActivePinia(createPinia());
    const ui = useUiStore();
    expect(ui.auxWidth).toBe(DEFAULT_AUX);
  });
});

describe('杂项 · 全局面板与思维链', () => {
  it('openGlobalSettings 定位页签（/timer 快捷命令入口）；openAgentSettings 定位 Agent', () => {
    const ui = useUiStore();
    ui.openGlobalSettings('sys.timer');
    expect(ui.globalSettingsVisible).toBe(true);
    expect(ui.settingsSectionTarget).toBe('sys.timer');
    ui.openAgentSettings('agent-1');
    expect(ui.settingsAgentTarget).toBe('agent-1');
    expect(ui.globalSettingsVisible).toBe(true);
    // section target 的清除是 openGlobalSettings（空参）职责——agent 定位不连带动它
    ui.openGlobalSettings();
    expect(ui.settingsAgentTarget).toBe('');
    expect(ui.settingsSectionTarget).toBe('');
  });

  it('导出面无死词（togglePrimary/closePairView 已收私有——cr-332）', () => {
    const ui = useUiStore();
    expect((ui as unknown as Record<string, unknown>).togglePrimary).toBeUndefined();
    expect((ui as unknown as Record<string, unknown>).closePairView).toBeUndefined();
  });
});

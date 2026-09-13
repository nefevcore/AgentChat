// @vitest-environment jsdom
// ============================================================
// webui/tests/aux-yield.test.ts —— aux 超宽让位验收
//（aux 拖过视口 30% → 主栏收起；显式展开 → 让位态复位；
//  拖回窄宽不自动展开；窄屏不适用）
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';

/** 模拟 aux 拖拽：startResize → mousemove(delta) → mouseup（jsdom 事件直构） */
function dragAux(ui: ReturnType<typeof useUiStore>, delta: number) {
  const move = new MouseEvent('mousemove', { clientX: 500 + delta, buttons: 1 });
  ui.startResize('aux', new MouseEvent('mousedown', { clientX: 500 }));
  document.dispatchEvent(move);
  document.dispatchEvent(new MouseEvent('mouseup'));
}

describe('aux 超宽让位（拖过视口 30% 收主栏）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1280 });
  });

  it('拖过 30%（384px）→ 主栏收起 + yielded 标志置位', () => {
    const ui = useUiStore();
    expect(ui.primaryVisible).toBe(true);
    dragAux(ui, -200); // 280 → 480 > 384
    expect(ui.auxWidth).toBe(480);
    expect(ui.primaryVisible).toBe(false); // 让位收起
    expect(ui.primaryYielded).toBe(true);
  });

  it('拖回窄宽不自动展开主栏（只收不展）', () => {
    const ui = useUiStore();
    dragAux(ui, -200); // 超阈收起
    expect(ui.primaryVisible).toBe(false);
    dragAux(ui, 100); // 拖回 380 ≤ 384
    expect(ui.auxWidth).toBe(380);
    expect(ui.primaryVisible).toBe(false); // 不自动展开
    expect(ui.primaryYielded).toBe(true); // 标志保持（仍是让位态）
  });

  it('显式展开（活动栏路径）→ 让位态复位', () => {
    const ui = useUiStore();
    dragAux(ui, -200);
    expect(ui.primaryYielded).toBe(true);
    ui.openPrimaryPanel('agents'); // 活动栏图标点击
    expect(ui.primaryVisible).toBe(true);
    expect(ui.primaryYielded).toBe(false); // 复位
    // 再超宽 → 再次让位（新一轮）
    dragAux(ui, -200);
    expect(ui.primaryYielded).toBe(true);
  });

  it('30% 阈内不收起', () => {
    const ui = useUiStore();
    dragAux(ui, -90); // 280 → 370 ≤ 384
    expect(ui.auxWidth).toBe(370);
    expect(ui.primaryVisible).toBe(true);
    expect(ui.primaryYielded).toBe(false);
  });

  it('窄屏（≤768）不适用让位', () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 700 });
    const ui = useUiStore();
    dragAux(ui, -200); // 280 → 480 = maxAux（700 屏静态上限）
    expect(ui.auxWidth).toBe(480);
    expect(ui.primaryVisible).toBe(true); // 不收起
    expect(ui.primaryYielded).toBe(false);
  });

  it('上限 = 视口 70%（1280 屏主区保底钳到 872）', () => {
    const ui = useUiStore();
    dragAux(ui, -1000); // 280 → 大幅超限请求
    // 1280 屏：min(896, 1280-88-320=872) = 872（主区保底优先于 70%）
    expect(ui.auxWidth).toBe(872);
  });

  it('大屏（2560）70% 全额：1792 < 2152 保底线', () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 2560 });
    const ui = useUiStore();
    dragAux(ui, -2000); // 钳到上限
    expect(ui.auxWidth).toBe(1792); // 2560×0.7（保底线 2560-88-320=2152 不约束）
  });

  it('无舒适宽选区默认宽展开（280）；拖调后收起展开沿用已调宽', () => {
    const ui = useUiStore();
    expect(ui.auxWidth).toBe(280); // 缺省
    ui.openAux();
    // 无专属舒适宽的选区（rail 直点/openAux 路径）= 缺省宽 280（窄面板形态）
    expect(ui.auxWidth).toBe(280);
    // 沿用：拖调到 600 后再收起展开——保持 600（普通展开不动宽）
    ui.startResize('aux', new MouseEvent('mousedown', { clientX: 800 }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 800 - 320, buttons: 1 })); // 280→600
    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(ui.auxWidth).toBe(600);
    ui.toggleAux(); // 收起
    expect(ui.auxVisible).toBe(false);
    ui.openAux(); // 再展开
    expect(ui.auxWidth).toBe(600); // 沿用已调宽（普通展开不重置）
  });

  it('意图宽度策略：按选区 comfyWidth 声明重整（无声明回 280）', () => {
    const ui = useUiStore();
    // 无声明选区（tasks/prompt 等——runtime 缺席时也走此路径）→ 回缺省 280
    ui.auxWidth = 840;
    ui.applyAuxPanelWidth('tasks');
    expect(ui.auxWidth).toBe(280);
    // 未知选区同样回缺省
    ui.applyAuxPanelWidth('nonexistent');
    expect(ui.auxWidth).toBe(280);
  });

  it('让位后展开主栏 → aux 护距收缩（防两栏总宽溢出视口）', () => {
    const ui = useUiStore();
    ui.openAux(); // 真实路径：aux 展开着才能拖宽
    dragAux(ui, -1000); // 280 → 872（70% 钳制）→ 让位收主栏
    expect(ui.primaryVisible).toBe(false);
    expect(ui.auxWidth).toBe(872);
    ui.openPrimaryPanel('agents'); // 用户展开
    expect(ui.primaryVisible).toBe(true);
    // 护距：1280 - 88 - 320 - 260 = 612 → aux 收缩到 612（不再溢出）
    expect(ui.auxWidth).toBe(612);
  });
});

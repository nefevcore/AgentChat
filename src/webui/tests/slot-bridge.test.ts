// @vitest-environment jsdom
// ============================================================
// webui/tests/slot-bridge.test.ts —— D13 双轨转发单测（M27 S1）
//
// 旧注册面（core/extensions/slots.ts 三件 + 三注册表）→ SlotRegistry
// 转发；消费面签名不变；无运行时（pre-boot/单测）注册面可诊断。
//（jsdom：bootWebuiRuntime 装配 layout 件引入完整 AppFrame 视图链）
// ============================================================
import { describe, it, expect } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { resetClientRuntime } from '../src/runtime/clientRuntime';
import {
  registerSettingsTab,
  registerAgentSettingsTab,
  registerActivityBarAction,
  sortedSettingsTabs,
  sortedAgentSettingsTabs,
  sortedActivityBarActions,
  resolveTabProps,
  type SettingsTabDef,
  type ActivityBarActionDef,
} from '../src/core/extensions/slots';
import { registerPerspective } from '../src/core/registry/perspectives';
import { registerMessageView, resolveMessageView } from '../src/core/registry/messageViews';
import { registerToolResultView, resolveToolResultView } from '../src/core/registry/toolResultViews';

const C = defineComponent({ render: () => null });

describe('D13 双轨 · slots.ts 三件（挂载点改经 SlotRegistry）', () => {
  // 首位：未装配分支（后续用例装配后不再复现）
  it('未装配运行时：注册面抛可诊断错误（装配顺序防线）；读面安全回落空', () => {
    resetClientRuntime();
    expect(() => registerSettingsTab({ id: 'z', label: 'z', component: C })).toThrowError(/装配/);
    expect(sortedSettingsTabs.value).toEqual([]);
  });

  it('register* 转发进 SlotRegistry；sorted* computed 读回同一份数据（含 order 轴）', async () => {
    await bootWebuiRuntime();
    const tabA: SettingsTabDef = { id: 'a', label: '页签 A', component: C, order: 20 };
    const tabB: SettingsTabDef = { id: 'b', label: '页签 B', component: C, order: 10 };
    const off1 = registerSettingsTab(tabA);
    const off2 = registerSettingsTab(tabB);
    await nextTick();
    expect(sortedSettingsTabs.value.map((t) => t.id)).toEqual(['b', 'a']);
    off2();
    await nextTick();
    expect(sortedSettingsTabs.value.map((t) => t.id)).toEqual(['a']);
    off1();

    registerAgentSettingsTab({ id: 'x', label: 'X', component: C });
    await nextTick();
    expect(sortedAgentSettingsTabs.value.map((t) => t.id)).toEqual(['x']);

    const act: ActivityBarActionDef = { id: 'act', label: '动作', icon: 'smile', onClick: () => {} };
    const offAct = registerActivityBarAction(act);
    await nextTick();
    expect(sortedActivityBarActions.value.map((a) => a.id)).toEqual(['act']);
    offAct();
    await nextTick();
    expect(sortedActivityBarActions.value).toEqual([]);
  });

  it('同 id 替换幂等；resolveTabProps 语义不变', async () => {
    await bootWebuiRuntime();
    registerSettingsTab({ id: 't', label: 'v1', component: C, props: { k: 1 } });
    registerSettingsTab({ id: 't', label: 'v2', component: C, props: { k: 2 } });
    await nextTick();
    expect(sortedSettingsTabs.value.length).toBe(1);
    expect(sortedSettingsTabs.value[0].label).toBe('v2');
    const t = sortedSettingsTabs.value[0];
    expect(resolveTabProps(t, { base: true })).toEqual({ base: true, k: 2 });
    expect(resolveTabProps({ ...t, props: (base) => ({ fromBase: base.base }) }, { base: 9 })).toEqual({ base: 9, fromBase: 9 });
  });
});

describe('D13 双轨 · 三注册表（转发声明面，消费面不变）', () => {
  it('registerPerspective 双轨：注册表照常 + main:perspective 席位同轨出现/消失', async () => {
    const { ctx } = await bootWebuiRuntime();
    const off = registerPerspective({ id: 'probe', label: '探测', active: () => false, component: C });
    expect(ctx.slots.entries('main:perspective').map((e) => e.id)).toContain('probe');
    off();
    expect(ctx.slots.entries('main:perspective').map((e) => e.id)).not.toContain('probe');
  });

  it('registerMessageView / registerToolResultView 转发 + 消费面解析语义不变', async () => {
    const { ctx } = await bootWebuiRuntime();
    const offMsg = registerMessageView({ id: 'probe-view', match: () => false, renderer: C });
    expect(ctx.slots.entries('message:final-view').map((e) => e.id)).toContain('probe-view');
    offMsg();
    expect(ctx.slots.entries('message:final-view').map((e) => e.id)).not.toContain('probe-view');

    const offTool = registerToolResultView('probe_tool', C, { priority: 5 });
    expect(ctx.slots.entries('tool-card:result-view').map((e) => e.id)).toContain('probe_tool');
    expect(resolveToolResultView('probe_tool')).toBe(C);
    offTool();
    expect(resolveToolResultView('probe_tool')).toBeNull();
    expect(resolveMessageView.name).toBe('resolveMessageView'); // 消费面词汇原位
  });
});

describe('D13 别名账本（owning 基础件声明——M27.2-1 hostLedger 代持退役）', () => {
  it('六项组件类别名席位全部声明且 public（第三方可声明子集）', async () => {
    const { ctx } = await bootWebuiRuntime();
    const expectPublic = ['main:perspective', 'tool-card:result-view', 'message:final-view', 'settings:main-view', 'agent-pane:tab', 'activity-bar:plugin-actions'];
    for (const key of expectPublic) {
      const decl = ctx.slots.declOf(key);
      expect(decl, key).toBeDefined();
      expect(decl?.public, key).toBe(true);
    }
  });

  it('布局区域 seat（含三预留）+ root 由 layout 基础件声明；root 出厂占据', async () => {
    const { ctx } = await bootWebuiRuntime();
    // 2026-11 语义定整：sidebar→activity-bar、list-panel→primary-sidebar、
    // aside→aux-sidebar（VSCode 布局同款词汇）+ menu-bar/bottom-panel/
    // status-bar 三预留席（declare 占名，无 outlet）
    for (const key of ['activity-bar', 'primary-sidebar', 'main', 'aux-sidebar', 'menu-bar', 'bottom-panel', 'status-bar', 'overlay', 'root']) {
      expect(ctx.slots.declOf(key), key).toBeDefined();
    }
    expect(ctx.slots.entries('root').map((e) => e.id)).toEqual(['webui-base-layout.app-frame']);
    expect(ctx.slots.snapshot().factorySealed).toBe(true);
  });
});

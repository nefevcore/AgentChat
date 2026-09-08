// @vitest-environment jsdom
// ============================================================
// webui/tests/d9-registry-consolidation.test.ts —— D9 三注册表收编验收
//
// perspectives / messageViews / toolResultViews 数据面 = SlotRegistry
//（keyed seat 的 meta.def）；解析面签名不变；内置批次经基础件出厂注册；
// 无 runtime 回落旧数组（既有测试族零改动语义）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { defineComponent } from 'vue';
import { createClient } from 'ac-client-runtime';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { toolClientPlugin } from 'ac-client-ui-tool/client';
import { conversationClientPlugin } from 'ac-client-ui-conversation/client';
import {
  bindToolResultViews,
  resolveToolResultView,
  registerToolResultView,
  SLOT_KEY as TOOL_SLOT,
} from '../src/core/registry/toolResultViews';
import {
  bindMessageViews,
  resolveMessageView,
  SLOT_KEY as MSG_SLOT,
} from '../src/core/registry/messageViews';
import {
  bindPerspectives,
  registerPerspective,
  activePerspective,
  SLOT_KEY as PERSP_SLOT,
} from '../src/core/registry/perspectives';
import { resetClientRuntime } from '../src/runtime/clientRuntime';

const C = defineComponent({ render: () => null });

describe('D9 收编 · toolResultViews → tool-card:result-view keyed seat', () => {
  it('内置卡经 tool 基础件出厂注册；解析面从 slot 注册表读取', async () => {
    const { ctx } = await bootWebuiRuntime();
    bindToolResultViews();
    await ctx.plugin(toolClientPlugin);
    // 精确名 + 正则族 + 优先级覆盖全链（解析面语义不变，数据面 = slots）
    expect(resolveToolResultView('bash')).toBeTruthy();
    expect(resolveToolResultView('fetch_webpage')).toBeTruthy();
    // 内置 11 卡（todo 随 UI 行走迁 ac-client-ui-todo/client——M27.1）
    expect(ctx.slots.entries(TOOL_SLOT).length).toBeGreaterThanOrEqual(9);
    // todo 卡 = 行 client 贡献（boot graph 装载后在场；此处裸 boot 不含行）
    expect(resolveToolResultView('todo')).toBeNull();
    // 动态覆盖：同 match 后注册者替换（priority 语义原样）
    const off = registerToolResultView('bash', C, { priority: 5 });
    expect(resolveToolResultView('bash')).toBe(C);
    off();
    expect(resolveToolResultView('bash')).not.toBe(C);
  });

  it('无 runtime：回落旧数组（既有 tool-result-visibility 测试族语义）', () => {
    resetClientRuntime();
    const off = registerToolResultView('solo_tool', C);
    expect(resolveToolResultView('solo_tool')).toBe(C);
    off();
    expect(resolveToolResultView('solo_tool')).toBeNull();
  });
});

describe('D9 收编 · messageViews → message:final-view keyed seat', () => {
  it('内置 user/assistant 经 conversation 基础件出厂注册；解析面语义不变', async () => {
    const { ctx } = await bootWebuiRuntime(); // ③ 已装 conversation（webuiBoot）
    bindMessageViews();
    expect(ctx.slots.entries(MSG_SLOT).map((e) => e.id).sort()).toEqual(['assistant', 'user']);
    expect(resolveMessageView({ agent_id: 'user' } as never, null)).toBe('user');
    expect(resolveMessageView({ agent_id: 'helper' } as never, null)).toBe('assistant');
  });
});

describe('D9 收编 · perspectives → main:perspective 视角专座', () => {
  it('注册直达 slot 注册表；active 谓词选举在解析面；卸载级联（含 redirectTo）', async () => {
    const { ctx } = await bootWebuiRuntime();
    bindPerspectives();
    let fellBack = false;
    const off = registerPerspective({
      id: 'probe',
      label: '探测',
      active: () => true,
      component: C,
      redirectTo: () => { fellBack = true; },
    });
    expect(ctx.slots.entries(PERSP_SLOT).map((e) => e.id)).toContain('probe');
    expect(activePerspective()?.id).toBe('probe');
    off();
    expect(ctx.slots.entries(PERSP_SLOT).map((e) => e.id)).not.toContain('probe');
    expect(fellBack).toBe(true); // D18-3 卸载导航
  });

  it('无 runtime：回落旧数组（layout-unload 等 D18 用例的独立形态）', () => {
    resetClientRuntime();
    const off = registerPerspective({ id: 'solo', label: '独立', active: () => true, component: C });
    expect(activePerspective()?.id).toBe('solo');
    off();
    expect(activePerspective()).toBeNull();
  });
});

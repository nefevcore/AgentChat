// ============================================================
// ac-client-ui-layout/tests/aux-election.test.ts —— aux 选区选举
// 解析面 + auxBadgeText 徽章格式化（cr-332 并源后的语义锁）。
//
// 选举面此前只在 webui/tests（clients-workspaces/aux-badge）有锁——
// 包内零覆盖；徽章格式化本次并源（AuxActivityBar/MobileMoreSheet 双份
// 收单源），行为锁随迁。node 环境。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  auxSidebarPanelDefs, electedAuxSidebarPanel, auxSidebarRailDefs, auxBadgeText,
  safeAuxSidebarPanelProps, AUX_SIDEBAR_SLOT,
  type AuxSidebarPanelDef,
} from '../client/auxSidebarViews.ts';
import { createClient, setClientRuntime } from 'ac-client-runtime';
import type { ClientContext } from 'ac-client-runtime';

async function makeCtx(): Promise<ClientContext> {
  const ctx = await createClient();
  setClientRuntime(ctx);
  ctx.slots.declare({ key: 'aux-sidebar', kind: 'list', elect: true });
  return ctx;
}

function makeDef(partial: Partial<AuxSidebarPanelDef> & { id: string }): AuxSidebarPanelDef {
  return { active: () => false, component: { render: () => null }, ...partial };
}

describe('aux 选区选举（显式优先 + 谓词回落）', () => {
  it('显式选区 active 即当选；失活回落谓词选举（order 小者先）', async () => {
    const ctx = await makeCtx();
    let wsActive = true; // workspace 恒真兜底（order 大）
    const offA = ctx.slots.register(AUX_SIDEBAR_SLOT, {
      id: 'a', component: { render: () => null }, order: 100,
      meta: { def: makeDef({ id: 'a', order: 100, active: () => false, rail: { icon: 'i', title: 'A' } }) },
    });
    const offW = ctx.slots.register(AUX_SIDEBAR_SLOT, {
      id: 'workspace', component: { render: () => null }, order: 900,
      meta: { def: makeDef({ id: 'workspace', order: 900, active: () => wsActive }) },
    });
    // 无显式：谓词选举——a 失活，workspace 兜底当选
    expect(electedAuxSidebarPanel(null)?.id).toBe('workspace');
    // 显式 a：a active=false → 不可当选，回落 workspace
    expect(electedAuxSidebarPanel('a')?.id).toBe('workspace');
    // 显式 workspace
    expect(electedAuxSidebarPanel('workspace')?.id).toBe('workspace');
    // 全部失活 → 区域整体消失（内在于选举）
    wsActive = false;
    expect(electedAuxSidebarPanel(null)).toBeNull();
    offA(); offW();
  });

  it('候选过滤：缺 active/component 的坏 def 不入候选；行卸载 → 候选清空', async () => {
    const ctx = await makeCtx();
    const off = ctx.slots.register(AUX_SIDEBAR_SLOT, {
      id: 'broken', component: { render: () => null },
      meta: { def: { id: 'broken' } as AuxSidebarPanelDef }, // 无 active/component
    });
    expect(auxSidebarPanelDefs()).toHaveLength(0);
    off();
    expect(auxSidebarPanelDefs()).toHaveLength(0);
  });

  it('rail 清单：available 谓词控可见（缺省恒真）；无 rail 不入栏', async () => {
    const ctx = await makeCtx();
    let visible = true;
    const offA = ctx.slots.register(AUX_SIDEBAR_SLOT, {
      id: 'a', component: { render: () => null },
      meta: { def: makeDef({ id: 'a', active: () => true, rail: { icon: 'i', title: 'A' }, available: () => visible }) },
    });
    const offB = ctx.slots.register(AUX_SIDEBAR_SLOT, {
      id: 'b', component: { render: () => null },
      meta: { def: makeDef({ id: 'b', active: () => true }) }, // 无 rail
    });
    expect(auxSidebarRailDefs().map((d) => d.id)).toEqual(['a']);
    visible = false;
    expect(auxSidebarRailDefs()).toHaveLength(0);
    offA(); offB();
  });

  it('安全求值：active 抛错 = 失去资格不击穿；props 抛错 = 空 props', async () => {
    const ctx = await makeCtx();
    const warn = await (async () => {
      const { vi } = await import('vitest');
      return vi.spyOn(console, 'warn').mockImplementation(() => {});
    })();
    const off = ctx.slots.register(AUX_SIDEBAR_SLOT, {
      id: 'boom', component: { render: () => null }, order: 1,
      meta: { def: makeDef({
        id: 'boom', order: 1,
        active: () => { throw new Error('bad'); },
        props: () => { throw new Error('bad props'); },
      }) },
    });
    expect(electedAuxSidebarPanel(null)).toBeNull(); // 抛错 def 只失去资格
    const p = safeAuxSidebarPanelProps(auxSidebarPanelDefs()[0]);
    expect(p).toEqual({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    off();
  });
});

describe('auxBadgeText（徽章格式化单源——AuxActivityBar/MobileMoreSheet 共用）', () => {
  const def = (badge?: () => number | string | null): AuxSidebarPanelDef =>
    makeDef({ id: 'x', rail: { icon: 'i', title: 'x', ...(badge ? { badge } : {}) } });

  it('0/null/undefined/空串 = 不渲染；数字 >99 封顶 99+；文本透传', () => {
    expect(auxBadgeText(def(() => 3))).toBe('3');
    expect(auxBadgeText(def(() => 0))).toBe('');
    expect(auxBadgeText(def(() => null))).toBe('');
    expect(auxBadgeText(def(() => ''))).toBe('');
    expect(auxBadgeText(def(() => 127))).toBe('99+');
    expect(auxBadgeText(def(() => '√'))).toBe('√');
    expect(auxBadgeText(def(() => undefined as unknown as null))).toBe(''); // undefined 入参防御
  });

  it('数字 99 不封顶、100 封顶（边界值）；无 badge 声明 = 空串', () => {
    expect(auxBadgeText(def(() => 99))).toBe('99');
    expect(auxBadgeText(def(() => 100))).toBe('99+');
    expect(auxBadgeText(def())).toBe('');
    expect(auxBadgeText(def(() => undefined as unknown as null))).toBe(''); // undefined 入参防御
  });

  it('badge() 抛错 = 不渲染（缺陷 def 不击穿），warn 留痕', async () => {
    const { vi } = await import('vitest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(auxBadgeText(def(() => { throw new Error('bad'); }))).toBe('');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

// ============================================================
// ac-client-ui-layout/tests/registerView.test.ts —— 视角挂载
// 公开入口（B3 批）：main/aux 两轴选举面的包外注册门面语义锁。
// node 环境（同 aux-election.test 模式——createClient + setClientRuntime）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { registerView } from '../client/registerView.ts';
import { mainViewDefs, activeMainView } from '../client/mainViews.ts';
import { auxSidebarPanelDefs, auxSidebarRailDefs } from '../client/auxSidebarViews.ts';
import { createClient, setClientRuntime } from 'ac-client-runtime';
import type { ClientContext } from 'ac-client-runtime';

async function makeCtx(): Promise<ClientContext> {
  const ctx = await createClient();
  setClientRuntime(ctx);
  ctx.slots.declare({ key: 'main', kind: 'list', elect: true });
  ctx.slots.declare({ key: 'aux-sidebar', kind: 'list', elect: true });
  return ctx;
}

const comp = { render: () => null } as never;

describe('registerView（B3 视角挂载门面）', () => {
  it('aux 视角：def 入候选清单 + rail 资产（label→title、缺省 icon）+ disposer 撤销', async () => {
    const ctx = await makeCtx();
    const off = registerView(ctx, { region: 'aux', id: 'acme', label: 'Acme 面板', component: comp });
    const defs = auxSidebarPanelDefs();
    expect(defs.some((d) => d.id === 'acme')).toBe(true);
    const def = defs.find((d) => d.id === 'acme')!;
    expect(def.rail?.title).toBe('Acme 面板');
    expect(def.rail?.icon).toBe('app-window');
    expect(def.active()).toBe(true); // active 缺省恒真
    expect(auxSidebarRailDefs().some((d) => d.id === 'acme')).toBe(true); // rail 资产齐全 → 切换条可见
    // entry id 词形 view.<id>（诊断面可辨）
    expect(ctx.slots.entries('aux-sidebar').some((e) => e.id === 'view.acme')).toBe(true);
    off();
    expect(auxSidebarPanelDefs().some((d) => d.id === 'acme')).toBe(false);
  });

  it('main 视角：def 入候选 + 缺省 order 100 与 chat 平局不抢占（先注册者胜）', async () => {
    const ctx = await makeCtx();
    // 先注册出厂兜底（模拟 chat——出厂装配先于通道装载）
    const offChat = ctx.slots.register('main', {
      id: 'webui-base-layout.perspective-host', component: comp, order: 100,
      meta: { def: { id: 'chat', order: 100, active: () => true, component: comp } },
    });
    // 第三方视角缺省 order 100 + active 恒真——平局按注册序 chat 恒胜
    const off = registerView(ctx, { region: 'main', id: 'third', component: comp });
    expect(mainViewDefs().map((d) => d.id)).toContain('third');
    expect(activeMainView()?.id).toBe('chat');
    // 显式 order 抢占（第三方主区视图的当选路径）
    off();
    const off2 = registerView(ctx, { region: 'main', id: 'third', component: comp, order: 50 });
    expect(activeMainView()?.id).toBe('third');
    off2(); offChat();
  });

  it('坏形状 fail-loud：id 词形非法；component 缺席由 SlotCore fail-closed 兜住', async () => {
    const ctx = await makeCtx();
    expect(() => registerView(ctx, { region: 'aux', id: 'Bad_Id', component: comp })).toThrow(/id/);
    // region 是字面量联合（类型面约束）——JS 边界值走 SlotCore 字面量参数
    // 兜底；component 缺席由 register 面 fail-closed（非数据席位必填）
    expect(() => registerView(ctx, { region: 'aux', id: 'x', component: undefined as never })).toThrow(/component/);
  });
});

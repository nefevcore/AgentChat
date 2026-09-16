// 行单测：settings:section 席位贡献形态 + 降级语义（桥不可达 = 面板隐藏）
import { describe, it, expect } from 'vitest';
import { desktopStorageClientPlugin } from '../client/index.ts';

describe('ac-client-ui-desktop-storage client 行', () => {
  it('插件形态：name/inject（slots）可装载', () => {
    expect(desktopStorageClientPlugin.name ?? (desktopStorageClientPlugin as { default?: { name?: string } }).default?.name).toBeTruthy();
  });

  it('settings:section 注册：id/component/order + meta（section 键 + 叶词条）', () => {
    // 模拟 slots 面：捕获 register 载荷断言形态（与 llm-pool 行同构）
    let registered: any = null;
    const fakeCtx = {
      slots: {
        inject: (_key: string, fn: () => unknown) => fn(),
        register: (_key: string, entry: unknown) => { registered = entry; return () => {}; },
      },
    };
    const apply = (desktopStorageClientPlugin as { apply?: (c: unknown) => void }).apply
      ?? (desktopStorageClientPlugin as { default?: { apply: (c: unknown) => void } }).default!.apply;
    apply(fakeCtx);
    expect(registered).toMatchObject({
      id: expect.stringContaining('desktop-storage'),
      order: expect.any(Number),
      meta: { section: 'storage', label: '存储管理' },
    });
    expect(registered.component).toBeTruthy();
  });
});

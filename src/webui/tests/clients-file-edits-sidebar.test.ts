// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-file-edits-sidebar.test.ts —— 文件编辑
// aux 选区验收（conversation 行：webui-base-conversation.file-edits）
//
// 选区注册 + rail 资产 + active 显式选区驱动 + 意图通道消费。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';

describe('文件编辑 aux 选区注册（conversation 行）', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('行装载 → aux-sidebar 含 file-edits 条目（rail + keepAlive + comfyWidth half）；卸载 → 消失', async () => {
    const { ctx, fibers } = await bootWebuiRuntime(); // boot 序已装 conversation
    setActivePinia(createPinia()); // boot 后重置——def 谓词读本用例 pinia
    const ids = (key: string) => ctx.slots.entries(key).map((e) => e.id);
    expect(ids('aux-sidebar')).toContain('webui-base-conversation.file-edits');
    const entry = ctx.slots.entries('aux-sidebar').find((e) => e.id === 'webui-base-conversation.file-edits')!;
    const def = entry.meta?.def as {
      id: string; order?: number; comfyWidth?: number | 'half'; keepAlive?: boolean;
      active: () => boolean; rail?: { icon: string; title: string };
    };
    expect(def.id).toBe('file-edits');
    expect(def.comfyWidth).toBe('half'); // diff 对照半屏
    expect(def.keepAlive).toBe(true); // 展开态跨让位保留
    expect(def.rail).toEqual({ icon: 'file-diff', title: '文件编辑', activate: expect.any(Function) });
    // active 谓词 = 显式选区驱动
    expect(def.active()).toBe(false);
    useUiStore().selectAuxPanel('file-edits');
    expect(def.active()).toBe(true);
    await fibers.conversation.dispose();
    expect(ids('aux-sidebar')).not.toContain('webui-base-conversation.file-edits');
  });

  it('意图通道：sendAuxIntent("file-edits") → FileEditsPanelHost 消费（选区 + 半屏展开）', async () => {
    const { ctx } = await bootWebuiRuntime(); // boot 序已装 conversation
    // 挂载选区宿主（意图消费面——AuxSidebarHost keepAlive 常驻；测试直接 mount 同款）
    const { createApp, h, nextTick } = await import('vue');
    const { CLIENT_CONTEXT_KEY } = await import('ac-client-runtime');
    const FileEditsPanelHost = (await import('ac-client-ui-conversation/client/FileEditsPanelHost.vue')).default;
    const pinia = createPinia();
    setActivePinia(pinia);
    const host = document.createElement('div');
    const app = createApp({ render: () => h(FileEditsPanelHost) });
    app.use(pinia);
    app.provide(CLIENT_CONTEXT_KEY, ctx);
    app.mount(host);
    await nextTick();

    const ui = useUiStore();
    // sendAuxIntent 未在 store 返回面公开——直接写意图载体同款语义
    //（auxIntentPanel + auxIntent 自增 = sendAuxIntent 的实现体）
    ui.auxIntentPanel = 'file-edits';
    ui.auxIntent += 1;
    expect(ui.auxIntentPanel).toBe('file-edits');
    await nextTick();
    expect(ui.auxPanel).toBe('file-edits'); // 意图消费 → 显式选区
    expect(ui.auxVisible).toBe(true); // 区域展开
    expect(ui.auxWidth).toBeGreaterThan(280); // 'half' 铺开（1024 屏半屏 ≈ 448）
    app.unmount();
  });
});

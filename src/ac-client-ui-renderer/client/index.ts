// ============================================================
// ac-client-ui-renderer/client/index.ts —— renderer 基础件 client 半边
//（M27.2-2 出包之二：原 webui/src/clients/base/renderer.ts 迁入升行包）
//
// 职责（ownership §3.2 落点）：
//   · Vue 渲染适配 boot-once 安装（ctx.slots.install——原 main.ts ② 步
//     内联动作收编为插件；slotRender/SlotOutlet 渲染资产 owning 件）；
//   · markdown 管线/气泡通用渲染资产的 owning 件（useMarkdown/
//     abap-hljs/logger/ScrollableViewport 随件迁入本包 client/）；
//   · ctx.vueRenderer 服务面：renderSlot = ctx 级渲染入口（main.ts
//     app.mount 的 root 面）。
//
// 可摘除性：renderer 是渲染地基（install boot-once）——本件卸载即
// boot graph base 行集变更 → 整页重载（M27.2 §3.2 裁决）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { createVueRenderer, type VueSlotRenderer } from './vueRenderer';

export interface RendererClientOptions {
  /** 预留（对齐 cordis Service 构造签名形态） */
}

export class VueRendererService extends Service {
  /** install 后的渲染器实例（boot-once 契约的 Vue 实现） */
  readonly renderer: VueSlotRenderer;

  static inject = ['slots'];

  constructor(ctx: Context, options: RendererClientOptions = {}) {
    super(ctx, 'vueRenderer');
    void options;
    this.renderer = createVueRenderer(ctx as ClientContext);
    (ctx as ClientContext).slots.install(this.renderer);
  }

  /** ctx 级渲染入口（main.ts app.mount 的 root 面委托至此） */
  renderSlot(key: string, data?: unknown) {
    return this.renderer.renderSlot(key, data);
  }
}

declare module 'ac-client-runtime' {
  interface ClientContext {
    /** renderer 基础件：Vue slot 渲染器（renderSlot = ctx 级渲染入口） */
    vueRenderer: VueRendererService;
  }
}

/** renderer 基础件 client 半边插件（boot graph base 阶段装载；宿主半边见 src/index.ts） */
export const rendererClientPlugin = clientPlugin({
  name: 'ac-client-ui-renderer.client',
  inject: ['slots'],
  async apply(ctx: ClientContext) {
    await ctx.plugin(VueRendererService);
  },
});

export default rendererClientPlugin;

// ============================================================
// webui/src/clients/base/renderer.ts —— renderer 基础件
//（M27.2-1：基础七件之五——先 webui 内插件化，出包随 M27.2-2）
//
// 职责（ownership §3.2 落点）：
//   · Vue 渲染适配 boot-once 安装（ctx.slots.install——原 main.ts ② 步
//     内联动作收编为插件；slotRender/SlotOutlet 渲染资产 owning 件）；
//   · markdown 管线/气泡通用渲染资产的 owning 件（M27.2-2 出包时随件
//     迁出 webui——第一步先立 ownership 锚点）；
//   · ctx.vueRenderer 服务面：renderSlot = ctx 级渲染入口（main.ts
//     app.mount 的 root 面）。
//
// 可摘除性：renderer 是渲染地基（install boot-once）——本件卸载后
// 渲染面不可重建（M27.2 §3.2 裁决点：base 行变更需整页重载）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { createVueRenderer, type VueSlotRenderer } from '../../runtime/vueRenderer';

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

/** renderer 基础件（装配序列第③步首件——先于一切视图件） */
export const rendererBasePlugin = clientPlugin({
  name: 'webui-base-renderer',
  inject: ['slots'],
  async apply(ctx: ClientContext) {
    await ctx.plugin(VueRendererService);
  },
});

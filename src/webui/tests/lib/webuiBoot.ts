// ============================================================
// webui/tests/lib/webuiBoot.ts —— 测试用 webui 装配序列（与 main.ts 同款）
//
// 供 slot bridge 双轨 / layout 卸载 / 门控等 S1+ 测试复用。
// ============================================================
import { createClient, clientPlugin, type ClientContext, type Fiber } from 'ac-client-runtime';
import { setClientRuntime } from '../../src/runtime/clientRuntime';
import { initExtensionSlots } from '../../src/core/extensions/slots';
import { bindPerspectives } from '../../src/core/registry/perspectives';
import { bindMessageViews } from '../../src/core/registry/messageViews';
import { bindToolResultViews } from '../../src/core/registry/toolResultViews';
import { rendererClientPlugin } from 'ac-client-ui-renderer/client';
import { conversationBasePlugin } from '../../src/clients/base/conversation';
import { toolClientPlugin } from 'ac-client-ui-tool/client';
import { layoutBasePlugin } from '../../src/clients/base/layout';
import { sidebarBasePlugin } from '../../src/clients/base/sidebar';
import { settingsBasePlugin } from '../../src/clients/base/settings';
// jsdom 垫（matchMedia 等）住 scripts/vitest-setup-chdir.mjs（先于模块链求值）

export interface BootedWebui {
  ctx: ClientContext;
  fibers: { renderer: Fiber; conversation: Fiber; tool: Fiber; layout: Fiber; sidebar: Fiber; settings: Fiber };
}

/** 与 main.ts 装配序列一致（①②[renderer]③[conversation+tool+layout+
 *  sidebar+settings] + 封印；④⑤ 由用例按需追加——域行 client 测试
 * 另需 rpc 桩见 lib/rpcStub；hostLedger 已退役——席位由 owning 件自声明） */
export async function bootWebuiRuntime(): Promise<BootedWebui> {
  const ctx = await createClient(); // ①
  setClientRuntime(ctx);
  initExtensionSlots(ctx);
  bindPerspectives(); // D9 收编解析面绑定（与 main.ts 装配序列一致）
  bindMessageViews();
  bindToolResultViews();
  const renderer = await ctx.plugin(rendererClientPlugin); // ②（boot-once 安装）
  const conversation = await ctx.plugin(conversationBasePlugin); // sessions（行 client 协调面）
  const tool = await ctx.plugin(toolClientPlugin); // 内置工具卡 + tool-card 席位
  const layout = await ctx.plugin(layoutBasePlugin);
  const sidebar = await ctx.plugin(sidebarBasePlugin); // 活动栏/三面板出厂贡献
  const settings = await ctx.plugin(settingsBasePlugin); // 设置面板 + settings 席位
  ctx.slots.sealFactory();
  return { ctx, fibers: { renderer, conversation, tool, layout, sidebar, settings } };
}

/** D18-1 bail 拒绝监听（宿主/权限面形态：一行拒绝一切活动项） */
export const denyPerspective = clientPlugin({
  name: 'test-deny-perspective',
  apply(ctx: ClientContext) {
    ctx.on('activity/perspective', () => true);
  },
});

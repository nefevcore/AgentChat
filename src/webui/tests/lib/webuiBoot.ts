// ============================================================
// webui/tests/lib/webuiBoot.ts —— 测试用 webui 装配序列（与 main.ts 同款）
//
// 供 slot bridge 双轨 / layout 卸载 / 门控等 S1+ 测试复用。
// ============================================================
import { createClient, clientPlugin, type ClientContext, type Fiber } from 'ac-client-runtime';
import { createVueRenderer } from '../../src/runtime/vueRenderer';
import { setClientRuntime } from '../../src/runtime/clientRuntime';
import { initExtensionSlots } from '../../src/core/extensions/slots';
import { bindPerspectives } from '../../src/core/registry/perspectives';
import { bindMessageViews } from '../../src/core/registry/messageViews';
import { bindToolResultViews } from '../../src/core/registry/toolResultViews';
import { hostLedgerPlugin } from '../../src/runtime/hostLedger';
import { conversationBasePlugin } from '../../src/clients/base/conversation';
import { layoutBasePlugin } from '../../src/clients/base/layout';
// jsdom 垫（matchMedia 等）住 scripts/vitest-setup-chdir.mjs（先于模块链求值）

export interface BootedWebui {
  ctx: ClientContext;
  fibers: { hostLedger: Fiber; conversation: Fiber; layout: Fiber };
}

/** 与 main.ts 装配序列一致（①②③[hostLedger+conversation+layout] + 封印；
 *  ④⑤ 由用例按需追加——域行 client 测试另需 rpc 桩见 lib/rpcStub） */
export async function bootWebuiRuntime(): Promise<BootedWebui> {
  const ctx = await createClient(); // ①
  setClientRuntime(ctx);
  initExtensionSlots(ctx);
  bindPerspectives(); // D9 收编解析面绑定（与 main.ts 装配序列一致）
  bindMessageViews();
  bindToolResultViews();
  const renderer = createVueRenderer(ctx); // ②
  ctx.slots.install(renderer);
  const hostLedger = await ctx.plugin(hostLedgerPlugin); // ③
  const conversation = await ctx.plugin(conversationBasePlugin); // sessions（行 client 协调面）
  const layout = await ctx.plugin(layoutBasePlugin);
  ctx.slots.sealFactory();
  return { ctx, fibers: { hostLedger, conversation, layout } };
}

/** D18-1 bail 拒绝监听（宿主/权限面形态：一行拒绝一切活动项） */
export const denyPerspective = clientPlugin({
  name: 'test-deny-perspective',
  apply(ctx: ClientContext) {
    ctx.on('activity/perspective', () => true);
  },
});

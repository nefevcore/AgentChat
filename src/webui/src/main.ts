// ============================================================
// webui/src/main.ts —— 装配序列（M27 S1 重写，§0.1 终态）
//
// main.ts 无任何可视面知识——可视面 = 插件（layout 基础件占 root）。
//   ① 建 client runtime：浏览器端 cordis 实例 + SlotRegistry（ac-client-runtime）
//   ② install(vueRenderer)            // boot-once，唯一渲染器安装口
//   ③ 装配基础插件集合（S1：hostLedger + layout 首件；S2 起七件齐）
//      + 出厂封印（D3：root 防线）
//   ④ 按 boot graph 装配域插件          // S1 暂无（S2 in-bundle → S3 行包 client/）
//   ⑤ 第三方 UI 插件 install(ctx)       // 既有 /ui-plugin/ 通道（bridge 双轨，D13）
//   ⑥ app.mount(renderSlot('root'))    // 唯一 ctx 级渲染入口
// ============================================================

import './assets/main.css';
import './assets/markdown.css';
import 'katex/dist/katex.min.css';
import 'markdown-it-texmath/css/texmath.css';
// L0 设计令牌（星群 × 工坊 双主题）—— UI 库地基
import '@agentchat/webui-kit/tokens.css';
// L0.5 公共行（A 语言扁平行——清单卡收敛底座，C8）
import '@agentchat/webui-kit/row.css';
// L0.6 徽章语言（状态/标签/类型徽记三族一底——2026-10 统一裁决）
import '@agentchat/webui-kit/badge.css';

import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { CLIENT_CONTEXT_KEY, createClient } from 'ac-client-runtime';
import { setClientRuntime } from './runtime/clientRuntime';
import { initExtensionSlots } from './core/extensions/slots';
import { bindPerspectives } from './core/registry/perspectives';
import { bindMessageViews } from './core/registry/messageViews';
import { bindToolResultViews } from './core/registry/toolResultViews';
import { layoutBasePlugin } from './clients/base/layout';
import { settingsBasePlugin } from './clients/base/settings';
import { rpcHostPlugin } from './runtime/rpcClient';
import { applyBootGraph } from './runtime/bootGraph';
import { initUiExtensionHost } from './core/extensions';

async function boot(): Promise<void> {
  // M27 S0 验收入口：?slots-demo 查询参 → 纯 slot 装配玩具界面（临时）
  if (new URLSearchParams(location.search).has('slots-demo')) {
    const m = await import('./runtime/slots-demo.ts');
    await m.mountSlotsDemo('#app');
    return;
  }

  // pinia：基础件内部实现细节（D10——不强推全退；域插件用 store 座位/服务内 reactive）
  const pinia = createPinia();
  // 装配期门面可解析（chat 启动链经 useAgentStore 门面 → roster core）
  setActivePinia(pinia);

  // ① 建 client runtime（内置 slots/objects 服务；插件装载 await 后可解析）
  const ctx = await createClient();
  setClientRuntime(ctx);
  initExtensionSlots(ctx); // 旧 slot 注册面 → SlotRegistry 双轨转发
  // D9 收编解析面绑定：三注册表（perspectives/messageViews/toolResultViews）
  bindPerspectives();
  bindMessageViews();
  bindToolResultViews();

  // ③ 装配基础插件集合（出厂批次——封印前）：conversation（内置
  // 消息视图）+ rpc 宿主面（行 client 半边的 RPC 契约实现）+ layout +
  // settings（设置面板）
  // ——M27.2-2 起 base 基础件逐件出包（theme/renderer/tool/sidebar/
  // conversation 经 boot graph base 阶段装载——活动栏/三面板壳/渲染
  // 地基/工具卡/会话视图）；席位全部由 owning 件自声明（hostLedger
  // 代持退役；三面板壳 shim 已随 ac-client-ui-sidebar 包走）
  await ctx.plugin(rpcHostPlugin);
  await ctx.plugin(layoutBasePlugin);
  // M27.2-1：settings 件（设置面板 + settings 两席位自代持转正）
  await ctx.plugin(settingsBasePlugin);
  // M27.2-2：base 阶段基础件（boot graph phase:'base'——封印前批次，
  // root 席位/渲染地基类基础件可安全占据；已出包：theme/renderer/tool/sidebar）
  await applyBootGraph('base');
  // 出厂封印（D3）：此后 root 席位的动态注册一律拒绝
  ctx.slots.sealFactory();

  // ④ domain 阶段域行（M27 S3/D7）：宿主下发行 client 半边清单
  //（行卸载 → 不在图 → 前端消费面一并消失，D19）。六域全部独立
  // ac-client-ui-* 前端行（M27.1 收口）——本步纯 boot graph 装载
  await applyBootGraph('domain');
  // 会话服务启动链（wire 订阅 + 名册恢复；幂等——与旧 store 首用行为等价）
  ctx.sessions.init();

  // ⑥ 组装应用壳：root 席位经 renderSlot 渲染；ctx 注入组件树（D17）
  const app = createApp({
    name: 'AcClientRoot',
    render: () => ctx.vueRenderer.renderSlot('root'),
  });
  app.use(pinia);
  app.provide(CLIENT_CONTEXT_KEY, ctx);

  // ⑤ 第三方 UI 插件（既有 /ui-plugin/ 通道；注册面经 bridge 双轨转发 SlotRegistry）
  void initUiExtensionHost();

  app.mount('#app');
}

void boot();

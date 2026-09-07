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
import './ui/tokens.css';
// L0.5 公共行（A 语言扁平行——清单卡收敛底座，C8）
import './ui/row.css';
// L0.6 徽章语言（状态/标签/类型徽记三族一底——2026-10 统一裁决）
import './ui/badge.css';

import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { CLIENT_CONTEXT_KEY, createClient } from 'ac-client-runtime';
import { createVueRenderer } from './runtime/vueRenderer';
import { setClientRuntime } from './runtime/clientRuntime';
import { initExtensionSlots } from './core/extensions/slots';
import { bindPerspectives } from './core/registry/perspectives';
import { bindMessageViews } from './core/registry/messageViews';
import { bindToolResultViews } from './core/registry/toolResultViews';
import { hostLedgerPlugin } from './runtime/hostLedger';
import { layoutBasePlugin } from './clients/base/layout';
import { themeBasePlugin } from './clients/base/theme';
import { toolBasePlugin } from './clients/base/tool';
import { conversationBasePlugin } from './clients/base/conversation';
import { rpcHostPlugin } from './runtime/rpcClient';
import { applyBootGraph } from './runtime/bootGraph';
import { jobsDomainPlugin } from './clients/jobs';
import { groupsDomainPlugin } from './clients/groups';
import { singlesDomainPlugin } from './clients/singles';
import { workspacesDomainPlugin } from './clients/workspaces';
import { rosterDomainPlugin } from './clients/roster';
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

  // ② install(vueRenderer)——boot-once 唯一渲染器安装口
  const renderer = createVueRenderer(ctx);
  ctx.slots.install(renderer);

  // ③ 装配基础插件集合（出厂批次——封印前）：宿主声明账本代持 + theme +
  // conversation（内置消息视图）+ tool（内置工具卡）+ rpc 宿主面（行
  // client 半边的 RPC 契约实现）+ layout（theme 先行：html class 应用不依赖视图）
  await ctx.plugin(hostLedgerPlugin);
  await ctx.plugin(themeBasePlugin);
  await ctx.plugin(conversationBasePlugin);
  await ctx.plugin(toolBasePlugin);
  await ctx.plugin(rpcHostPlugin);
  await ctx.plugin(layoutBasePlugin);
  // 出厂封印（D3）：此后 root 席位的动态注册一律拒绝
  ctx.slots.sealFactory();

  // ④ 按 boot graph 装配域插件（M27 S3/D7）：宿主下发行 client 半边清单
  //（行卸载 → 不在图 → 前端消费面一并消失，D19）+ in-bundle 域件
  //（S3 随迁移逐域入行包）
  await applyBootGraph();
  await ctx.plugin(jobsDomainPlugin);
  await ctx.plugin(groupsDomainPlugin);
  await ctx.plugin(singlesDomainPlugin);
  await ctx.plugin(workspacesDomainPlugin);
  await ctx.plugin(rosterDomainPlugin); // 层 2 身份面 + agents 域写面（ctx.roster）
  // 会话服务启动链（wire 订阅 + 名册恢复；幂等——与旧 store 首用行为等价）
  ctx.sessions.init();

  // ⑥ 组装应用壳：root 席位经 renderSlot 渲染；ctx 注入组件树（D17）
  const app = createApp({
    name: 'AcClientRoot',
    render: () => renderer.renderSlot('root'),
  });
  app.use(pinia);
  app.provide(CLIENT_CONTEXT_KEY, ctx);

  // ⑤ 第三方 UI 插件（既有 /ui-plugin/ 通道；注册面经 bridge 双轨转发 SlotRegistry）
  void initUiExtensionHost();

  app.mount('#app');
}

void boot();

// ============================================================
// main.ts —— ui 树浏览器入口（8.5b；装配序列归 boot.ts，本文件只 mount）
//
// 终态 ac-webui 单包 client/ 前端半边的 preview 形态：骨架 3 件 in-bundle
//（import 主线行包 client/），通道条目按 graph 动态装载。rpcWire 真面
//（8.5e）= rpc-wire.ts 单 WS 通道（/ws——主线 wire.ts 平移）。
// ============================================================
// 全局基础样式层（≡ 主线 src/webui/src/main.ts 导入面）：布局别名 + markdown +
// kit L0 四层——tokens/row/dropdown/badge 正是 kit package.json 的 css 导出全集，
// 缺任一层即对应整族选择器裸奔（cr-577 漏令牌层、cr-673 漏徽章层同源：入口手工
// 维护子集，消费面变化无人对账）。tests/styles.test.ts 锁「导出全集 ⊆ 入口导入」。
import '../../../../src/webui/src/assets/main.css';
import '../../../../src/webui/src/assets/markdown.css';
import '@agentchat/webui-kit/tokens.css';
import '@agentchat/webui-kit/row.css';
import '@agentchat/webui-kit/dropdown.css';
import '@agentchat/webui-kit/badge.css';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { CLIENT_CONTEXT_KEY, setClientRuntime } from 'ac-client-runtime';
import { bindPerspectives } from 'ac-client-ui-layout/client/perspectives.ts';
import { bindMessageViews } from 'ac-client-ui-conversation/client/messageViews.ts';
import { bindToolResultViews } from 'ac-client-ui-tool/client/toolResultViews.ts';
import { bootUiClient } from './boot.ts';
import { wireRpcBrowser } from './rpc-wire.ts';

async function boot(): Promise<void> {
  const pinia = createPinia();
  setActivePinia(pinia);

  const { ctx } = await bootUiClient({ rpcWire: wireRpcBrowser });
  // 装配序列对齐（主线 main.ts 同款——缺此三步则解析面读不到 runtime：
  // perspectives/messageViews/toolResultViews 的 defs() 经 clientRuntime()
  // 取注册表，未 set 时回落空 legacyViews → PerspectiveHost 恒 null（主区空白）；
  // bind* 订阅 slots/changed → 版本计数，视角重解析的响应式轴）。
  // 实例一致性：三模块经 vite 同模块图进宿主 bundle（与骨架件同源），
  // 通道 bundle 内的副本由 importmap 深路径键挡在共享面之外（消费面走宿主实例）。
  setClientRuntime(ctx);
  bindPerspectives();
  bindMessageViews();
  bindToolResultViews();
  // 会话服务启动链（feed.init wire 订阅 + 名册恢复——主线 main.ts ④ 后同款；
  // preview bootUiClient 未做，无此则消息帧不到 feed、发消息无 ack 路径）
  ctx.sessions.init();

  const app = createApp({
    name: 'AcUiRoot',
    render: () => ctx.vueRenderer.renderSlot('root'),
  });
  app.use(pinia);
  app.provide(CLIENT_CONTEXT_KEY, ctx);
  app.mount('#app');
  // splash 撤除（主线 index.html 同款语义：boot 完成 = 应用可交互）
  document.getElementById('boot-splash')?.remove();
  // 连接拉起：无会话态下 feed 等消费者未启动，wire 惰性连接永不建立而
  // 断连横幅常驻——boot 尾主动探活一次（stats 空调用即拉起 WS）
  void ctx.rpc.call('conversation/stats').catch(() => undefined);
}

void boot();

// ============================================================
// ac-client-ui-web/client/index.ts —— 工具卡行 client 半边（M28 P2 §2.2）
//
// 贡献面：tool-card:result-view keyed seat——行卸载 → def 消失 →
// resolve 回落默认文本渲染。web_search + 浏览器族正则（11 工具）
// → ToolResultWeb（ac-web-tools 镜像，§2.2）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';

// 卡片组件（异步：node 环境消费本模块不求值 .vue 视图链）
const ToolResultWeb = defineAsyncComponent(() => import('./ToolResult/ToolResultWeb.vue'));

/** 浏览器工具族正则（与原 tool 内置批次口径一致——fetch_webpage 等 11 工具） */
const BROWSER_FAMILY = /^(fetch_webpage|open_browser_page|navigate_page|read_page|click_element|type_in_page|screenshot_page|hover_element|drag_element|handle_dialog|run_playwright_code)$/;

/** web 工具卡行 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const webCardClientPlugin = clientPlugin({
  name: 'ac-client-ui-web.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    ctx.slots.inject('tool-card:result-view', () =>
      ctx.slots.register('tool-card:result-view', {
        id: 'web_search',
        component: ToolResultWeb,
        meta: { def: { match: 'web_search', component: ToolResultWeb, priority: 0, label: '网络搜索', icon: 'globe' } },
      }),
    );
    ctx.slots.inject('tool-card:result-view', () =>
      ctx.slots.register('tool-card:result-view', {
        id: String(BROWSER_FAMILY),
        component: ToolResultWeb,
        meta: { def: { match: BROWSER_FAMILY, component: ToolResultWeb, priority: 0, icon: 'monitor' } },
      }),
    );
  },
});

export default webCardClientPlugin;

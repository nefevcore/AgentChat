// ============================================================
// ac-client-ui-browser/client/index.ts —— 工具卡行 client 半边（M28 P2 §2.2）
//
// 贡献面：tool-card:result-view keyed seat——行卸载 → def 消失 →
// resolve 回落默认文本渲染。browser → ToolResultBrowser
//（多动作 tab / steps 批量；browser 域镜像，§2.2）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';

// 卡片组件（异步：node 环境消费本模块不求值 .vue 视图链）
const ToolResultBrowser = defineAsyncComponent(() => import('./ToolResult/ToolResultBrowser.vue'));

/** browser 工具卡行 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const browserCardClientPlugin = clientPlugin({
  name: 'ac-client-ui-browser.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    ctx.slots.inject('tool-card:result-view', () =>
      ctx.slots.register('tool-card:result-view', {
        id: 'browser',
        component: ToolResultBrowser,
        meta: { def: { match: 'browser', component: ToolResultBrowser, priority: 0, label: '浏览器', icon: 'monitor' } },
      }),
    );
  },
});

export default browserCardClientPlugin;

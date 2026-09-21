// ============================================================
// ac-client-ui-web/client/index.ts —— 工具卡行 client 半边（M28 P2 §2.2）
//
// 贡献面：
//   · tool-card:result-view keyed seat——行卸载 → def 消失 →
//     resolve 回落默认文本渲染。web_search + 浏览器族正则（11 工具）
//     → ToolResultWeb（ac-web-tools 镜像，§2.2）；
//   · aux-sidebar 选区（id 'search'）——多 tab 搜索结果面板：卡片
//     点击（宽屏）→ searchTabs.openTab + 显式选区 + 展开（write 卡
//     直达 preview 的同款交互）；tab 状态住 pinia store，选区卸载
//     不丢——重开恢复（同 preview 选区姿势）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';
import type { AuxSidebarPanelDef } from 'ac-client-ui-layout/client/auxSidebarViews.ts';
import { useWebSearchTabsStore, openSearchPanel } from './searchTabs.ts';

// 卡片组件（异步：node 环境消费本模块不求值 .vue 视图链）
const ToolResultWeb = defineAsyncComponent(() => import('./ToolResult/ToolResultWeb.vue'));
// aux 搜索选区宿主（异步同上）
const WebSearchPanelHostAsync = defineAsyncComponent(() => import('./WebSearchPanelHost.vue'));

/** 浏览器工具族正则（与原 tool 内置批次口径一致——fetch_webpage 等 11 工具） */
const BROWSER_FAMILY = /^(fetch_webpage|open_browser_page|navigate_page|read_page|click_element|type_in_page|screenshot_page|hover_element|drag_element|handle_dialog|run_playwright_code)$/;

/** web 工具卡行 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const webCardClientPlugin = clientPlugin({
  name: 'ac-client-ui-web.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    // 搜索结果选区（aux-sidebar 席位 keyed 选举条目）：active =
    // searchTabs.panelOpen 域内意愿〔卡片点击 openTab 置真〕；rail
    // activate = 重开上次 tab 清单；available = 有 tab 才露按钮（同
    // preview 选区——空面板无内容可开）。volatile 卸载 + store 常驻
    // = 轻体回载（tab 快照不丢）。
    ctx.slots.inject('aux-sidebar', () =>
      ctx.slots.register('aux-sidebar', {
        id: 'webui-domain-web.search',
        component: WebSearchPanelHostAsync,
        meta: {
          def: {
            id: 'search',
            order: 12, // rail 序：文件预览(10)之后、Token 用量(15)之前——高频参考面
            comfyWidth: 480, // 舒适宽：搜索结果列表 + 摘要一屏可读（窄于 preview 半屏）
            active: () => {
              try { return useWebSearchTabsStore().panelOpen; } catch { return false; }
            },
            component: WebSearchPanelHostAsync,
            rail: {
              icon: 'search',
              title: '网络搜索',
              activate: () => {
                const tabs = useWebSearchTabsStore();
                if (tabs.count === 0) return; // 空 tab 无内容可开——按钮无效
                tabs.openPanel();
              },
            },
            available: () => {
              try { return useWebSearchTabsStore().count > 0; } catch { return false; }
            },
          } satisfies AuxSidebarPanelDef,
        },
      }),
    );
    ctx.slots.inject('tool-card:result-view', () =>
      ctx.slots.register('tool-card:result-view', {
        id: 'web_search',
        component: ToolResultWeb,
        // onLabelClick：Label 直达搜索侧边栏（2026-12 R7 相位整改——原
        // base 行 ToolMessage 直 import 本行 openSearchPanel 成 R7 违例；
        // 动作住域行 def，base 只经席位钩子调用）
        meta: {
          def: {
            match: 'web_search',
            component: ToolResultWeb,
            priority: 0,
            label: '网络搜索',
            icon: 'globe',
            onLabelClick: (data: Record<string, unknown>) => openSearchPanel(data),
          },
        },
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

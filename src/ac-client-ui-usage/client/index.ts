// ============================================================
// ac-client-ui-usage/client/index.ts —— usage 域前端行 client 半边
//（M28 P1 §4.1 原案：Token 用量面板随域成行；P2：辅助侧边栏选区）
//
// 贡献面：
//   · overlay 席位（id webui-domain-usage.panel；order 96 = 保持原
//     AppFrame overlay DOM 序）——Modal 形态（窄屏 fallback）；
//   · aux-sidebar 选区（id 'usage'，P2 监视常驻面板）——active =
//     auxPanel 显式选区驱动（意图通道 ui.usageIntent → watch 置位
//     'usage' + 展开）；keepAlive = true（图表/筛选状态跨让位保留）；
//     rail 恒可见（用量随时可看，无上下文门槛）。
// 后端行（ac-usage）不在场 → usage/tokens RPC 失败 → 空态降级。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import type { AuxSidebarPanelDef } from 'ac-client-ui-layout/client/auxSidebarViews.ts';

// 用量面板宿主（异步：node 环境消费本模块不求值 .vue 视图链）
const TokenUsageHostAsync = defineAsyncComponent(() => import('./TokenUsageHost.vue'));
// aux 选区宿主（P2 panel 形态）
const TokenUsagePanelHostAsync = defineAsyncComponent(() => import('./TokenUsagePanelHost.vue'));

/** usage 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const usageClientPlugin = clientPlugin({
  name: 'ac-client-ui-usage.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    ctx.slots.inject('overlay', () =>
      ctx.slots.register('overlay', {
        id: 'webui-domain-usage.panel',
        component: TokenUsageHostAsync,
        order: 96,
      }),
    );
    // Token 用量选区（P2：监视常驻——图表/筛选/页签状态保留跨让位）。
    // 意图消费不住本行插件（插件级 watch 会绑死建立时的 active pinia
    // 实例——TokenUsageHost overlay 常驻组件 setup 里 watch 才是 app
    // pinia 同实例；同 FilePreviewHost 模式）
    ctx.slots.inject('aux-sidebar', () =>
      ctx.slots.register('aux-sidebar', {
        id: 'webui-domain-usage.sidebar',
        component: TokenUsagePanelHostAsync,
        meta: {
          def: {
            id: 'usage',
            order: 15, // rail 序：第 2 位（高频监视）
            comfyWidth: 840, // 舒适宽：图表一次看全（意图与 rail 切换统一铺开）
            keepAlive: true, // 曾当选即常驻 v-show——图表状态不因让位丢失
            active: () => {
              try { return useUiStore().auxPanel === 'usage'; } catch { return false; }
            },
            component: TokenUsagePanelHostAsync,
            rail: {
              icon: 'chart-pie',
              title: 'Token 用量',
              activate: () => { /* 意图通道路径自理（TokenUsageHost watch）；rail 点击只置显式选区 */ },
            },
          } satisfies AuxSidebarPanelDef,
        },
      }),
    );
  },
});

export default usageClientPlugin;

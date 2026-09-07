// ============================================================
// webui/src/clients/base/sidebar.ts —— 三面板壳过渡 shim
//（M27.2-2 出包之四的 webui 残留半边）
//
// sidebar 件主体已出包 ac-client-ui-sidebar（活动栏 SidebarHost +
// uiStore + systemApi——boot graph base 阶段装载）。三面板壳
//（ListPanelsHost：agents/sessions/tracking）消费 conversation 域
// store 门面（stores/chat·feed——尚未出包），暂由本 in-bundle shim
// 承载；conversation 件出包后随行迁入 ac-client-ui-sidebar，本
// shim 退役。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import ListPanelsHost from './ListPanelsHost.vue';

/** 三面板壳 shim（list-panel 席位出厂贡献——活动栏贡献已随包走） */
export const sidebarPanelsPlugin = clientPlugin({
  name: 'webui-base-sidebar-panels',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    // 三面板壳（agents/sessions/tracking 三选一）
    ctx.slots.register('list-panel', {
      id: 'webui-base-sidebar.panels',
      component: ListPanelsHost,
    });
  },
});

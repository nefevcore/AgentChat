// ============================================================
// webui/src/clients/base/sidebar.ts —— sidebar 基础件
//（M27.2-1：基础七件之六——先 webui 内插件化，出包随 M27.2-2）
//
// 职责（ownership §3.2 落点）：
//   · Sidebar 动作区/更多菜单（sidebar 席位出厂贡献——SidebarHost 绑线
//     经 ui store 直连）；
//   · 三面板壳（list-panel 席位出厂贡献——agents/sessions/tracking
//     三选一，ListPanelsHost；group/singles 域投影经客户端服务面）。
//
// 可摘除性（D19）：卸载本件 = sidebar/list-panel 两席位的出厂贡献消失
//（席位声明归 layout 件仍在）→ 活动栏与列表面板空态，宿主不残废。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import SidebarHost from './SidebarHost.vue';
import ListPanelsHost from './ListPanelsHost.vue';

/** sidebar 基础件（装配序列第③步：layout 声明席位之后） */
export const sidebarBasePlugin = clientPlugin({
  name: 'webui-base-sidebar',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    // 活动栏宿主（原 AppFrame 内联 SlotOutletItem 内容——同轴默认序）
    ctx.slots.register('sidebar', {
      id: 'webui-base-sidebar.host',
      component: SidebarHost,
    });
    // 三面板壳（agents/sessions/tracking 三选一）
    ctx.slots.register('list-panel', {
      id: 'webui-base-sidebar.panels',
      component: ListPanelsHost,
    });
  },
});

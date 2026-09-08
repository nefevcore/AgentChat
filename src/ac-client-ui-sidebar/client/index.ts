// ============================================================
// ac-client-ui-sidebar/client/index.ts —— sidebar 基础件 client 半边
//（M27.2-2 出包之四：原 webui clients/base/sidebar.ts 升行包；
// M27.2-2 面板壳收尾：三面板壳自 webui in-bundle shim 迁入——shim 退役）
//
// 职责 = 活动栏域（ownership §3.2 落点）：
//   · sidebar 席位出厂贡献（SidebarHost——主题/设置/用量/版本入口 +
//     更多菜单 + sidebar:plugin-actions 贡献面）；
//   · list-panel 席位出厂贡献（ListPanelsHost 三面板壳：agents/
//     sessions 内联 + 域贡献面板经 list-panel:domain 选举席——
//     meta.panel 键，P0-3 首例 tracking = ui-runview 行贡献）；
//   · ui 面板状态 store（pinia，D10）+ 系统小 API（随件资产）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import SidebarHost from './SidebarHost.vue';
import ListPanelsHost from './ListPanelsHost.vue';

// SlotMap 类型化声明：sidebar 基础件拥有的席位词表
declare module 'ac-client-slots' {
  interface SlotMap {
    /** 域面板选举席（ListPanelsHost 内选举——贡献携带 meta.panel 键；M28 P0-3） */
    'list-panel:domain': { kind: 'list' };
  }
}

/** sidebar 基础件 client 半边插件（boot graph base 阶段装载；宿主半边见 src/index.ts） */
export const sidebarClientPlugin = clientPlugin({
  name: 'ac-client-ui-sidebar.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    // 活动栏宿主（sidebar 席位出厂贡献——席位声明归 layout 件）
    ctx.slots.register('sidebar', {
      id: 'webui-base-sidebar.host',
      component: SidebarHost,
    });
    // 三面板壳（list-panel 席位出厂贡献——agents/sessions/tracking 三选一；
    // M27.2-2 面板壳收尾：原 webui-base-sidebar-panels shim 退役，贡献随包走）
    ctx.slots.register('list-panel', {
      id: 'webui-base-sidebar.panels',
      component: ListPanelsHost,
    });
    // 域面板选举席（M28 P0-3）：域行面板贡献登记处——壳按 ui.listPanel
    // 对 meta.panel 选举（不经外层 list-panel outlet 渲染，防叠加）
    ctx.slots.declare({
      key: 'list-panel:domain',
      kind: 'list',
      description: '域面板选举席（ListPanelsHost 按 ui.listPanel × meta.panel 选举渲染；贡献 = 各域行面板，M28 P0-3）',
      ownerProps: {
        // §5.7 移动端行为继承（同 list-panel 席位：左抽屉模式）
        mobileBehavior: 'left-drawer',
        // §5.4 行点击导航语义宿主所有
        rowNavigation: 'host-owned',
      },
    });
  },
});

export default sidebarClientPlugin;

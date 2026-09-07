// ============================================================
// ac-client-ui-sidebar/client/index.ts —— sidebar 基础件 client 半边
//（M27.2-2 出包之四：原 webui clients/base/sidebar.ts 升行包）
//
// 职责 = 活动栏域（ownership §3.2 落点）：
//   · sidebar 席位出厂贡献（SidebarHost——主题/设置/用量/版本入口 +
//     更多菜单 + sidebar:plugin-actions 贡献面）；
//   · ui 面板状态 store（pinia，D10）+ 系统小 API（随件资产）。
// 三面板壳（ListPanelsHost：agents/sessions/tracking）暂留 webui
// in-bundle shim（消费 conversation 域 store 门面——随 conversation
// 件出包后迁入本包）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import SidebarHost from './SidebarHost.vue';

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
  },
});

export default sidebarClientPlugin;

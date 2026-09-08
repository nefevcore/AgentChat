// ============================================================
// ac-client-ui-timer/client/index.ts —— timer 域前端行 client 半边
//（M28 P1 §4.1 原案：视图资产行——TimerPane 供 AgentPane 跨包消费）
// ============================================================
import { clientPlugin } from 'ac-client-runtime';

export { default as TimerPane } from './TimerPane.vue';

/** timer 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const timerClientPlugin = clientPlugin({
  name: 'ac-client-ui-timer.client',
  apply() {
    // 视图资产行：无注册面（TimerPane 静态导出供跨包消费；P2 settings
    // 退化时全局 sys.timer 页签经 settings:main-view 席位贡献落位）
  },
});

export default timerClientPlugin;

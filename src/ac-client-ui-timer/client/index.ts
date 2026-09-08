// ============================================================
// ac-client-ui-timer/client/index.ts —— timer 域前端行 client 半边
//（M28 P1 §4.1 原案：视图资产行；M28 P2 settings 退化收口——全局
// sys.timer 节经 settings:section 选举席贡献〔裁决注记 2 落位〕）
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';

export { default as TimerPane } from './TimerPane.vue';

// 全局定时任务节宿主（异步：node 环境消费本模块不求值 .vue 视图链）
const GlobalTimerHostAsync = defineAsyncComponent(() => import('./GlobalTimerHost.vue'));

/** timer 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const timerClientPlugin = clientPlugin({
  name: 'ac-client-ui-timer.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    // 全局定时任务节（settings:section 选举席贡献——原 SettingsPanel
    // 内联 sys.timer 节 + 编辑弹窗整体迁入）
    ctx.slots.inject('settings:section', () =>
      ctx.slots.register('settings:section', {
        id: 'webui-domain-timer.global',
        component: GlobalTimerHostAsync,
        meta: { section: 'sys.timer' },
      }),
    );
  },
});

export default timerClientPlugin;

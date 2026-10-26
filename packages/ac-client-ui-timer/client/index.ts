// ============================================================
// ac-client-ui-timer/client/index.ts —— timer 域前端行 client 半边
//（M28 P1 §4.1 原案：视图资产行；M28 P2 settings 退化收口；A3 起：
//  定时任务聚合 aux 选区是唯一全局任务入口——settings sys.timer 节
//  撤〔与 aux 面板同组件纯冗余〕；/timer 快捷命令经 ui.openTimers
//  直达选区）
//
// 贡献面：
//   · aux-sidebar 选区（id 'timers'）：Agent 定时器 + 全局任务一屏
//     纵览；active = 显式选区；rail 恒可见。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import type { AuxSidebarPanelDef } from 'ac-client-ui-layout/client/auxSidebarViews.ts';

export { default as TimerPane } from './TimerPane.vue';

// aux 聚合面板宿主（A3；异步：node 环境消费本模块不求值 .vue 视图链）
const TimersPanelHostAsync = defineAsyncComponent(() => import('./TimersPanelHost.vue'));

/** timer 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const timerClientPlugin = clientPlugin({
  name: 'ac-client-ui-timer.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    // 定时任务聚合 aux 选区（A3：Agent 定时器 + 全局任务一屏纵览——
    // 唯一入口：settings sys.timer 节已撤）
    ctx.slots.inject('aux-sidebar', () =>
      ctx.slots.register('aux-sidebar', {
        id: 'webui-domain-timer.sidebar',
        component: TimersPanelHostAsync,
        meta: {
          def: {
            id: 'timers',
            order: 30, // rail 序：第 5 位（低频）
            keepAlive: true, // 编辑中状态常驻
            active: () => {
              try { return useUiStore().auxPanel === 'timers'; } catch { return false; }
            },
            component: TimersPanelHostAsync,
            rail: {
              icon: 'alarm-clock',
              title: '定时任务',
              activate: () => { /* rail 点击置显式选区；内容自理 */ },
            },
          } satisfies AuxSidebarPanelDef,
        },
      }),
    );
  },
});

export default timerClientPlugin;

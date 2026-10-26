// ============================================================
// ac-client-ui-run-nodes/client/index.ts —— 会话节点前端行 client 半边
//（cr-230）
//
// 贡献面：aux-sidebar 选区（id 'run-nodes'）——当前会话 run 骨架面板：
// 每 run 用户消息为节点（时间 + 摘要 + 运行中指示），点击 = reveal 意图
//（主区滚动定位该消息）。数据源 = ctx.sessions feed 投影（conversation
// 基础件），无后端行——行缺席时选区消失，reveal 意图无人消费（静默）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import type { AuxSidebarPanelDef } from 'ac-client-ui-layout/client/auxSidebarViews.ts';

const RunNodesPanelHostAsync = defineAsyncComponent(() => import('./RunNodesPanelHost.vue'));

/** 会话节点域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const runNodesClientPlugin = clientPlugin({
  name: 'ac-client-ui-run-nodes.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    // run 骨架面板选区（cr-230）：监视组位（file-edits 24 与 timers 30
    // 之间）；active = 显式选区；rail 恒可见（当前会话即有骨架可看）
    ctx.slots.inject('aux-sidebar', () =>
      ctx.slots.register('aux-sidebar', {
        id: 'webui-domain-run-nodes.sidebar',
        component: RunNodesPanelHostAsync,
        meta: {
          def: {
            id: 'run-nodes',
            order: 27, // rail 序：监视组（file-edits 24 之后、timers 30 之前）
            active: () => {
              try { return useUiStore().auxPanel === 'run-nodes'; } catch { return false; }
            },
            component: RunNodesPanelHostAsync,
            rail: {
              icon: 'milestone',
              title: '会话节点',
              activate: () => { /* rail 点击置显式选区；内容 feed 驱动自理 */ },
            },
          } satisfies AuxSidebarPanelDef,
        },
      }),
    );
  },
});

export default runNodesClientPlugin;

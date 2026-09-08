// ============================================================
// ac-client-ui-goal/client/index.ts —— goal 域前端行 client 半边
//（M28 P1 §4.1 原案：goal 卡 + goal dock 条随域成行）
//
// 贡献面（goal 域前端消费面——行卸载即一并消失，可摘除性）：
//   · tool-card:result-view keyed seat（id 'goal'）——goal 工具会话流
//     卡片（meta.def 形状对齐 ToolResultViewDef 解析契约：
//     { match, component, priority }）；
//   · tracking:dock-widget list seat（id 'goal'，order 20——DSH dock
//     序 Todo(10) → Goal(20)）——composer 上方长期目标条。
// 后端行（ac-goal）不在场 → goal/get RPC 失败 → fetch null → dock 条
// 静默隐藏（三态空态语义）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';

// 贡献组件（异步：node 环境消费本模块不求值 .vue 视图链）
const ToolResultGoalAsync = defineAsyncComponent(() => import('./ToolResult/ToolResultGoal.vue'));
const GoalDockCardAsync = defineAsyncComponent(() => import('./GoalDockCard.vue'));

/** goal 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const goalClientPlugin = clientPlugin({
  name: 'ac-client-ui-goal.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    // 工具结果卡片（keyed presentation seat——精确名 'goal'，同 id 后
    // 注册者替换；行卸载 → def 消失 → resolve 回落默认文本渲染）
    ctx.slots.inject('tool-card:result-view', () =>
      ctx.slots.register('tool-card:result-view', {
        id: 'goal',
        component: ToolResultGoalAsync,
        meta: { def: { match: 'goal', component: ToolResultGoalAsync, priority: 0, label: '目标管理', icon: 'target' } },
      }),
    );
    // 长期目标 dock 条（list seat；order 20 = DSH dock 序 Goal 在 Todo 后）
    ctx.slots.inject('tracking:dock-widget', () =>
      ctx.slots.register('tracking:dock-widget', {
        id: 'goal',
        component: GoalDockCardAsync,
        order: 20,
      }),
    );
  },
});

export default goalClientPlugin;

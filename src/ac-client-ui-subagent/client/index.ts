// ============================================================
// ac-client-ui-subagent/client/index.ts —— 工具卡行 client 半边（M28 P2 §2.2）
//
// 贡献面：tool-card:result-view keyed seat——行卸载 → def 消失 →
// resolve 回落默认文本渲染。subagent → ToolResultSubagent
//（action 分发清单卡；ac-subagent 镜像，§2.2）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';

// 卡片组件（异步：node 环境消费本模块不求值 .vue 视图链）
const ToolResultSubagent = defineAsyncComponent(() => import('./ToolResult/ToolResultSubagent.vue'));

/** subagent 工具卡行 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const subagentCardClientPlugin = clientPlugin({
  name: 'ac-client-ui-subagent.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    ctx.slots.inject('tool-card:result-view', () =>
      ctx.slots.register('tool-card:result-view', {
        id: 'subagent',
        component: ToolResultSubagent,
        meta: { def: { match: 'subagent', component: ToolResultSubagent, priority: 0, label: '子 Agent 调度', icon: 'bot' } },
      }),
    );
  },
});

export default subagentCardClientPlugin;

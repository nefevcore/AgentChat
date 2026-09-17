// ============================================================
// ac-client-ui-run-code/client/index.ts —— 工具卡行 client 半边（M28 P2 §2.2）
//
// 贡献面：tool-card:result-view keyed seat——行卸载 → def 消失 →
// resolve 回落默认文本渲染。run_code → ToolResultRunCode
// （ac-run-code 镜像；失败态也渲染——错误与执行摘要都在卡内呈现）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';

// 卡片组件（异步：node 环境消费本模块不求值 .vue 视图链）
const ToolResultRunCode = defineAsyncComponent(() => import('./ToolResult/ToolResultRunCode.vue'));

/** run_code 工具卡行 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const runCodeCardClientPlugin = clientPlugin({
  name: 'ac-client-ui-run-code.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    ctx.slots.inject('tool-card:result-view', () =>
      ctx.slots.register('tool-card:result-view', {
        id: 'run_code',
        component: ToolResultRunCode,
        meta: { def: { match: 'run_code', component: ToolResultRunCode, priority: 0, label: '运行程序', icon: 'braces' } },
      }),
    );
  },
});

export default runCodeCardClientPlugin;

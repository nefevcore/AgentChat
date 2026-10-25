// ============================================================
// ac-client-ui-todo/client/index.ts —— todo 域前端行 client 半边
//（M27.1，D19 改裁：ac-client-ui-* 独立 UI 行包）
//
// 装载形态（D7/D19）：经 boot graph 动态装载（dev 期 vite 直服本源码 /
// prod 期构建为行 client 模块块）；数据经 ctx.rpc 契约面调宿主 RPC +
// 宿主事件帧（不 import webui 内部模块）。依赖一律 inject 声明（D6）。
//
// 贡献面（todo 域前端消费面——行卸载即一并消失，可摘除性 D19）：
//   · tool-card:result-view keyed seat（id 'todo'）——todo 工具会话流
//     卡片（meta.def 形状对齐 webui ToolResultViewDef 解析契约：
//     { match, component, priority }）；
//   · conversation:dock-widget list seat（id 'todo'，order 40——dock 序
//     重排 2026-09-13：决策(10) → 审批(20) → 排队(30) → 任务(40) → 目标(50)）
//     ——composer 上方任务清单 dock 卡。
//
// 后端行（ac-todo）不在场 → todo/get RPC 失败 → fetchTodos null →
// dock 卡静默隐藏（三态空态语义）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';

// 贡献组件（异步：node 环境消费本模块不求值 .vue 视图链——cr-454，同
// ac-client-ui-goal 先例；此前 eager import 使 todo-row 测试装载链拖入
// 视图树，单用例 4.5s，全仓并发挤压下 15s 超时 = 审计反复记名的 flake）
const ToolResultTodoAsync = defineAsyncComponent(() => import('./ToolResultTodo.vue'));
const TodoDockCardAsync = defineAsyncComponent(() => import('./TodoDockCard.vue'));

/** todo 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const todoClientPlugin = clientPlugin({
  name: 'ac-client-ui-todo.client',
  inject: ['rpc', 'slots'],
  apply(ctx: ClientContext) {
    // 注册经 slots.inject（声明存活期效应，cr-454——run-code/shell/fs/
    // browser/subagent/goal 七行家族先例）：席位声明在场才注册、塌缩即
    // 回收，不依赖 boot 序上 conversation 基础件先行（裸 register 遇未
    // 声明席位即 UNDECLARED_SLOT 抛错——隐性装载顺序假设）
    ctx.slots.inject('tool-card:result-view', () =>
      ctx.slots.register('tool-card:result-view', {
        id: 'todo',
        component: ToolResultTodoAsync,
        meta: { def: { match: 'todo', component: ToolResultTodoAsync, priority: 0, label: '任务清单', icon: 'clipboard-list' } },
      }),
    );
    // 任务清单 dock 卡（list seat；order 40 = dock 序重排后任务在排队后、
    // 目标前——环境追踪卡下沉，待办行动卡〔决策/审批〕置顶）
    ctx.slots.inject('conversation:dock-widget', () =>
      ctx.slots.register('conversation:dock-widget', {
        id: 'todo',
        component: TodoDockCardAsync,
        order: 40,
      }),
    );
  },
});

export default todoClientPlugin;

// ============================================================
// ac-todo/client/index.ts —— todo client 半边（M27 S3/D19 行包双半边）
//
// 装载形态（D7/D19）：经 boot graph 动态装载（dev 期 vite 直服本源码 /
// prod 期构建为行 client 模块块）；数据经 ctx.rpc 契约面调宿主 RPC +
// 宿主事件帧（不 import webui 内部模块）。依赖一律 inject 声明（D6）。
//
// 贡献面（todo 域前端消费面——行卸载即一并消失，可摘除性 D19）：
//   · tool-card:result-view keyed seat（id 'todo'）——todo 工具会话流
//     卡片（meta.def 形状对齐 webui ToolResultViewDef 解析契约：
//     { match, component, priority }）；
//   · tracking:dock-widget list seat（id 'todo'，order 10——DSH dock
//     序 Todo → Goal）——composer 上方任务清单 dock 卡。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import ToolResultTodo from './ToolResultTodo.vue';
import TodoDockCard from './TodoDockCard.vue';

/** todo 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const todoClientPlugin = clientPlugin({
  name: 'ac-todo.client',
  inject: ['rpc', 'slots'],
  apply(ctx: ClientContext) {
    // 工具结果卡片（keyed presentation seat——精确名 'todo'，同 id 后
    // 注册者替换；行卸载 → def 消失 → resolve 回落默认文本渲染）
    ctx.slots.register('tool-card:result-view', {
      id: 'todo',
      component: ToolResultTodo,
      meta: { def: { match: 'todo', component: ToolResultTodo, priority: 0 } },
    });
    // 任务清单 dock 卡（list seat；order 10 = DSH dock 序 Todo 在前）
    ctx.slots.register('tracking:dock-widget', {
      id: 'todo',
      component: TodoDockCard,
      order: 10,
    });
  },
});

export default todoClientPlugin;

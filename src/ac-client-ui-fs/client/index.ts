// ============================================================
// ac-client-ui-fs/client/index.ts —— 工具卡行 client 半边（M28 P2 §2.2）
//
// 贡献面：tool-card:result-view keyed seat——行卸载 → def 消失 →
// resolve 回落默认文本渲染（meta.def 形状对齐 ToolResultViewDef
// 解析契约：{ match, component, priority }）。fs 行三卡同后端域
//（ac-fs-tools + ac-str-replace-editor 镜像，§2.2）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';

// 卡片组件（异步：node 环境消费本模块不求值 .vue 视图链）
const ToolResultCode = defineAsyncComponent(() => import('./ToolResult/ToolResultCode.vue'));
const ToolResultWrite = defineAsyncComponent(() => import('./ToolResult/ToolResultWrite.vue'));
const ToolResultEdit = defineAsyncComponent(() => import('./ToolResult/ToolResultEdit.vue'));

/** fs 工具卡行 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const fsCardClientPlugin = clientPlugin({
  name: 'ac-client-ui-fs.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    // read → Code / write → Write / edit → Edit（三卡一行——同后端域）
    ctx.slots.inject('tool-card:result-view', () =>
      ctx.slots.register('tool-card:result-view', {
        id: 'read',
        component: ToolResultCode,
        meta: { def: { match: 'read', component: ToolResultCode, priority: 0 } },
      }),
    );
    ctx.slots.inject('tool-card:result-view', () =>
      ctx.slots.register('tool-card:result-view', {
        id: 'write',
        component: ToolResultWrite,
        meta: { def: { match: 'write', component: ToolResultWrite, priority: 0 } },
      }),
    );
    ctx.slots.inject('tool-card:result-view', () =>
      ctx.slots.register('tool-card:result-view', {
        id: 'edit',
        component: ToolResultEdit,
        meta: { def: { match: 'edit', component: ToolResultEdit, priority: 0 } },
      }),
    );
  },
});

export default fsCardClientPlugin;

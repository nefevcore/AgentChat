// ============================================================
// ac-client-ui-fs/client/index.ts —— 工具卡行 client 半边（M28 P2 §2.2）
//
// 贡献面：tool-card:result-view keyed seat——行卸载 → def 消失 →
// resolve 回落默认文本渲染（meta.def 形状对齐 ToolResultViewDef
// 解析契约：{ match, component, priority }）。fs 行双卡同后端域
//（ac-fs-tools + ac-str-replace-editor 镜像，§2.2）；write 不占卡——
// Label 点击直达文件预览（cr-465：ToolResultWrite 自 4116723a
// openPreview 直达引入后渲染不可达，删除落回直达语义）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';

// 卡片组件（异步：node 环境消费本模块不求值 .vue 视图链）
const ToolResultCode = defineAsyncComponent(() => import('./ToolResult/ToolResultCode.vue'));
const ToolResultEdit = defineAsyncComponent(() => import('./ToolResult/ToolResultEdit.vue'));

/** fs 工具卡行 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const fsCardClientPlugin = clientPlugin({
  name: 'ac-client-ui-fs.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    // read → Code / edit → Edit（双卡一行——同后端域；write 走 Label 直达）
    ctx.slots.inject('tool-card:result-view', () =>
      ctx.slots.register('tool-card:result-view', {
        id: 'read',
        component: ToolResultCode,
        meta: { def: { match: 'read', component: ToolResultCode, priority: 0, label: '读取文件', icon: 'file-text' } },
      }),
    );
    ctx.slots.inject('tool-card:result-view', () =>
      ctx.slots.register('tool-card:result-view', {
        id: 'edit',
        component: ToolResultEdit,
        meta: { def: { match: 'edit', component: ToolResultEdit, priority: 0, label: '编辑文件', icon: 'file-diff' } },
      }),
    );
  },
});

export default fsCardClientPlugin;

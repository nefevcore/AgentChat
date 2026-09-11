// ============================================================
// ac-client-ui-plugin-registry/client/index.ts —— plugin-registry 域
// 前端行 client 半边（M28 P2 §5.2：插件库四件随域成行）
//
// 贡献面：settings:section 选举席（meta.section = 'pluginLibrary' +
// meta.label 叶词条 + 顶层 order 叶序——壳按席位条目派生左树叶）；
// ExtToolsPane 供 AgentPane 跨包深路径直连消费（ui-agents，
// P2 后续件——不经本 index 再导出）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';

// 插件库节宿主（异步：node 环境消费本模块不求值 .vue 视图链）
const PluginLibraryHostAsync = defineAsyncComponent(() => import('./PluginLibraryHost.vue'));

/** plugin-registry 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const pluginRegistryClientPlugin = clientPlugin({
  name: 'ac-client-ui-plugin-registry.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    ctx.slots.inject('settings:section', () =>
      ctx.slots.register('settings:section', {
        id: 'webui-domain-plugin-registry.library',
        component: PluginLibraryHostAsync,
        order: 40,
        meta: { section: 'pluginLibrary', label: '插件库' },
      }),
    );
  },
});

export default pluginRegistryClientPlugin;

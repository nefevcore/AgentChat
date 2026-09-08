// ============================================================
// ac-client-ui-plugin-registry/client/index.ts —— plugin-registry 域
// 前端行 client 半边（M28 P2 §5.2：插件库四件随域成行）
//
// 贡献面：settings:section 选举席（meta.section = 'pluginLibrary'）；
// ExtToolsPane/ExtensionSettingsModal 另供 AgentPane 跨包消费
//（ui-agents，P2 后续件）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';

// 插件库节宿主（异步：node 环境消费本模块不求值 .vue 视图链）
const PluginLibraryHostAsync = defineAsyncComponent(() => import('./PluginLibraryHost.vue'));

export { default as ExtToolsPane } from './ExtToolsPane.vue';
export { default as ExtensionSettingsModal } from './ExtensionSettingsModal.vue';

/** plugin-registry 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const pluginRegistryClientPlugin = clientPlugin({
  name: 'ac-client-ui-plugin-registry.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    ctx.slots.inject('settings:section', () =>
      ctx.slots.register('settings:section', {
        id: 'webui-domain-plugin-registry.library',
        component: PluginLibraryHostAsync,
        meta: { section: 'pluginLibrary' },
      }),
    );
  },
});

export default pluginRegistryClientPlugin;

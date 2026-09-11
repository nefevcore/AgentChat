// ============================================================
// ac-client-ui-llm-pool/client/index.ts —— llm-pool 域前端行 client
// 半边（M28 P2 §5.2：PoolManager 随域成行；2026-11 行拆分：搜索引擎
// 节拆往 ac-client-ui-search-pool——本行收窄为 llm 连接池单节，严格
// 镜像 ac-llm-pool 后端行的 llmProviders 面）
//
// 贡献面：settings:section 选举席（meta.section = 'llmPools' +
// meta.label 叶词条 + 顶层 order 叶序——壳按席位条目派生左树叶）；
// 池更新/默认同步/定向落盘编排随 Host 走（settings 共享 store 经跨包
// import，domain→base 合法）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';

// 节宿主（异步：node 环境消费本模块不求值 .vue 视图链）
const LlmPoolsHostAsync = defineAsyncComponent(() => import('./LlmPoolsHost.vue'));

/** llm-pool 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const llmPoolClientPlugin = clientPlugin({
  name: 'ac-client-ui-llm-pool.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    // 模型管理节（Provider 连接池；左树数据化：meta.label 叶词条 +
    // 顶层 order 叶序——壳按席位条目派生树叶）
    ctx.slots.inject('settings:section', () =>
      ctx.slots.register('settings:section', {
        id: 'webui-domain-llm-pool.llm',
        component: LlmPoolsHostAsync,
        order: 20,
        meta: { section: 'llmPools', label: '模型管理' },
      }),
    );
  },
});

export default llmPoolClientPlugin;

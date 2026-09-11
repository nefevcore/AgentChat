// ============================================================
// ac-client-ui-search-pool/client/index.ts —— search-pool 域
// 前端行 client 半边（2026-11 自 ui-llm-pool 拆分）
//
// 贡献面：settings:section 选举席（meta.section = 'searchPools' +
// meta.label 叶词条 + 顶层 order 叶序——壳按席位条目派生左树叶）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';

// 搜索引擎节宿主（异步：node 环境消费本模块不求值 .vue 视图链）
const SearchPoolsHostAsync = defineAsyncComponent(() => import('./SearchPoolsHost.vue'));

/** search-pool 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const searchPoolClientPlugin = clientPlugin({
  name: 'ac-client-ui-search-pool.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    // 搜索引擎节（settings:section 选举席贡献——原 ui-llm-pool 双节
    // 之一，拆分迁入；左树数据化：meta.label 叶词条 + 顶层 order 叶序）
    ctx.slots.inject('settings:section', () =>
      ctx.slots.register('settings:section', {
        id: 'webui-domain-search-pool.engines',
        component: SearchPoolsHostAsync,
        order: 30,
        meta: { section: 'searchPools', label: '搜索引擎' },
      }),
    );
  },
});

export default searchPoolClientPlugin;

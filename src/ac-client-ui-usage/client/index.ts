// ============================================================
// ac-client-ui-usage/client/index.ts —— usage 域前端行 client 半边
//（M28 P1 §4.1 原案：Token 用量面板随域成行）
//
// 贡献面：overlay 席位（id webui-domain-usage.panel；order 96 = 保持
// 原 AppFrame overlay DOM 序〔文件预览 90 → 建群 95 → 用量 → 版本〕）。
// 后端行（ac-usage）不在场 → usage/tokens RPC 失败 → 弹窗空态降级。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';

// 用量面板宿主（异步：node 环境消费本模块不求值 .vue 视图链）
const TokenUsageHostAsync = defineAsyncComponent(() => import('./TokenUsageHost.vue'));

/** usage 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const usageClientPlugin = clientPlugin({
  name: 'ac-client-ui-usage.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    ctx.slots.inject('overlay', () =>
      ctx.slots.register('overlay', {
        id: 'webui-domain-usage.panel',
        component: TokenUsageHostAsync,
        order: 96,
      }),
    );
  },
});

export default usageClientPlugin;

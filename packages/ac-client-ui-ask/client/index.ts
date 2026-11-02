// ============================================================
// ac-client-ui-ask/client/index.ts —— ask 域前端行 client 半边
//（cr-765 #4）
//
// 贡献面：inject-card:view keyed 席位（kind: durable-interaction）——
// ask_questions 的注入行（提问发起 / 作答回执 / 未响应通知）专用问答卡。
// 行卸载 → 席位贡献消失 → InjectCardHost 回落通用 ContextInjectCard
//（可摘除性保持）。payload 缺席（旧会话）时 AskCard 内部回落正文纯文本。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';
import { registerInjectCardView } from 'ac-client-ui-conversation/client/injectCardViews.ts';

const AskCardAsync = defineAsyncComponent(() => import('./AskCard.vue'));

/** ask 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const askClientPlugin = clientPlugin({
  name: 'ac-client-ui-ask.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    void ctx;
    ctx.slots.inject('inject-card:view', () =>
      ctx.slots.register('inject-card:view', {
        id: 'ask',
        component: AskCardAsync,
        meta: { def: { match: 'durable-interaction', component: AskCardAsync, priority: 0 } },
      }),
    );
  },
});

export default askClientPlugin;
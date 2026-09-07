// ============================================================
// webui/src/clients/base/conversation.ts —— conversation 基础件（M27 S2）
//
// D11/D19：conversation 基础件出厂职责（本批次）= 内置 final 消息视图
// （message:final-view keyed seat：user/assistant 二分支；D9 收编）。
// 会话 scope 树与投影管线（feed 拆解）归属后续批次。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { BUILTIN_MESSAGE_VIEWS, SLOT_KEY, type MessageViewDef } from '../../core/registry/messageViews';

export const conversationBasePlugin = clientPlugin({
  name: 'webui-base-conversation',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    for (const def of BUILTIN_MESSAGE_VIEWS) {
      const entry: MessageViewDef = { ...def };
      ctx.slots.register(SLOT_KEY, {
        id: entry.id,
        component: { name: 'MessageViewStub', render: () => null }, // 内置 id 走 TurnDisplayItem 内建分支
        priority: entry.priority,
        meta: { def: entry },
      });
    }
  },
});

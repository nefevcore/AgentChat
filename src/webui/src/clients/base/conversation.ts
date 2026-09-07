// ============================================================
// webui/src/clients/base/conversation.ts —— conversation 基础件（M27 S2/S3）
//
// D11/D19：conversation 基础件职责（§0.3 归属表）：
//   · 内置 final 消息视图出厂批次（message:final-view keyed seat，D9）；
//   · **会话服务 ctx.sessions**：统一信息流核心（FeedCore：per-dialog
//     分区 = scope 键、流式 ingest 状态机、历史分页投影管线）+ 会话动作
//     核心（ChatCore：发送/中断/排队/交互/预览/压缩反馈）——「域投影 +
//     服务面」的 conversation 形态（S3 后续：分区升级 store 座位实例轴
//     [scopeKey = dialogId]、interaction/compress 段随域走）。
// 双模门面（stores/feed.ts / stores/chat.ts）回落独立实例供既有测试族。
// 服务名 'sessions' 与服务端 'session' 单数占名无碰撞（D22 查重）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { reactive } from 'vue';
import { createFeedCore, type FeedCore, type FeedView } from './feed-core';
import { createChatCore, type ChatCore } from './chat-core';
import { BUILTIN_MESSAGE_VIEWS, SLOT_KEY, type MessageViewDef } from '../../core/registry/messageViews';

export interface ConversationClientOptions {
  /** 预留（对齐 cordis Service 构造签名形态） */
}

export class ConversationService extends Service {
  /** 统一信息流核心（per-dialog 分区 + 流式状态机 + 历史管线） */
  readonly feed: FeedCore = createFeedCore();
  /** 会话动作核心（reactive 视图：feed 属性访问同 pinia store 解包语义） */
  readonly chat: ChatCore;

  constructor(ctx: Context, options: ConversationClientOptions = {}) {
    super(ctx, 'sessions');
    void options;
    this.chat = createChatCore(reactive(this.feed) as unknown as FeedView);
  }

  /** 生命周期（幂等）：wire 订阅 + 名册启动链（装配序列显式发起——
   *  chat 核心 init 的名册链经 pinia 门面，main.ts setActivePinia 之后调用） */
  init(): void {
    this.chat.init();
  }
}

declare module 'ac-client-runtime' {
  interface ClientContext {
    /** conversation 基础件会话服务：feed（信息流核心）+ chat（动作核心） */
    sessions: ConversationService;
  }
}

/** conversation 基础件（装配序列第③步：出厂批次） */
export const conversationBasePlugin = clientPlugin({
  name: 'webui-base-conversation',
  inject: ['slots'],
  async apply(ctx: ClientContext) {
    await ctx.plugin(ConversationService);
    // 内置 final 消息视图出厂批次（D9：message:final-view keyed seat；
    // 声明归 hostLedger（D13 账本）——裸 boot 无账本时跳过注册不炸）
    if (ctx.slots.declOf(SLOT_KEY)) {
      for (const def of BUILTIN_MESSAGE_VIEWS) {
        const entry: MessageViewDef = { ...def };
        ctx.slots.register(SLOT_KEY, {
          id: entry.id,
          component: { name: 'MessageViewStub', render: () => null }, // 内置 id 走 TurnDisplayItem 内建分支
          priority: entry.priority,
          meta: { def: entry },
        });
      }
    }
  },
});

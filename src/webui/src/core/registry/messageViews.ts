// ============================================================
// core/registry/messageViews.ts —— 消息视图注册表门面（re-export）
//
// owning = ac-client-ui-conversation/client/messageViews.ts（M27.2-2
// 视图半边随件迁——TurnDisplayItem 消费；席位声明 + 内置出厂批次住
// conversation client/index.ts）。本模块 re-export 维持旧路径——
// bridge 注册面 / main.ts bind 面 / 测试导入面零改动（同一模块实例）。
// ============================================================
export type { MessageViewDef } from 'ac-client-ui-conversation/client/messageViews.ts';
export {
  SLOT_KEY,
  bindMessageViews,
  registerMessageView,
  resolveMessageView,
  resolveMessageViewRenderer,
} from 'ac-client-ui-conversation/client/messageViews.ts';

// ============================================================
// composables/useQueuedMessages.ts —— next-turn 排队门面（re-export）
// owning = ac-client-ui-conversation/client/useQueuedMessages.ts
//（M27.2-2 视图半边随件迁——rpc 契约面参数化，缺省取 clientRuntime）。
// ============================================================
export { useQueuedMessages, createQueuedDockStore } from 'ac-client-ui-conversation/client/useQueuedMessages.ts';
export type { QueuedMessage, QueuedMessages, QueuedDockStore } from 'ac-client-ui-conversation/client/useQueuedMessages.ts';
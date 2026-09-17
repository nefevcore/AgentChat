// ============================================================
// ac-durable-interaction/src/index.ts —— 核行（领域无关）
//
// 2026-09-17 拆分：ask_questions 工具行与 late-reply 唤醒监听器
// 迁至 ac-ask-questions（kind 词汇的认领者）。本包只剩通用持久化
// 暂停点服务：open/reply/close 状态机 + write-ahead 落盘 +
// durable-interaction/{opened,replied,closed} 三事件 + 保留期清理。
// 消费方（按 kind 词汇各自认领）：ac-ask-questions（ask_questions）、
// ac-security（approval 提权审批）、ac-web-api（interaction RPC）、
// ac-ws-bridge（opened 帧桥接）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { DurableInteractionService, type DurableInteractionConfig } from './service.ts';

export interface DurableInteractionRowOptions extends DurableInteractionConfig {}

export const name = 'ac-durable-interaction';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'durable-interaction',
  label: '持久化暂停点（核）',
  description: '通用持久化交互：open/reply/close 状态机 + 三事件（ask_questions/approval 等工具行在此之上认领 kind 词汇）',
};

export function apply(ctx: Context, options: DurableInteractionRowOptions = {}) {
  ctx.plugin(DurableInteractionService, options);
}

// 契约出口：域类型 + 事件目录类型增强 + 服务类
export type {
  JsonValue,
  DurableInteractionState,
  DurableInteractionInput,
  DurableInteraction,
  DurableInteractionFilter,
  DurableInteractionStore,
  ReplyStatus,
  ReplyOutcome,
} from './types.ts';
export {
  DurableInteractionConflictError,
  DurableInteractionSerializationError,
  DurableInteractionCorruptionError,
} from './types.ts';
export { MemoryDurableInteractionStore, JsonlDurableInteractionStore } from './store.ts';
export type { JsonlDurableInteractionStoreOptions } from './store.ts';
export { DurableInteractionService } from './service.ts';
export type { DurableInteractionConfig } from './service.ts';

// ============================================================
// ac-llm —— LLM 纯路由插件行
//
// 依赖形态：
//   ac-llm（本行，纯路由）
//     ← ac-llm-pool（配置驱动注册行：读 config llmProviders 注册
//       OpenAI 兼容连接 + 内置种子让位；热更走 config/changed）
//   协议实现全部住在 ac-openai-completions 纯库（注册行依赖，本行不依赖）。
//
// 升级 provider = 摘旧行挂新行：inject ['llm'] 的依赖方由 cordis
// 自动处理（服务替换 → 依赖 fiber 回滚重载），路由器与消费者零改动。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { LlmService } from './service.ts';

export const name = 'ac-llm';

export function apply(ctx: Context) {
  ctx.plugin(LlmService);
}

// 契约出口：域类型（contract.ts）+ 事件目录类型增强（events.ts）
export type * from './contract.ts';
export type {} from './events.ts';

export { LlmService, LlmError } from './service.ts';
export type { LlmRegisterMeta, LlmProviderStats, LlmRouteQuery } from './service.ts';

// name@model 引用语法（llm-provider-model-plan P1：纯函数，边界拆分单点）
export { splitModelRef, joinModelRef } from './refs.ts';
export type { ModelRef } from './refs.ts';

// agentOf 命名读取器（M25 §3.2：owning 包导出，类型锚定自家 contract）
export { agentOfChatCall, agentOfChatInput } from './readers.ts';

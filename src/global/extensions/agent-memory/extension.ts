// ============================================================
// agent-memory 扩展 —— 长期记忆插件
//
// 概述：
//   本扩展从 agent-session 中拆分而来，专注管理长期记忆。
//   通过 preHook / postHook 机制介入 Agent.run() 的生命周期，
//   加载和更新 memory.md。
//
// ---- 记忆 (Memory) ----
//   · preHook：加载 memory.md，拼接到系统提示词
//   · postHook：调用 LLM 分析本轮对话，重写 memory.md
//   · 生命周期：永久，持久化到 <sessions>/<agent>/<counterpart>/memory.md
//
// ---- 与 agent-session 的关系 ----
//   agent-session 负责会话持久化（历史消息、上下文压缩、归档、用量追踪）
//   agent-memory  负责长期记忆（跨会话的偏好、决策、待办、用户画像）
//   两者独立运作，通过 hook 链自然组合
//
// ---- 路径规范 ----
//   <workspace>/sessions/<agent>/<counterpart>/memory.md  (私有记忆)
// ============================================================

import { AgentContext, Extension, PreProcessHook, PostProcessHook } from '@core/types';
import { loadMemory, updateMemory } from './memory';
import { meta } from './meta';

// ============================================================
// preHook —— Agent.run() 调用前执行：加载长期记忆
// ============================================================

const preHook: PreProcessHook = async (ctx: AgentContext): Promise<AgentContext> => {
  const agent = ctx.receiver;
  const counterpart = ctx.sender;

  let systemPrompt = ctx.systemPrompt;
  const memory = loadMemory(agent, counterpart);
  if (memory) {
    systemPrompt = `${ctx.systemPrompt}\n\n${memory}`;
  }

  return {
    ...ctx,
    systemPrompt,
  };
};

// ============================================================
// postHook —— Agent.run() 调用后执行：更新长期记忆
// ============================================================

const postHook: PostProcessHook = async (
  ctx: AgentContext,
  _response: string,
): Promise<void> => {
  const agent = ctx.receiver;
  const counterpart = ctx.sender;

  await updateMemory(agent, counterpart, ctx, _response);
};

// ============================================================
// Extension 统一入口
// ============================================================

export const extension: Extension = {
  ...meta,
  preHook,
  postHook,
};

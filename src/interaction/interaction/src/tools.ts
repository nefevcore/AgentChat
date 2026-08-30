// ============================================================
// @agentchat/interaction —— 用户交互工具（ask_questions）
// 领域独立，可脱离 AgentChat 复用。
// ============================================================
import { defineTool } from '@agentchat/toolkit';
import { CAPABILITY_BASE, type AgentConfig } from '@agentchat/agent-config';
import type { Tool, ToolExecutionContext } from '@agentchat/agent-loop';
import type { ToolContext } from '@agentchat/tools';

/** ask_questions 工具：向用户批量提问等待决策（经 ToolContext.interaction） */
export function makeAskQuestionsTool(config: AgentConfig, services: ToolContext): Tool {
  const selfId = config.agent_id;
  return defineTool({
    name: 'ask_questions', label: '询问用户', requires: [CAPABILITY_BASE],
    description: '向用户提问并等待回答。用于需要用户决策或确认的场景。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '问题' },
              options: { type: 'array', items: { type: 'string' }, description: '选项' },
            },
            required: ['question', 'options'],
          },
          description: '选择题列表（最多 5 题）',
        },
        timeout_ms: { type: 'number', description: '等待超时毫秒（不设 = 一直等）', minimum: 0 },
      },
      required: ['questions'],
    },
    extractLabel: (args) => `问: ${String(args.questions?.[0]?.question || '').slice(0, 30)}`,
    execute: async (args, _stream, signal, exec?: ToolExecutionContext) => {
      const bridge = services.interaction;
      if (!bridge) {
        return JSON.stringify({ status: 'error', data: { message: '交互桥未注入 ToolContext' } });
      }

      const agentId = selfId;
      // 会话键取执行上下文（loop 注入的 dialogId）；不依赖 LLM 传参
      const convKey = exec?.dialogId || `${agentId}__unknown`;
      // 默认永久等待（0）；仅显式设置 timeout_ms 才有时限
      const rawTimeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 0;
      const timeoutMs = rawTimeout < 0 ? 0 : rawTimeout;

      const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
      if (rawQuestions.length === 0) {
        return JSON.stringify({ status: 'error', data: { message: '缺少 questions 参数' } });
      }
      const qs = rawQuestions.slice(0, 5).map((q: any) => ({
        question: String(q?.question || ''),
        options: (Array.isArray(q?.options) ? q.options.map(String) : []).slice(0, 6),
      })).filter(q => q.question && q.options.length > 0);
      if (qs.length === 0) {
        return JSON.stringify({ status: 'error', data: { message: 'questions 无效：每题需 question + 至少一个 option' } });
      }

      try {
        // 默认允许用户输入自定义答案
        const answers = await bridge.askQuestions({
          agentId, convKey, questions: qs,
          timeoutMs, signal,
          ...(exec?.toolCallId ? { correlationId: exec.toolCallId } : {}),
        });
        return JSON.stringify({ status: 'ok', data: { answers, questions: qs } });
      } catch (err: any) {
        return JSON.stringify({ status: 'timeout', data: { message: err.message || '用户未响应', questions: qs } });
      }
    },
  });
}

/** 用户交互工具族（ask_questions） */
export function makeInteractionTools(config: AgentConfig, services: ToolContext): Tool[] {
  return [makeAskQuestionsTool(config, services)];
}

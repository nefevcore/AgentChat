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
    description: '向用户提出一组选择题（每题带选项），等待用户选择后继续。用于需要用户决策/确认/授权的场景（二选一、确认危险操作、选择方向、询问偏好），避免擅自替用户做不可逆的决定。调用后会暂停当前推理直到用户回答（默认 120s 超时；timeout_ms=0 表示永久等待，问题跨重启持久）。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '问题（清晰、具体，不要模棱两可）' },
              options: { type: 'array', items: { type: 'string' }, description: '选项（2-6 个，用户可自定义输入替代）' },
            },
            required: ['question', 'options'],
          },
          description: '选择题列表（最多 5 题）：一次提供多个问题，前端逐题回答（避免来回调用工具）。',
        },
        timeout_ms: { type: 'number', description: '等待超时（毫秒，默认 120000；0 = 永久等待，跨重启恢复）' },
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
      // 会话键优先取执行上下文（loop 注入的 dialogId），不再依赖 LLM 传参
      const convKey = exec?.dialogId || args.convKey || `${agentId}__unknown`;
      const rawTimeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 120_000;
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

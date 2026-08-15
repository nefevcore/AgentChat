// ============================================================
// @agentchat/app-tools —— 应用管理工具（system_restart/ask_questions）
// 领域独立，可脱离 AgentChat 复用。
// ============================================================
import { defineTool } from '@agentchat/toolkit';
import { ToolInterrupt } from '@agentchat/agent-loop';
import { isSupervised } from '@agentchat/util';
import type { AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';
import type { ToolContext } from '@agentchat/tools';

const PROCESS_START_TS = Date.now();

/** 扫描 src/plugins 下的源码文件，返回 mtime 晚于进程启动的文件（= 代码改动，reload 无法加载） */

export function makeSystemRestartTool(config: AgentConfig): Tool {
  return defineTool({
    name: 'system_restart', label: '重启后端', requires: ['admin'],
    description: '请求完整后端重启。Supervisor 模式下进程以退出码 42 退出并由父进程拉起（WebSocket 约 2s 自动重连）。危险：会中断所有运行中的任务。仅在确实需要重启时使用，如修改了 src/ 下核心代码后。',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: '重启原因（可选，记入日志）。' } },
    },
    extractLabel: () => '重启后端',
    execute: async (args) => {
      if (!isSupervised()) {
        return '[system_restart] 拒绝：当前非 Supervisor 模式，重启会直接中断进程且无法自动拉起。请通过 Supervisor 启动（AGENTCHAT_SUPERVISED=1）。';
      }
      const reason = typeof args.reason === 'string' && args.reason ? args.reason : 'tool-system-restart';
      // 语义化中断：由 loop 收尾后调用 requestRestart（L5 装配）
      throw new ToolInterrupt({ type: 'restart-requested', reason });
    },
  });
}

/** reload 工具：统一热加载（照搬旧：语义化中断） */

export function makeAskQuestionsTool(config: AgentConfig, services: ToolContext): Tool {
  const selfId = config.agent_id;
  return defineTool({
    name: 'ask_questions', label: '询问用户', requires: ['agent'],
    description: '向用户提出一组选择题（每题带选项），等待用户选择后继续。用于需要用户决策/确认/授权的场景（二选一、确认危险操作、选择方向、询问偏好），避免擅自替用户做不可逆的决定。调用后会暂停当前推理直到用户回答（默认 120s 超时）。',
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
        timeout_ms: { type: 'number', description: '等待超时（毫秒，默认 120000）' },
      },
      required: ['questions'],
    },
    extractLabel: (args) => `问: ${String(args.questions?.[0]?.question || '').slice(0, 30)}`,
    execute: async (args, _stream, signal) => {
      const bridge = services.interaction;
      if (!bridge) {
        return JSON.stringify({ status: 'error', data: { message: '交互桥未注入 ToolContext' } });
      }

      const agentId = selfId;
      const convKey = args.convKey || `${agentId}__unknown`;
      const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : 120_000;

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
        });
        return JSON.stringify({ status: 'ok', data: { answers, questions: qs } });
      } catch (err: any) {
        return JSON.stringify({ status: 'timeout', data: { message: err.message || '用户未响应', questions: qs } });
      }
    },
  });
}

/** 应用控制工具工厂 */

/** 应用管理工具族（system_restart + ask_questions） */
export function makeAppTools(config: AgentConfig, services: ToolContext): Tool[] {
  return [makeSystemRestartTool(config), makeAskQuestionsTool(config, services)];
}

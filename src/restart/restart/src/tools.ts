// ============================================================
// @agentchat/restart —— 系统重启工具（system_restart）
// 领域独立，可脱离 AgentChat 复用。
// ============================================================
import { defineTool } from '@agentchat/toolkit';
import { ToolInterrupt } from '@agentchat/agent-loop';
import { isSupervised } from '@agentchat/util';
import { CAPABILITY_ADMIN, type AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';

/** system_restart 工具：Supervisor 模式下语义化中断，由 loop 收尾后请求进程重启 */
export function makeSystemRestartTool(_config: AgentConfig): Tool {
  return defineTool({
    name: 'system_restart', label: '重启后端', requires: [CAPABILITY_ADMIN],
    description: '请求完整后端重启（进程级）。Supervisor 模式下进程以退出码 42 退出并由父进程拉起（WebSocket 约 2s 自动重连）。危险：会中断所有运行中的任务。适用范围：框架/内核文件（vendor cordis、boot 内核、组合引擎）、.env/环境变量、node_modules 依赖变更，或堆/状态异常；普通插件/工具/钩子源码改动请优先用 reload_modules 进程内热重载（零中断、失败可回滚）。',
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

/** 系统重启工具族（system_restart） */
export function makeRestartTools(config: AgentConfig): Tool[] {
  return [makeSystemRestartTool(config)];
}

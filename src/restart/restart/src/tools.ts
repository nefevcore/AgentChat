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
    description: '重启后端进程。改了框架/内核文件、环境变量或依赖后使用；普通源码改动用 reload_modules。',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: '重启原因（记入日志）' } },
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

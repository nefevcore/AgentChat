// ============================================================
// system_restart 工具 —— 请求后端完全重启
//
// 危险管理工具（隐藏）：
//   · 不在 list_tools 等发现流程中展示（plugin.json 标记 hidden: true）
//   · 不 autoInject
//   · 仅当 config.tools 显式包含 "system_restart" 时被加载（manage_plugins 配置）
//
// 语义化中断（v0.4.2）：不再直接触发重启，而是抛出 ToolInterrupt('restart-requested')。
// Agent run() 会先走 postHook（消息落盘）再调用 requestRestart —— 避免重启时丢消息。
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { ToolInterrupt } from '@core/interrupt';

export const tool: Tool = {
  ...meta,

  definition: {
    type: 'function',
    function: {
      name: 'system_restart',
      description:
        'Request a full backend restart. In Supervisor mode the process exits with code 42 and the parent restarts it (WebSocket auto-reconnects after ~2s). Dangerous: interrupts all running tasks. Use sparingly, e.g. after core/webui code changes that require restart.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Restart reason (optional, logged).',
          },
        },
      },
    },
  },

  extractLabel: () => '🔄 重启后端',

  execute: async (args: Record<string, any>): Promise<string> => {
    const reason = typeof args.reason === 'string' && args.reason ? args.reason : 'tool-system-restart';
    // 语义化中断：不在此处触发，由 Agent run() 在 postHook 之后调用 requestRestart
    throw new ToolInterrupt({ type: 'restart-requested', reason });
  },
};

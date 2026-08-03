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
import { isSupervised } from '@core/shutdown';

export const tool: Tool = {
  ...meta,

  definition: {
    type: 'function',
    function: {
      name: 'system_restart',
      description:
        '请求完整后端重启。Supervisor 模式下进程以退出码 42 退出并由父进程拉起（WebSocket 约 2s 自动重连）。危险：会中断所有运行中的任务。仅在确实需要重启时使用，如修改了核心/webui 代码后。',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: '重启原因（可选，记入日志）。',
          },
        },
      },
    },
  },

  extractLabel: () => '🔄 重启后端',

  execute: async (args: Record<string, any>): Promise<string> => {
    // 防御：非 Supervisor 模式直接拒绝（重启会中断进程且无人拉起）
    if (!isSupervised()) {
      return '[system_restart] 拒绝：当前非 Supervisor 模式，重启会直接中断进程且无法自动拉起。请通过 Supervisor 启动（AGENTCHAT_SUPERVISED=1）。';
    }
    const reason = typeof args.reason === 'string' && args.reason ? args.reason : 'tool-system-restart';
    // 语义化中断：不在此处触发，由 Agent run() 在 postHook 之后调用 requestRestart
    throw new ToolInterrupt({ type: 'restart-requested', reason });
  },
};

// ============================================================
// system_restart 工具 —— 请求后端完全重启
//
// 危险管理工具（隐藏）：
//   · 不在 list_tools 等发现流程中展示（plugin.json 标记 hidden: true）
//   · 不 autoInject
//   · 仅当 config.tools 显式包含 "system_restart" 时被加载（manage_plugins 配置）
//
// 行为：触发 gracefulShutdown → Supervisor 模式退出码 42 → 父进程拉起
//   · 非 Supervisor 模式（普通 node/tsx 直跑）→ 退出码 0，进程结束（由外部工具如 nodemon 负责重启）
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { requestRestart } from '@core/shutdown';

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
    try {
      // 异步触发，让回执先送达再退出
      setTimeout(() => {
        try {
          requestRestart(reason);
        } catch (err: any) {
          console.error(`[system_restart] 触发失败: ${err.message}`);
        }
      }, 200);
      return JSON.stringify({
        status: 'ok',
        data: {
          message: '后端重启已触发。Supervisor 模式将自动拉起新实例（WS 约 2s 后自动重连）；非托管模式进程将退出，请手动重启。',
          reason,
          supervised: process.env.AGENTCHAT_SUPERVISED === '1',
        },
      });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', data: { message: `重启触发失败: ${err.message}` } });
    }
  },
};

// ============================================================
// ac-restart/src/index.ts —— 系统重启工具行（system_restart）
//
// src restart 平移。Supervisor 模式（AGENTCHAT_SUPERVISED=1）下走
// M11 语义化中断通道：工具体返回 interrupt {type:'system-restart'}，
// loop 收束（finish='interrupted'）后由【本行宿主半边】执行进程重启
// （M15 对账补齐：订阅 loop/after-run 消费 toolInterrupt——优雅关闭
// 后以退出码 42 退出，supervisor.mjs 见 42 主动重拉）。非 Supervisor
// 模式拒绝。能力门禁：requires ['admin']（ac-security 行执行）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';
import type {} from 'ac-agent-loop'; // loop/* 事件目录（type-only）

/** Supervisor 模式判定（宿主以 AGENTCHAT_SUPERVISED=1 拉起本进程） */
export function isSupervised(): boolean {
  return process.env.AGENTCHAT_SUPERVISED === '1';
}

/** 优雅退出码（supervisor 协议：主动重拉） */
export const RESTART_EXIT_CODE = 42;

export const name = 'ac-restart';

export const inject = ['tools'];

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 系统重启已受理（UI system/restart 触发 / system_restart 工具 run
     * 收束后发出；发出即开始优雅关闭）。
     * @mode emit
     * 载荷 = 重启原因。谁该订阅：WS 桥接（前端提示"后端重启中"）。
     */
    'system/restarting'(reason: string): void;
  }
}

/**
 * 重启受理（唯一实现；UI 面与 system_restart 工具共用）：
 * Supervisor 门禁 → 日志 + system/restarting 广播 → 根 fiber 优雅关闭 →
 * exit(42)（supervisor.mjs 见 42 主动重拉）。关闭窗口内的新投递由
 * supervisor 重启后的会话历史回放兜底。
 */
export function requestSystemRestart(ctx: Context, reason: string): { ok: boolean; error?: string } {
  if (!isSupervised()) {
    return {
      ok: false,
      error:
        '[system_restart] 拒绝：当前非 Supervisor 模式，重启会直接中断进程且无法自动拉起。请通过 Supervisor 启动（AGENTCHAT_SUPERVISED=1）。',
    };
  }
  ctx.logger.info(
    `[system_restart] 收到重启请求（${reason}）——优雅关闭后以 ${RESTART_EXIT_CODE} 退出`,
  );
  ctx.emit('system/restarting', reason);
  void ctx.root.fiber
    .dispose()
    .catch((err: unknown) => {
      ctx.logger.warn(`[system_restart] 优雅关闭失败（强制退出）: ${String(err)}`);
    })
    .finally(() => {
      process.exit(RESTART_EXIT_CODE);
    });
  return { ok: true };
}

export function apply(ctx: Context) {
  ctx.tools.register({
    name: 'system_restart',
    description: '重启后端进程。改了框架/内核文件、环境变量或依赖后使用；普通源码改动用 reload_modules。',
    requiredTags: ['admin'],
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: '重启原因（记入日志）' } },
    },
    execute(args): ToolResult {
      const reason = typeof args.reason === 'string' && args.reason ? args.reason : 'tool-system-restart';
      if (!isSupervised()) {
        return {
          ok: false,
          error:
            '[system_restart] 拒绝：当前非 Supervisor 模式，重启会直接中断进程且无法自动拉起。请通过 Supervisor 启动（AGENTCHAT_SUPERVISED=1）。',
        };
      }
      return {
        ok: true,
        output: { message: '已请求进程重启：run 收束后由 supervisor 执行' },
        interrupt: { type: 'system-restart', reason },
      };
    },
  });

  // ---- 宿主半边（M15 补齐）：run 收束后执行重启 ----
  // loop 以 finish='interrupted' 收束后，本行消费 toolInterrupt（UI 面
  // system/restart 不经此路径，直调 requestSystemRestart）。
  ctx.on('loop/after-run', (_request, result) => {
    if (result.finish !== 'interrupted') return;
    const ti = result.interruptReason?.toolInterrupt;
    if (ti?.type !== 'system-restart') return;
    requestSystemRestart(ctx, ti.reason ?? 'tool-system-restart');
  }, { description: '收束检测 restart 意图 → 宿主重启（interrupt 上报半边）' });
}

// ============================================================
// 优雅关闭 / 重启 —— Supervisor 模式的子进程侧
//
// 工作进程被 supervisor 托管时，通过约定的退出码与父进程通信：
//   EXIT_RESTART (42)  = 主动请求重启（supervisor 重新 spawn）
//   其他非 0          = 崩溃（supervisor 重新 spawn 并记录）
//   0                 = 正常退出（supervisor 一并退出）
// ============================================================

import { getAppState } from '@core/app-state';
import { logger } from '@utils/logger';

/** 主动重启的约定退出码 */
export const EXIT_RESTART = 42;

/** 是否处于 supervisor 托管模式（由环境变量 AGENTCHAT_SUPERVISED=1 标识） */
export function isSupervised(): boolean {
  return process.env.AGENTCHAT_SUPERVISED === '1';
}

/**
 * 优雅关闭：按注册顺序依次执行清理钩子，然后以指定退出码退出。
 * - 关闭 WebUI（HTTP + WS 服务）
 * - 停止定时器
 * - 中止进行中的 Agent 任务
 * - flush 未落盘消息
 */
export async function gracefulShutdown(exitCode: number, reason?: string): Promise<never> {
  logger.notice(`[Shutdown] 优雅关闭中… (exit=${exitCode}${reason ? `, reason: ${reason}` : ''})`);

  // 0. 通知 Router 进入重启模式：后续消息入队 pending（落盘），重启后重投
  try {
    const state = getAppState();
    const router = (state as any).router;
    if (router?.enterRestartMode) {
      router.enterRestartMode();
      logger.info('[Shutdown] Router 已进入重启模式，新消息将入队 pending');
    }
  } catch (err: any) {
    logger.warn(`[Shutdown] Router 进入重启模式失败: ${err.message}`);
  }

  // 1. 通知所有连接"正在重启"（仅重启场景，由 handler 提前广播）
  // 2. 停止定时器（TimerManager 持有 interval/timeout）
  try {
    const { timerManager } = await import('../core/timer/index.js');
    timerManager.stopAll();
    logger.info('[Shutdown] 定时器已停止');
  } catch (err: any) {
    logger.warn(`[Shutdown] 停止定时器失败: ${err.message}`);
  }

  // 3. 中止所有进行中的 Agent 任务（含子 Agent）
  try {
    const state = getAppState();
    // 子 Agent 全杀（SubAgentManager 无 killAll，遍历 list + kill）
    const subMgr = (state as any).subAgentManager;
    if (subMgr?.list) {
      let killed = 0;
      for (const sub of subMgr.list()) {
        if (subMgr.kill(sub.id)) killed++;
      }
      if (killed > 0) logger.info(`[Shutdown] 已终止 ${killed} 个子 Agent`);
    }
    // 中止主 Agent 进行中的 run
    const agents = (state as any).agents as Map<string, any> | undefined;
    if (agents) {
      let aborted = 0;
      for (const agent of agents.values()) {
        if (agent._abortController) {
          agent.abort();
          aborted++;
        }
      }
      if (aborted > 0) logger.info(`[Shutdown] 已中止 ${aborted} 个进行中的 Agent 任务`);
    }
  } catch (err: any) {
    logger.warn(`[Shutdown] 中止任务失败: ${err.message}`);
  }

  // 4. 关闭 WebUI（HTTP + WS）
  try {
    const state = getAppState();
    const webui = (state as any).webui;
    if (webui?.stop) {
      await webui.stop();
      logger.info('[Shutdown] WebUI 服务器已关闭');
    }
  } catch (err: any) {
    logger.warn(`[Shutdown] 关闭 WebUI 失败: ${err.message}`);
  }

  // 5. 退出
  logger.notice('[Shutdown] 退出完成');
  process.exit(exitCode);
}

/**
 * 请求完全重启（供 WS system.restart 等入口调用）。
 * 在 supervisor 模式下以 EXIT_RESTART 退出 → 父进程重新拉起。
 * 非托管模式退化为直接退出（由外部工具如 nodemon 负责重启）。
 */
export function requestRestart(reason?: string): void {
  // 先异步触发，避免阻塞当前消息处理
  void gracefulShutdown(isSupervised() ? EXIT_RESTART : 0, reason ?? 'manual-restart');
}

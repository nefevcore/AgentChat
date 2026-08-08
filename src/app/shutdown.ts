// ============================================================
// 优雅关闭 / 重启 —— Supervisor 模式的子进程侧（L5 app 域）
//
// 工作进程被 supervisor 托管时，通过约定的退出码与父进程通信：
//   EXIT_RESTART (42)  = 主动请求重启（supervisor 重新 spawn）
//   其他非 0          = 崩溃（supervisor 重新 spawn 并记录）
//   0                 = 正常退出（supervisor 一并退出）
//
// 目标架构（architecture-target-20260805 §5.6 shutdown 域化）：
//   资源按归属域自治关闭：router 域（enterShutdownMode → abort 活跃会话）→
//   插件域（timer.stopAll / subAgent 全杀 / interaction.abortAll）→ WebUI.stop → exit。
//
// 适配新架构：
//   · 旧 getAppState() 全局单例 → setShutdownDeps 注入（bootstrap 调用）
//   · 旧 enterRestartMode → 新 router.enterShutdownMode()（pending 内存队列）
//   · 依赖方向：app → services/plugins（允许）；isSupervised ← @utils/supervisor
// ============================================================

import { createLogger } from '@core/logger';
import { isSupervised } from '@utils/supervisor';
import type { AgentRouter } from '@agents/router';
import type { TimerManager } from '@plugins/builtin/services/timer';
import type { SubAgentManager } from '@plugins/builtin/services/subagent';
import type { InteractionBridge } from '@services/interactions';

const log = createLogger('[app:shutdown]');

/** 主动重启的约定退出码 */
export const EXIT_RESTART = 42;

// isSupervised 为纯环境判断（横切工具），此处再导出保持 API 稳定
export { isSupervised } from '@utils/supervisor';

// ============================================================
// 关闭依赖（bootstrap 注入；替代旧 getAppState）
// ============================================================

export interface ShutdownDeps {
  /** L2 路由器（进入关机模式 + 中止活跃会话） */
  router?: AgentRouter;
  /** L3 定时任务管理器（停止 interval/timeout） */
  timer?: TimerManager;
  /** L3 子 Agent 管理器（全杀） */
  subAgent?: SubAgentManager;
  /** L4 交互桥（中止 pending ask_questions） */
  interaction?: InteractionBridge;
  /** L5 WebUI（HTTP + WS） */
  webui?: { stop(): Promise<void> | void } | null;
  /** L4 归档编排（停止超时扫描 + 清理空闲定时器） */
  archive?: { dispose(): void };
}

let deps: ShutdownDeps = {};

/** bootstrap 装配完成后注入关闭依赖 */
export function setShutdownDeps(d: ShutdownDeps): void {
  deps = d;
}

// ============================================================
// 优雅关闭
// ============================================================

/**
 * 优雅关闭：按注册顺序依次执行清理钩子，然后以指定退出码退出。
 */
export async function gracefulShutdown(exitCode: number, reason?: string): Promise<never> {
  log.info(`优雅关闭中… (exit=${exitCode}${reason ? `, reason: ${reason}` : ''})`);

  // 0. Router 域：进入关机模式（新消息入 pending），中止活跃会话
  try {
    const router = deps.router;
    if (router) {
      router.enterShutdownMode();
      // 中止所有活跃会话（含群组/trigger）
      for (const agentId of router.getAgentIds()) {
        router.abortSession(agentId);
      }
      log.info('Router 已进入关机模式，活跃会话已中止');
    }
  } catch (err: any) {
    log.warn(`Router 关闭失败: ${err?.message ?? String(err)}`);
  }

  // 1. 交互桥：中止所有 pending ask_questions
  try {
    deps.interaction?.abortAll();
  } catch (err: any) {
    log.warn(`交互桥关闭失败: ${err?.message ?? String(err)}`);
  }

  // 2. 插件域：停止定时任务
  try {
    deps.timer?.stopAll();
    log.info('定时器已停止');
  } catch (err: any) {
    log.warn(`停止定时器失败: ${err?.message ?? String(err)}`);
  }

  // 3. 插件域：中止所有子 Agent
  try {
    const subMgr = deps.subAgent;
    if (subMgr?.list) {
      let killed = 0;
      for (const sub of subMgr.list()) {
        if (subMgr.kill(sub.id)) killed++;
      }
      if (killed > 0) log.info(`已终止 ${killed} 个子 Agent`);
    }
  } catch (err: any) {
    log.warn(`终止子 Agent 失败: ${err?.message ?? String(err)}`);
  }

  // 4. WebUI（HTTP + WS）
  try {
    if (deps.webui?.stop) {
      await deps.webui.stop();
      log.info('WebUI 服务器已关闭');
    }
  } catch (err: any) {
    log.warn(`关闭 WebUI 失败: ${err?.message ?? String(err)}`);
  }

  // 4.5 归档编排（停止超时扫描 + 清理空闲定时器）
  try {
    deps.archive?.dispose();
  } catch (err: any) {
    log.warn(`归档服务关闭失败: ${err?.message ?? String(err)}`);
  }

  // 5. 退出
  log.info('退出完成');
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

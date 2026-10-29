// ============================================================
// shell-state-poller.ts —— 宿主侧壳状态轮询面（cr-748 状态对账批）
//
// 丢帧根因：shell 的状态转移此前只有 push 面（stdout TSV 节拍 + B3 旁带
// 流——连接断即丢不重放），宿主换代/断连窗口内收束的 run 对宿主不可见，
// UI 卡「运行中」直到下次 RPC。本面 = pull 对账骨干：定期 peek() 活壳
// run-state 快照（含 recentSettled 收束尾巴），对拍出「活跃集消失但宿主
// 未见过 settled 帧」的缺口，投递 run-settled 对账事件。
//
// 铁律：**绝不拉起壳**——peek 失败 = 本拍无数据（boot 窗口/退出中都是
// 常态），拉起恒归信件驱动的 ensureHook 链。定时器纪律：懒拉起（首订阅
// 才起）、末位退订即停（unref——宿主不被轮询定时器吊命）。
//
// 纯域可测：peek 面 / 时钟 / tick 泵注入（supervise 同款惯例）。
// ============================================================

import type { OrchestratorHandle, RunStateSnapshot } from './orchestrator.ts';

export interface PollerOptions {
  /** 轮询间隔（缺省 2s；「每帧」粒度无意义——快照语义至多滞后一拍） */
  intervalMs?: number;
  now?(): number;
  /**
   * tick 泵注入（测试面——同步驱动，替代真实 setInterval；supervise 的
   * tickPump 同惯例）。返回停泵函数。缺省 = 真实 setInterval（unref）。
   */
  tickPump?(onTick: () => void, intervalMs: number): () => void;
}

export interface ShellStatePoller {
  /** 当前快照（最近成功一拍的只读视图——无数据 = 空 Map） */
  snapshot(): Map<string, RunStateSnapshot>;
  /** 订阅对账事件（返回退订面；poller 随首个订阅起、末位退订即停） */
  onEvent(cb: (event: PollerEvent) => void): () => void;
  /** 手动驱动一拍（幂等安全——与 tick 同链；测试/诊断用） */
  poll(): Promise<void>;
  /** 收束（停泵——订阅面不注销，宿主 close 时调用） */
  dispose(): void;
}

/** 对账事件（poller 视角的转移面——消费方幂等，push 帧与 pull 对账可能双达） */
export type PollerEvent =
  | { type: 'run-settled'; agentId: string; runId: string; conversationId: string; finish: string; finishedAt: number }
  | { type: 'shell-emerged'; agentId: string };

/**
 * 壳状态轮询面：每拍 peek() → 更新快照缓存 → 对拍投递事件。
 * 对拍规则（per agent）：
  *   · recentSettled 里有宿主未见过的 runId → run-settled 事件（短命 run 的
  *     收束至此可见——两拍之间完整起收的 run 不再对宿主透明）；
  *   · 快照缺席（探测失败/壳退出）→ 清该 agent 的已见集（壳换代后新
  *     bootId 的 recentSettled 从头认，不误投旧壳的收束）。
 */
export function createShellStatePoller(orch: OrchestratorHandle, options: PollerOptions = {}): ShellStatePoller {
  const intervalMs = options.intervalMs ?? 2_000;
  const now = options.now ?? Date.now;
  const listeners = new Set<(event: PollerEvent) => void>();
  let current = new Map<string, RunStateSnapshot>();
  // 已见收束键（`${agentId}:${runId}`）——事件不重投；壳换代（快照缺席）即清
  const seenSettled = new Set<string>();
  let timer: 'pump' | null = null;
  let stopTimer: (() => void) | null = null;
  let polling = false;
  let disposed = false;

  const emit = (event: PollerEvent): void => {
    for (const cb of listeners) {
      try { cb(event); } catch { /* 订阅方异常不阻断轮询链 */ }
    }
  };

  const poll = async (): Promise<void> => {
    if (polling || disposed) return;
    polling = true;
    try {
      const fresh = await orch.peek();
      for (const [agentId, snap] of fresh) {
        for (const s of snap.recentSettled) {
          const key = agentId + ':' + s.runId;
          if (seenSettled.has(key)) continue;
          seenSettled.add(key);
          emit({ type: 'run-settled', agentId, runId: s.runId, conversationId: s.conversationId, finish: s.finish, finishedAt: s.finishedAt });
        }
      }
      // 快照缺席的 agent = 探测失败/壳退出——清已见集（换代后从头认）
      const live = new Set(fresh.keys());
      for (const key of seenSettled) {
        if (!live.has(key.slice(0, key.indexOf(':')))) seenSettled.delete(key);
      }
      current = fresh;
    } finally {
      polling = false;
    }
  };

  const ensureTimer = (): void => {
    if (timer !== null || disposed) return;
    if (options.tickPump !== undefined) {
      const stop = options.tickPump(() => { void poll(); }, intervalMs);
      stopTimer = () => { stop(); stopTimer = null; };
      timer = 'pump';
      return;
    }
    const t = setInterval(() => { void poll(); }, intervalMs);
    t.unref();
    stopTimer = () => { clearInterval(t); stopTimer = null; };
    timer = 'pump';
  };

  return {
    snapshot: () => current,
    onEvent(cb) {
      listeners.add(cb);
      ensureTimer();
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) {
          stopTimer?.();
          timer = null;
        }
      };
    },
    poll,
    dispose() {
      disposed = true;
      stopTimer?.();
      timer = null;
    },
  };
}

// ============================================================
// ac-client-runtime/src/resyncRetry.ts —— 重连恢复钩子的退避重试（cr-948）
//
// 问题：各域「重连即刷」恢复钩子（feed/singles/runs/subagents/agents 装配
// 视图）的 RPC 拉取是一次性 try/catch——restart_host 后首连常撞宿主 boot
// 早期窗口（webServer 已听但域服务未就绪），一次失败即静默放弃，投影停在
// 断连时刻直到用户手动刷新。刷新之所以能恢复 = 它是唯一的重试路径。
//
// 本件：小退避重试包装（2/4/8s 三拍，成功即停）——恢复链「最终成功」而非
// 「尽力而为」。幂等要求由调用方保证（refresh 类操作天然幂等；重复拉取
// 只是多余往返，不产生错误状态）。
// ============================================================

export interface ResyncRetryHandle {
  cancel(): void;
}

const BACKOFF_STEPS_MS = [2000, 4000, 8000];

/** 恢复动作退避重试：fn 失败（reject）按步进重试，成功/取消即停。
 *  同一时间每 key 只有一个重试链在跑——新调用先取消旧链。 */
export function resyncRetry(key: string, fn: () => Promise<void>): ResyncRetryHandle {
  const reg = registry();
  reg.get(key)?.cancel();
  let canceled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const handle: ResyncRetryHandle = {
    cancel(): void {
      canceled = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (reg.get(key) === handle) reg.delete(key);
    },
  };
  reg.set(key, handle);
  let attempt = 0;
  const run = (): void => {
    if (canceled) return;
    fn().then(
      () => handle.cancel(),
      () => {
        if (canceled) return;
        if (attempt >= BACKOFF_STEPS_MS.length) { handle.cancel(); return; }
        const delay = BACKOFF_STEPS_MS[attempt++];
        timer = setTimeout(run, delay);
      },
    );
  };
  run();
  return handle;
}

// 每 key 单链注册表（模块级语义经 globalThis 持有——跨 cordis fiber 实例共享）
const REGISTRY_KEY = '__acResyncRetry';
function registry(): Map<string, ResyncRetryHandle> {
  const g = globalThis as Record<string, unknown>;
  let reg = g[REGISTRY_KEY] as Map<string, ResyncRetryHandle> | undefined;
  if (reg === undefined) {
    reg = new Map();
    g[REGISTRY_KEY] = reg;
  }
  return reg;
}

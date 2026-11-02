// ============================================================
// auto-reload.ts —— webui 产物更新自动刷新（cr-846）
//
// 前端版本指纹三源（宿主直服产物面的变化面全覆盖）：
//   · index ETag（HEAD / —— 主骨架 dist 重建必变，no-cache+ETag 协商零字节）
//   · boot-graph body（GET /api/ui/boot-graph —— 通道集装卸载/重建必变；
//     mtime 缓存失效即重扫（cr-843），内容不变时字节恒定 → 无误刷）
// 触发轨：WS onOpen（restart_host 换代 = 断线重连复活，最常见场景）+
// 轮询（宿主未断连的重建兜底，30s）。
// 纪律：流式中/后台标签不刷（丢用户阅读现场，回前台补刷）；校验失败
// 静默（探活噪声不刷——刷新只由指纹差异驱动）。
// ============================================================
import { wireRpcBrowser } from './rpc-wire.ts';

interface ReloadGuard {
  /** 流式中 = true（推迟刷新） */
  isStreaming: () => boolean;
  /** 后台标签 = true（推迟刷新） */
  isHidden: () => boolean;
}

interface AutoReloadOptions {
  /** 指纹采集面（缺省 = 三源真面）；测试注入桩 */
  fingerprint?: () => Promise<string>;
  /** 触发轨（缺省 = WS onOpen + 30s 轮询）；测试注入桩（fire 每次触发校验） */
  onTrigger?: (fire: () => void) => void;
  /** 刷新动作（缺省 = location.reload()）；测试注入桩 */
  reload?: () => void;
  guard?: Partial<ReloadGuard>;
  /** 轮询周期 ms（缺省 30s；测试调小） */
  pollMs?: number;
}

function defaultHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** 默认指纹：index ETag + boot-graph body 合并（任一变化即指纹变） */
async function defaultFingerprint(): Promise<string> {
  const parts: string[] = [];
  const head = await fetch('/', { method: 'HEAD', cache: 'no-store' }).catch(() => null);
  if (head) parts.push('index:' + (head.headers.get('etag') ?? head.headers.get('last-modified') ?? head.status));
  try {
    const res = await fetch('/api/ui/boot-graph', { signal: AbortSignal.timeout(8000) });
    if (res.ok) parts.push('graph:' + (await res.text()));
  } catch { /* 探活失败不构成指纹面 */ }
  return parts.join('|');
}

export interface AutoReloadHandle {
  /** 指纹差异成立（守卫放行后）——直接刷新 */
  reloadNow(): void;
  /** 测试收尾：停轮询 + 摘全局单例（不留挂 vitest worker） */
  disposeForTest(): void;
}

const GLOBAL_KEY = '__acAutoReload';

/**
 * 启动自动刷新守护。boot 成功后调用一次：记基线指纹，此后触发轨校验，
 * 差异 + 守卫放行 → reload。幂等：单例语义（重复调用返回既有句柄）。
 */
export function startAutoReload(options: AutoReloadOptions = {}): AutoReloadHandle {
  const globals = globalThis as Record<string, unknown>;
  if (globals[GLOBAL_KEY]) return globals[GLOBAL_KEY] as AutoReloadHandle;
  // 流式判据（缺省）：llm/delta 帧活跃窗口——流式输出时 delta 持续到达，
  // 末帧 2.5s 内 = 生成中。判据正交于 chat store（零组件层耦合）。
  let lastDeltaAt = 0;
  wireRpcBrowser.onEvent((type) => { if (type.startsWith('llm/delta')) lastDeltaAt = Date.now(); });
  const fingerprint = options.fingerprint ?? defaultFingerprint;
  const reload = options.reload ?? (() => location.reload());
  const guard: ReloadGuard = {
    isStreaming: options.guard?.isStreaming ?? (() => Date.now() - lastDeltaAt < 2500),
    isHidden: options.guard?.isHidden ?? defaultHidden,
  };
  let baseline: string | null = null;
  let deferred = false;
  let pending = false;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function flushDeferred(): void {
    if (!deferred || disposed) return;
    deferred = false;
    if (!guard.isStreaming() && !guard.isHidden()) reload();
  }

  async function check(): Promise<void> {
    if (pending || disposed) return;
    pending = true;
    try {
      if (baseline === null) {
        baseline = await fingerprint();
        return;
      }
      if ((await fingerprint()) === baseline) return;
    } catch {
      return; // 校验异常静默——刷新只由指纹差异驱动
    } finally {
      pending = false;
    }
    if (guard.isStreaming() || guard.isHidden()) {
      deferred = true; // 守卫拦下，等流式结束/回前台补刷
      return;
    }
    reload();
  }

  const fire = () => { void check(); };
  if (options.onTrigger) {
    options.onTrigger(fire);
  } else {
    // WS 重连轨：restart_host 换代 → 断线重连复活 → onOpen 即校验
    wireRpcBrowser.onOpen(fire);
    // 轮询轨：宿主未断连的产物重建兜底（30s）
    timer = setInterval(fire, options.pollMs ?? 30_000);
  }
  // 标签回前台 → 补刷被推迟的刷新
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', flushDeferred);
  void check();
  const handle: AutoReloadHandle = {
    reloadNow: () => {
      if (guard.isStreaming() || guard.isHidden()) deferred = true;
      else reload();
    },
    disposeForTest: () => {
      disposed = true;
      if (timer) clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', flushDeferred);
      if (globals[GLOBAL_KEY] === handle) delete globals[GLOBAL_KEY];
    },
  };
  globals[GLOBAL_KEY] = handle;
  return handle;
}

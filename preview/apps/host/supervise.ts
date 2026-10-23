// ============================================================
// supervise.ts —— 宿主常驻监护面（8.9 前置收敛第一批，cr-550）
//
// adoptShell 只消费 boot 三节拍（拉起→adopt→可达登记）；壳常驻后的监护
// 语义（协议 D2：心跳判死 / idle 收割确认 / 崩溃重拉熔断）此前无宿主
// 接线。本模块 = 常驻监护循环：
//
//   · 心跳判死（declare-dead）→ kill（假死壳强杀后 pid 真死，重拉
//     acquireActivationLock 自然获锁——陈锁接管面）；
//   · idle 收割（kill-idle）→ 壳侧 idle-exit 退码 0 自杀（四条件探针
//     壳内自持），宿主清可达表即可；
//   · 壳退出 → shellExited：respawn（指数退避重拉同链）/ broken（熔断
//     ——不再自动拉起）/ done（正常退出——来件按需拉起）；
//   · 插件装载失败回报（cr-543 遗留）：plugin.load-failed TSV 行 →
//     宿主 pluginRegistry.reportLoadFailure（阈值 3 熔断 → 行集条目
//     剔除——fail-closed）。
//
// 纯域可测：拉起函数 / 时钟 / 回报面全注入。
// ============================================================
import { ShellWarden, DEFAULT_GUARDIAN_CONFIG, type GuardianEvent, type GuardianConfig } from 'ac-guardian';
import type { ReachabilityTable, PostOffice } from 'ac-post-office';

/** 拉起输入（adoptShell 同参——重拉同链复用） */
export interface SuperviseSpawnInput {
  agentId: string;
  dataRoot: string;
  catalogFile: string;
  bootFile: string;
  reach: ReachabilityTable;
  /** 邮局（可选——在场时 adopted 即转投 outbox 滞留信） */
  postOffice?: PostOffice;
  mockProvider?: boolean;
}

/** 已拉起壳（adoptShell 返回面的结构子集——本面消费的持续订阅面） */
export interface AdoptedShellFace {
  bootId: string;
  transportHint: string;
  pid: number;
  events: GuardianEvent[];
  shutdown(): Promise<number | null>;
  kill(): void;
  /** stdout 行订阅（boot.ready 后继续——guardian.ping / run 节拍 / plugin.load-failed） */
  onLine(cb: (line: string) => void): void;
  /** 进程退出订阅 */
  onExit(cb: (code: number | null) => void): void;
  /** 控制帧往返（cr-552 跨进程 dry-run——adoptShell 同面） */
  control(frame: Record<string, unknown>): Promise<unknown>;
}

/** 拉起函数面（adoptShell——经注入破模块环） */
export type SuperviseAdopter = (input: SuperviseSpawnInput) => Promise<AdoptedShellFace>;

/** 插件装载失败回报面（生产 = pluginRegistry.reportLoadFailure） */
export type LoadFailureSink = (name: string, error: string) => Promise<void>;

/** 监护事件（宿主编排面消费——日志/告警面） */
export type SuperviseEvent =
  | { type: 'adopted'; agentId: string; bootId: string; transportHint: string }
  | { type: 'respawned'; agentId: string; attempt: number; delayMs: number }
  | { type: 'shell-exit'; agentId: string; code: number | null }
  | { type: 'declared-dead'; agentId: string; reason: 'heartbeat-lost' | 'idle-exit' }
  | { type: 'circuit-broken'; agentId: string; consecutiveCrashes: number };

export interface SuperviseOptions {
  adopt: SuperviseAdopter;
  /** 插件装载失败回报面（缺席 = 静默丢弃——CLI 直连形态无宿主） */
  onPluginLoadFailure?: LoadFailureSink;
  config?: Partial<GuardianConfig>;
  now?(): number;
  /** 监护 tick 周期（缺省 = 心跳周期） */
  tickIntervalMs?: number;
  /**
   * 重拉延迟基数（缺省 1.5s）。指数退避档（cr-551）：延迟 = base ×
   * factor^crashCount，cap 60s，jitter ±20%（主线 supervisor-core 默认档
   * 同源值内联——壳级档与宿主进程级一致）。基档复位时机 = warden 计数
   * 复位（正常退出 code 0 / 崩溃窗外滚动）。
   */
  respawnDelayMs?: number;
  /** 退避因子（缺省 2） */
  backoffFactor?: number;
  /** 退避上限 ms（缺省 60s） */
  backoffCapMs?: number;
  /**
   * 崩溃存活判定窗（缺省 30s——主线 supervisor-core bootOkMs 同值）：壳
   * 活过该窗后崩溃 = 稳定壳偶发崩，退避归零基档；窗内即崩 = 启动失败
   * 族，指数位累计。
   */
  bootOkMs?: number;
  /**
   * tick 泵注入（测试面——同步驱动监护循环，替代真实 setInterval）。
   * 返回停泵函数。缺省 = 真实 setInterval（unref）。
   */
  tickPump?(onTick: () => void, intervalMs: number): () => void;
}

/** 监护句柄（宿主 boot 持有） */
export interface SuperviseHandle {
  agentId: string;
  /** warden 事件流（三节拍 + 判死/熔断——诊断面） */
  events: GuardianEvent[];
  /** 监护编排事件流（本模块动作面） */
  superviseEvents: SuperviseEvent[];
  /** 优雅停（shutdown 帧——壳退码 0）+ 停监护循环 */
  shutdown(): Promise<number | null>;
  /** 强杀兜底（+ 停监护循环） */
  kill(): void;
  /** 停监护循环（宿主 close 面调用——不再重拉） */
  stop(): void;
  /** 是否熔断（熔断后不再自动拉起） */
  isBroken(): boolean;
  /**
   * 按需拉起（幂等——已在监护即复用）：邮局判不可达触发链的拉起面。
   * 熔断态抛错（熔断 = 宿主重启入口解，不静默半拉起）。
   */
  restart(): Promise<void>;
  /** adopted 订阅（每次拉起/重拉成功后回调——re-tap 面经此接线） */
  onAdopted(cb: (hint: string) => void): void;
  /**
   * 控制帧往返（cr-552）：经当前壳实例转发；无活壳（idle 自杀/崩溃后）
   * 经 restart 按需拉起后转发。熔断态抛错（同 restart 语义——不静默半拉起）。
   */
  control(frame: Record<string, unknown>): Promise<unknown>;
}

/** 常驻监护壳：拉起 + 循环监护（心跳 / idle / 崩溃三面）+ 插件失败回报 */
export async function superviseShell(
  input: SuperviseSpawnInput,
  options: SuperviseOptions,
): Promise<SuperviseHandle> {
  const config = { ...DEFAULT_GUARDIAN_CONFIG, ...options.config };
  const now = options.now ?? Date.now;
  const tickMs = options.tickIntervalMs ?? config.heartbeatIntervalMs;
  // 退避档（cr-551）：respawnDelayMs 语义从「固定档」改为「基数」；缺省值
  // 与主线 supervisor-core DEFAULT_SUPERVISION_POLICY 同源（base 1.5s / factor
  // 2 / cap 60s / jitter 0.2 / bootOk 30s）——壳级与宿主进程级监护档一致。
  // 指数位 = 自持 streak（存活驱动，主线语义）：壳活过 bootOkMs 后崩溃 =
  // 稳定壳偶发崩归零基档；窗内即崩（启动失败族）才累计抬档。
  const respawnBaseMs = options.respawnDelayMs ?? 1_500;
  const backoffFactor = options.backoffFactor ?? 2;
  const backoffCapMs = options.backoffCapMs ?? 60_000;
  const bootOkMs = options.bootOkMs ?? 30_000;
  let backoffStreak = 0;
  let adoptedAt = 0;
  const warden = new ShellWarden(input.agentId, config);
  const events: GuardianEvent[] = [];
  const superviseEvents: SuperviseEvent[] = [];
  const adoptedCallbacks: Array<(hint: string) => void> = [];
  let attempt = 0;
  let stopped = false;
  let broken = false;
  let starting = false;
  let current: AdoptedShellFace | null = null;
  let respawnTimer: ReturnType<typeof setTimeout> | null = null;

  const pushEvent = (e: SuperviseEvent): void => { superviseEvents.push(e); };

  /** plugin.load-failed TSV 行解析（字段：插件名 / 错误摘要） */
  const parseLoadFailed = (line: string): { plugin: string; error: string } | null => {
    const [signal, ...fields] = line.split('\t');
    if (signal !== 'plugin.load-failed') return null;
    const plugin = (fields[0] ?? '').trim();
    if (plugin === '') return null;
    return { plugin, error: (fields[1] ?? '').trim() };
  };

  /** 退避延迟（主线 decideOnExit 同构：delay 用累计前 streak） */
  const backoffDelay = (streak: number): number => {
    const raw = Math.min(backoffCapMs, respawnBaseMs * Math.pow(backoffFactor, streak));
    // jitter ±20%（防同批崩溃风暴同步重拉）——主线 applyJitter 同式内联
    const jitter = 1 + (Math.random() * 2 - 1) * 0.2;
    return Math.max(0, Math.round(raw * jitter));
  };

  // —— 拉起 + 接线（重拉同链） ——
  const start = async (): Promise<void> => {
    if (starting || current !== null) return;
    starting = true;
    try {
      attempt++;
      const shell = await options.adopt(input);
      current = shell;
      events.push(...shell.events);
      const adopted = shell.events.find((e) => e.type === 'adopted');
      if (adopted !== undefined) {
        adoptedAt = now();
        pushEvent({ type: 'adopted', agentId: input.agentId, bootId: adopted.bootId, transportHint: adopted.transportHint });
        // adopted 订阅面（cr-551 编排面）：re-tap 等消费方经此接线，每次
        // 拉起/重拉成功都触发（新壳新连接——旧 tap 由消费方幂等收旧）
        for (const cb of adoptedCallbacks) {
          try { cb(adopted.transportHint); } catch { /* 订阅方异常不阻断监护链 */ }
        }
      }
      // TSV 行流：心跳/run 节拍喂 warden（三节拍后继续——常驻监护数据源）
      shell.onLine((line) => {
        warden.feedLine(line, now());
        // 插件装载失败回报（cr-543 遗留接线）：壳→宿主单向
        const failure = parseLoadFailed(line);
        if (failure !== null && options.onPluginLoadFailure !== undefined) {
          void options.onPluginLoadFailure(failure.plugin, failure.error).catch(() => {
            /* 回报失败不重试——宿主在场时下轮装载失败仍回报（计数以宿主侧档为准） */
          });
        }
      });
      // 壳退出 → warden 判定（respawn / broken / done）
      shell.onExit((code) => {
        events.push({ type: 'shell-exit', agentId: input.agentId, code });
        pushEvent({ type: 'shell-exit', agentId: input.agentId, code });
        input.reach.markGone(input.agentId);
        current = null;
        if (stopped) return;
        const ruling = warden.shellExited(code, now());
        if (ruling === 'broken') {
          broken = true;
          const last = warden.emitted().at(-1);
          const crashes = last !== undefined && last.type === 'circuit-broken'
            ? last.consecutiveCrashes
            : config.crashBackoffLimit;
          pushEvent({ type: 'circuit-broken', agentId: input.agentId, consecutiveCrashes: crashes });
          return;
        }
        if (ruling === 'respawn') {
          // 存活驱动 streak（主线 supervisor-core decideOnExit 同构）：活过
          // bootOkMs 的崩溃归零（稳定壳偶发），窗内即崩累计（启动失败族）；
          // 延迟用累计前 streak（首崩 = 基档）
          const livedMs = adoptedAt > 0 ? now() - adoptedAt : 0;
          const streak = livedMs >= bootOkMs ? 0 : backoffStreak;
          const delayMs = backoffDelay(streak);
          backoffStreak = streak + 1;
          pushEvent({ type: 'respawned', agentId: input.agentId, attempt: attempt + 1, delayMs });
          respawnTimer = setTimeout(() => {
            void start().catch(() => { /* 拉起失败保持死态——来件触发按需拉起 */ });
          }, delayMs);
        }
        // done = 正常退出（idle 自杀 / shutdown）——不重拉（来件按需拉起）
      });
    } finally {
      starting = false;
    }
  };

  await start();

  // —— 监护循环（unref——宿主不被监护定时器吊命；测试经 tickPump 同步泵） ——
  const onTick = (): void => {
    if (stopped || broken) return;
    const ruling = warden.tick(now());
    if (ruling === 'ok') return;
    const reason = ruling === 'declare-dead' ? 'heartbeat-lost' : 'idle-exit';
    pushEvent({ type: 'declared-dead', agentId: input.agentId, reason });
    events.push({ type: 'declared-dead', agentId: input.agentId, reason });
    if (reason === 'heartbeat-lost') {
      current?.kill(); // 假死壳强杀——退出回调走 crash 分支（respawn/broken）
    } else {
      input.reach.markGone(input.agentId); // idle 收割：清表（壳自杀在途——退出回调走 done）
    }
  };
  const stopPump: () => void = options.tickPump !== undefined
    ? options.tickPump(onTick, tickMs)
    : (() => {
        const timer = setInterval(onTick, tickMs);
        timer.unref();
        return () => clearInterval(timer);
      })();

  const stop = (): void => {
    stopped = true;
    if (respawnTimer !== null) clearTimeout(respawnTimer);
    stopPump();
  };

  /** 控制帧转发（cr-552 跨进程 dry-run）：无活壳按需拉起（idle 自杀/正常
   * 退出后——与 ensureAgent 同语义）；熔断态抛错（不静默半拉起）。 */
  const doControl = async (frame: Record<string, unknown>): Promise<unknown> => {
    if (broken) throw new Error('壳已熔断（' + input.agentId + '）——控制帧无面');
    if (current === null) {
      if (stopped) throw new Error('监护已停（' + input.agentId + '）——不再拉起');
      await start();
    }
    return current!.control(frame);
  };

  return {
    agentId: input.agentId,
    events,
    superviseEvents,
    shutdown: async () => { stop(); return current?.shutdown() ?? null; },
    kill: () => { stop(); current?.kill(); },
    stop,
    isBroken: () => broken,
    restart: async () => {
      if (broken) throw new Error('壳已熔断（' + input.agentId + '）——宿主重启入口解，不自动重拉');
      if (stopped) throw new Error('监护已停（' + input.agentId + '）——不再拉起');
      if (current !== null || starting) return; // 在监护中——幂等复用
      await start();
    },
    onAdopted: (cb) => { adoptedCallbacks.push(cb); },
    control: (frame) => doControl(frame),
  };
}

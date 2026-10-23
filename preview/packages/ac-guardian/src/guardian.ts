// ============================================================
// guardian.ts —— 宿主监护（S2 监护职责；协议规格 D 节）
//
// 拉起三节拍：spawn 壳 → 消费 stdout TSV（boot.lock.acquired /
// boot.rows.ready / boot.ready）→ adopt（可达表登记 transportHint）。
// 心跳监视：guardian.ping 周期（缺省 30s；3 拍丢失判死）；
// idle-exit 收割：空闲超时优雅终止（壳按需拉起——省内存是产品题）；
// 崩溃退避熔断：连续崩溃 ≥3 → 熔断（不再自动拉起，宿主重启入口解）。
// 进程 IO（spawn/kill）注入——状态机纯域可测。
// ============================================================

/** 壳进程句柄（IO 注入面） */
export interface ShellProcess {
  pid: number;
  /** stdout 数据订阅（TSV 行流） */
  onStdoutLine(line: string): void;
  /** 优雅终止请求 */
  kill(): void;
  /** 退出订阅 */
  onExit(cb: (code: number | null) => void): void;
}

export type GuardianEvent =
  | { type: 'adopted'; agentId: string; bootId: string; transportHint: string; fingerprintRoot?: string }
  | { type: 'rows-ready'; agentId: string; bootId: string; rows: number }
  | { type: 'shell-exit'; agentId: string; code: number | null }
  | { type: 'declared-dead'; agentId: string; reason: 'heartbeat-lost' | 'idle-exit' | 'crash' }
  | { type: 'circuit-broken'; agentId: string; consecutiveCrashes: number };

/** 监护配置（协议规格 F 表钉值 cr-528：心跳 30s×3 拍 / idle-exit 15min / 熔断 60s 内 3 次） */
export interface GuardianConfig {
  heartbeatIntervalMs: number;
  heartbeatMissLimit: number;
  idleExitMs: number;
  crashBackoffLimit: number;
  /** 崩溃熔断时间窗（ms）：窗外的崩溃不计入连续数（D2 节拍 3 崩溃退避） */
  crashWindowMs: number;
}

export const DEFAULT_GUARDIAN_CONFIG: GuardianConfig = {
  heartbeatIntervalMs: 30_000,
  heartbeatMissLimit:  3,
  idleExitMs: 15 * 60_000,
  crashBackoffLimit: 3,
  crashWindowMs: 60_000,
};

/** 单 agent 监护状态机（纯域——时钟与进程注入） */
export class ShellWarden {
  private adopted = false;
  private lastHeartbeatAt = 0;
  private missedBeats = 0;
  private lastActiveAt = 0;
  private consecutiveCrashes = 0;
  /** 窗口首崩时刻（undefined = 无在窗崩溃——下次崩起重算窗） */
  private crashWindowStart: number | undefined;
  private broken = false;
  private terminated = false;
  private readonly events: GuardianEvent[] = [];

  private readonly agentId: string;
  private readonly config: GuardianConfig;

  constructor(agentId: string, config: GuardianConfig = DEFAULT_GUARDIAN_CONFIG) {
    this.agentId = agentId;
    this.config = config;
  }

  /** 已收事件（测试/诊断面） */
  emitted(): GuardianEvent[] {
    return [...this.events];
  }

  isAdopted(): boolean {
    return this.adopted;
  }

  isBroken(): boolean {
    return this.broken;
  }

  /**
   * 拉起序列：喂 stdout TSV 行（三节拍推进）。
   * boot.ready → adopted（可达登记由宿主接线——本状态机只发事件）。
   */
  feedLine(line: string, now: number): void {
    const [signal, ...fields] = line.split('\t');
    if (signal === 'boot.rows.ready') {
      if (fields.length > 1) {
        this.events.push({ type: 'rows-ready', agentId: this.agentId, bootId: fields[0] ?? '', rows: Number(fields[1]) });
      }
      return;
    }
    if (signal === 'boot.lock.acquired') return;
    if (signal === 'boot.ready') {
      this.adopted = true;
      this.lastHeartbeatAt = now;
      this.lastActiveAt = now;
      const fingerprintRoot = fields.length > 2 ? fields[2] : undefined;
      this.events.push({
        type: 'adopted', agentId: this.agentId,
        bootId: fields[0] ?? '', transportHint: fields[1] ?? '',
        ...(fingerprintRoot !== undefined ? { fingerprintRoot } : {}),
      });
      return;
    }
    if (signal === 'guardian.ping') {
      this.lastHeartbeatAt = now;
      this.missedBeats = 0;
      return;
    }
    // run 节拍 = 活跃证据（idle 计时重置）
    if (signal === 'run.started' || signal === 'run.settled') {
      this.lastActiveAt = now;
    }
  }

  /**
   * 时钟节拍（宿主定时器驱动）：心跳丢失判定 + idle 收割决策。
   * 返回 'kill' = 宿主应优雅终止壳。
   */
  tick(now: number): 'ok' | 'declare-dead' | 'kill-idle' {
    if (!this.adopted || this.terminated) return 'ok';
    const sinceBeat = now - this.lastHeartbeatAt;
    if (sinceBeat > this.config.heartbeatIntervalMs * (this.missedBeats + 1)) {
      this.missedBeats++;
      if (this.missedBeats >= this.config.heartbeatMissLimit) {
        this.terminated = true;
        this.events.push({ type: 'declared-dead', agentId: this.agentId, reason: 'heartbeat-lost' });
        return 'declare-dead';
      }
    }
    if (now - this.lastActiveAt >= this.config.idleExitMs) {
      this.terminated = true;
      this.events.push({ type: 'declared-dead', agentId: this.agentId, reason: 'idle-exit' });
      return 'kill-idle';
    }
    return 'ok';
  }

  /**
   * 壳退出处理：崩溃计数 + 熔断判定。返回 'respawn' = 宿主应重拉。
   * 计数带时间窗（F 表：60s 内 3 次）：窗外崩不累加，窗起算点重置。
   */
  shellExited(code: number | null, now: number): 'respawn' | 'broken' | 'done' {
    this.adopted = false;
    this.events.push({ type: 'shell-exit', agentId: this.agentId, code });
    if (this.broken) return 'done';
    if (code === 0) {
      this.consecutiveCrashes = 0;
      this.crashWindowStart = undefined;
      return 'done'; // 正常退出（idle 收割/迁移）
    }
    // 窗判定：距窗首崩超窗 → 窗滚动（计数保持但从头累计）
    if (this.crashWindowStart !== undefined && now - this.crashWindowStart > this.config.crashWindowMs) {
      this.consecutiveCrashes = 0;
      this.crashWindowStart = undefined;
    }
    if (this.crashWindowStart === undefined) this.crashWindowStart = now;
    this.consecutiveCrashes++;
    if (this.consecutiveCrashes >= this.config.crashBackoffLimit) {
      this.broken = true;
      this.events.push({ type: 'circuit-broken', agentId: this.agentId, consecutiveCrashes: this.consecutiveCrashes });
      return 'broken';
    }
    return 'respawn';
  }
}

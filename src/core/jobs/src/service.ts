// ============================================================
// @agentchat/jobs/src/service.ts —— 通用后台任务注册表（ctx.jobs）
//
// 第二阶段（docs/tool-design-roadmap.md §2）：把 bash background 的
// 模块级登记表提升为通用 cordis Service，统一任务词汇：
//
//   start({ kind, label, ownerAgentId, run }) → 不透明 id（<kind>-N）
//     run() 返回 JobHooks = { cancel, done, readOutput? }
//       · cancel(reason?) —— 请求取消（kill 路径）
//       · done: Promise<JobOutcome> —— 终态（completed/killed/failed，first-wins）
//       · readOutput?() —— 增量/结果文本（logs 路径）
//
// 语义（对齐 DSH ctx.jobs，见 docs/dsh-jobs-comparison.md §2）：
//   · owner 分桶：list/get/kill/read 只作用于同 ownerAgentId 的任务
//     （ownerAgentId 缺省 = 无主，任何 caller 可读；job 工具总传本 Agent id）；
//   · 每 owner 活跃（running/stopping）上限 maxConcurrentJobsPerOwner（默认 8）；
//   · settle 先到先得：一个终态记录，完成监听（onJobDone）只触发一轮；
//   · 登记比 producer 的调用活得更久（done promise 驱动，不依赖调用方）；
//   · 宿主侧（boot）经 onJobDone 接线 → router 事件广播（job.done）。
//
// 与 DSH 的差异（有意简化）：无 wait/阻塞读、无持久化（重启即失）、
// 无 owner 会话级生命周期联动（AgentChat 无 per-session composition）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';

/** 任务终态（running/stopping 由注册表内部管理，producer 只报终态） */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed';

/** producer 上报的终局（非零退出 = completed + detail，报告不报错） */
export interface JobOutcome {
  status: Exclude<JobStatus, 'running' | 'stopping'>;
  /** 人类可读的终态说明（如 `exit code: 0` / `signal: SIGKILL`） */
  detail?: string;
  /** 终态输出（readOutput 缺省时，job read 兜底返回此值） */
  output?: string;
}

/** producer 提供的任务钩子（bash / subagent / timer 等异步能力适配点） */
export interface JobHooks {
  /** 请求取消（kill 路径）：杀掉进程树 / abort 控制器等；可异步 */
  cancel: (reason?: string) => void | Promise<void>;
  /** 终态 promise：任务 settle 时 resolve 为 JobOutcome（first-wins） */
  done: Promise<JobOutcome>;
  /** 读取任务输出（可选；logs 路径；返回增量/结果文本） */
  readOutput?: () => string;
}

/** start 入参：producer 声明任务身份与执行钩子 */
export interface JobStartSpec {
  /** kind 前缀（id = `<kind>-N`，如 bash-1 / subagent-2） */
  kind: string;
  /** 展示标签（如原始命令 / 子任务摘要） */
  label: string;
  /** 归属 Agent id（owner 分桶与访问隔离；缺省 = 无主） */
  ownerAgentId?: string;
  /** producer 私有元数据（bash: pid/logFile/cwd；subagent: subagentId…） */
  meta?: Record<string, unknown>;
  /** 执行钩子工厂（start 时同步调用；producer 在此 spawn/启动并装配 hooks） */
  run: () => JobHooks;
}

/** 注册表快照（只读投影；供 list/get/kill/read 与 onJobDone 监听消费） */
export interface JobSnapshot {
  id: string;
  kind: string;
  label: string;
  status: JobStatus;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
  meta?: Record<string, unknown>;
}

/** 完成监听（settle 后触发一次；宿主接线 → job.done 事件广播） */
export type JobDoneListener = (job: JobSnapshot) => void;

interface JobRecord extends JobSnapshot {
  cancel: (reason?: string) => void | Promise<void>;
  done: Promise<JobOutcome>;
  readOutput?: () => string;
}

/** 默认每 owner 活跃任务上限 */
export const DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER = 8;

/** 判断是否终态 */
function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed';
}

export class JobService extends Service {
  private store = new Map<string, JobRecord>();
  private counters = new Map<string, number>();
  /** 完成监听（boot 接线；注册表只保证触发一轮） */
  private listeners = new Set<JobDoneListener>();
  /** 每 owner 活跃任务上限 */
  private maxPerOwner: number;

  constructor(ctx: Context, config: { maxConcurrentJobsPerOwner?: number } = {}) {
    super(ctx, 'jobs');
    this.maxPerOwner = config.maxConcurrentJobsPerOwner ?? DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER;
  }

  /**
   * 登记并启动任务，返回不透明 id（`<kind>-N`）。
   * 超出 owner 活跃上限抛错（producer 侧捕获返回错误给模型）。
   */
  start(spec: JobStartSpec): string {
    if (spec.kind.trim().length === 0) throw new Error('invalid job kind: expected a non-empty string');
    if (spec.label.trim().length === 0) throw new Error('invalid job label: expected a non-empty string');
    if (spec.ownerAgentId !== undefined) {
      const active = [...this.store.values()].filter(
        (j) => j.meta?.ownerAgentId === spec.ownerAgentId && (j.status === 'running' || j.status === 'stopping'),
      ).length;
      if (active >= this.maxPerOwner) {
        throw new Error(
          `后台任务数已达上限（${this.maxPerOwner}）; 先用 job kill 停掉不需要的任务，或等待其完成后再启动`,
        );
      }
    }

    const hooks = spec.run();
    const count = (this.counters.get(spec.kind) ?? 0) + 1;
    this.counters.set(spec.kind, count);
    const id = `${spec.kind}-${count}`;
    const record: JobRecord = {
      id,
      kind: spec.kind,
      label: spec.label,
      status: 'running',
      startedAt: Date.now(),
      ...(spec.ownerAgentId !== undefined ? { meta: { ...spec.meta, ownerAgentId: spec.ownerAgentId } } : { meta: spec.meta }),
      cancel: hooks.cancel,
      done: hooks.done,
      ...(hooks.readOutput !== undefined ? { readOutput: hooks.readOutput } : {}),
    };
    this.store.set(id, record);
    hooks.done.then(
      (outcome) => this.settle(record, outcome),
      (error) => this.settle(record, {
        status: 'failed',
        detail: `producer done rejected: ${String(error)}`,
      }),
    );
    return id;
  }

  /** 按 owner 列任务（ownerAgentId 缺省 = 全部，宿主/诊断用；工具总传本 Agent id） */
  list(ownerAgentId?: string): JobSnapshot[] {
    return [...this.store.values()]
      .filter((j) => ownerAgentId === undefined || j.meta?.ownerAgentId === ownerAgentId)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((j) => this.snapshot(j));
  }

  /** 按 id 取快照（含 owner 断言；未知/跨 owner 抛错） */
  get(id: string, ownerAgentId?: string): JobSnapshot {
    return this.snapshot(this.expect(id, ownerAgentId));
  }

  /** 读取任务输出（readOutput → 兜底终态 output → 空串） */
  read(id: string, ownerAgentId?: string): { text: string; job: JobSnapshot } {
    const job = this.expect(id, ownerAgentId);
    const text = job.readOutput !== undefined ? job.readOutput() : (isTerminal(job.status) ? job.detail ?? '' : '');
    return { text, job: this.snapshot(job) };
  }

  /**
   * 按 id 请求取消（仅已登记 id）：置 stopping + 调 producer.cancel；
   * 真正的 killed/completed 由 done promise 回写。已终态 → already-finished。
   */
  kill(id: string, ownerAgentId?: string, reason?: string): { outcome: 'cancellation-requested' | 'already-finished'; job: JobSnapshot } {
    const job = this.expect(id, ownerAgentId);
    if (isTerminal(job.status)) {
      return { outcome: 'already-finished', job: this.snapshot(job) };
    }
    job.status = 'stopping';
    try {
      void job.cancel(reason);
    } catch (err) {
      this.settle(job, { status: 'failed', detail: `cancel threw: ${String(err)}` });
    }
    return { outcome: 'cancellation-requested', job: this.snapshot(job) };
  }

  /** 注册完成监听（唯一职责：settle 后触发一轮；宿主 boot 接线 → 事件广播） */
  onJobDone(listener: JobDoneListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 全部任务数（诊断/测试用） */
  get size(): number {
    return this.store.size;
  }

  // ---- internal ----

  private expect(id: string, ownerAgentId?: string): JobRecord {
    const job = this.store.get(id);
    if (!job) throw new Error(`未知后台任务 ${id}（job list 查看当前任务）`);
    if (ownerAgentId !== undefined && job.meta?.ownerAgentId !== undefined && job.meta.ownerAgentId !== ownerAgentId) {
      throw new Error(`后台任务 ${id} 属于其他 Agent，无权操作`);
    }
    return job;
  }

  /** settle：first-wins（一个终态记录）+ 完成监听触发一轮 */
  private settle(job: JobRecord, outcome: JobOutcome): void {
    if (isTerminal(job.status)) return;
    job.status = outcome.status;
    job.detail = outcome.detail;
    if (outcome.output !== undefined) job.meta = { ...job.meta, output: outcome.output };
    job.finishedAt = Date.now();
    const snapshot = this.snapshot(job);
    for (const listener of [...this.listeners]) {
      try { listener(snapshot); } catch { /* 监听失败不阻塞 settle */ }
    }
  }

  private snapshot(job: JobRecord): JobSnapshot {
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      ...(job.detail !== undefined ? { detail: job.detail } : {}),
      startedAt: job.startedAt,
      ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
      ...(job.meta !== undefined && Object.keys(job.meta).length > 0 ? { meta: job.meta } : {}),
    };
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 通用后台任务注册表（由 @agentchat/jobs 提供） */
    jobs: JobService;
  }
}

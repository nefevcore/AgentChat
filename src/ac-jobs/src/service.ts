// ============================================================
// ac-jobs/src/service.ts —— 后台任务注册中心（cordis Service）
//
// 本包同时是任务域契约的 owning package：域类型见 ./contract.ts，
// job/* 事件目录见 ./events.ts（谁 emit 谁声明）。
//
// ctx.jobs：start/list/get/kill/read + job/settled(E)。
// src core/jobs 语义原样继承（owner 分桶 / 每 owner 活跃上限 /
// settle first-wins / 登记活得比 producer 调用久——done promise 驱动）；
// 完成通知从私有 listener 数组改为 ctx.emit('job/settled')
// （监听器随订阅方 fiber 撤销，零接线）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type { JobOutcome, JobSnapshot, JobStartSpec, JobStatus } from './contract.ts';

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

export interface JobsRowOptions {
  /** 每 owner 活跃（running/stopping）任务上限（缺省 8） */
  maxConcurrentJobsPerOwner?: number;
}

export class JobsService extends Service {
  private store = new Map<string, JobRecord>();
  private counters = new Map<string, number>();
  private maxPerOwner: number;

  constructor(ctx: Context, options: JobsRowOptions = {}) {
    super(ctx, 'jobs');
    this.maxPerOwner = options.maxConcurrentJobsPerOwner ?? DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER;
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
        (j) => j.ownerAgentId === spec.ownerAgentId && (j.status === 'running' || j.status === 'stopping'),
      ).length;
      if (active >= this.maxPerOwner) {
        throw new Error(
          `后台任务数已达上限（${this.maxPerOwner}）；先用 job kill 停掉不需要的任务，或等待其完成后再启动`,
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
      ...(spec.ownerAgentId !== undefined ? { ownerAgentId: spec.ownerAgentId } : {}),
      ...(spec.conversationId !== undefined ? { conversationId: spec.conversationId } : {}),
      ...(spec.meta !== undefined ? { meta: spec.meta } : {}),
      cancel: hooks.cancel,
      done: hooks.done,
      ...(hooks.readOutput !== undefined ? { readOutput: hooks.readOutput } : {}),
    };
    this.store.set(id, record);
    void hooks.done.then(
      (outcome) => this.settle(record, outcome),
      (error: unknown) =>
        this.settle(record, {
          status: 'failed',
          detail: `producer done rejected: ${String(error)}`,
        }),
    );
    return id;
  }

  /** 按 owner 列任务（ownerAgentId 缺省 = 全部，宿主/诊断用；工具总传本 Agent id） */
  list(ownerAgentId?: string): JobSnapshot[] {
    return [...this.store.values()]
      .filter((j) => ownerAgentId === undefined || j.ownerAgentId === ownerAgentId)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((j) => this.snapshot(j));
  }

  /** 按 id 取快照（含 owner 断言；未知/跨 owner 抛错） */
  get(id: string, ownerAgentId?: string): JobSnapshot {
    return this.snapshot(this.expect(id, ownerAgentId));
  }

  /** 读取任务输出（readOutput → 兜底终态 detail → 空串） */
  read(id: string, ownerAgentId?: string): { text: string; job: JobSnapshot } {
    const job = this.expect(id, ownerAgentId);
    const text =
      job.readOutput !== undefined ? job.readOutput() : isTerminal(job.status) ? job.detail ?? '' : '';
    return { text, job: this.snapshot(job) };
  }

  /**
   * 按 id 请求取消（仅已登记 id）：置 stopping + 调 producer.cancel；
   * 真正的 killed/completed 由 done promise 回写。已终态 → already-finished。
   */
  kill(
    id: string,
    ownerAgentId?: string,
    reason?: string,
  ): { outcome: 'cancellation-requested' | 'already-finished'; job: JobSnapshot } {
    const job = this.expect(id, ownerAgentId);
    if (isTerminal(job.status)) {
      return { outcome: 'already-finished', job: this.snapshot(job) };
    }
    job.status = 'stopping';
    try {
      // C1：producer.cancel 可返回 Promise（如进程树 kill）——rejection
      // 悬空即 unhandledRejection；收敛为该任务 failed，不上炸宿主
      void Promise.resolve(job.cancel(reason)).catch((err: unknown) => {
        this.settle(job, { status: 'failed', detail: `cancel rejected: ${String(err)}` });
      });
    } catch (err: unknown) {
      this.settle(job, { status: 'failed', detail: `cancel threw: ${String(err)}` });
    }
    return { outcome: 'cancellation-requested', job: this.snapshot(job) };
  }

  /** 全部任务数（诊断/测试用） */
  get size(): number {
    return this.store.size;
  }

  // ---- internal ----

  private expect(id: string, ownerAgentId?: string): JobRecord {
    const job = this.store.get(id);
    if (!job) throw new Error(`未知后台任务 ${id}（job list 查看当前任务）`);
    if (ownerAgentId !== undefined && job.ownerAgentId !== undefined && job.ownerAgentId !== ownerAgentId) {
      throw new Error(`后台任务 ${id} 属于其他 Agent，无权操作`);
    }
    return job;
  }

  /** settle：first-wins（一个终态记录）+ job/settled 事件（一轮） */
  private settle(job: JobRecord, outcome: JobOutcome): void {
    if (isTerminal(job.status)) return;
    job.status = outcome.status;
    job.detail = outcome.detail;
    if (outcome.output !== undefined) job.meta = { ...job.meta, output: outcome.output };
    job.finishedAt = Date.now();
    this.ctx.emit('job/settled', this.snapshot(job));
  }

  private snapshot(job: JobRecord): JobSnapshot {
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      ...(job.ownerAgentId !== undefined ? { ownerAgentId: job.ownerAgentId } : {}),
      ...(job.conversationId !== undefined ? { conversationId: job.conversationId } : {}),
      ...(job.detail !== undefined ? { detail: job.detail } : {}),
      startedAt: job.startedAt,
      ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
      ...(job.meta !== undefined && Object.keys(job.meta).length > 0 ? { meta: job.meta } : {}),
    };
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 后台任务注册中心（ac-jobs 提供）：start/list/get/kill/read + job/settled(E) */
    jobs: JobsService;
  }
}

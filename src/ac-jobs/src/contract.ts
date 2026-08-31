// ============================================================
// ac-jobs/src/contract.ts —— 后台任务域契约（纯类型，零运行时）
//
// src core/jobs 平移（地图 §3.1）：统一任务词汇——bash 后台 / subagent /
// timer 等异步能力都以 JobHooks 形态登记，list/get/kill/read 统一消费。
// 语义原样继承：owner 分桶、每 owner 活跃上限、settle first-wins、
// 登记比 producer 调用活得久（done promise 驱动）。
// ============================================================

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
  /** 归属 Agent id（owner 分桶与访问隔离；缺省 = 无主，任何 caller 可读） */
  ownerAgentId?: string;
  /** producer 私有元数据（bash: pid/logFile/cwd；subagent: subagentId…） */
  meta?: Record<string, unknown>;
  /** 执行钩子工厂（start 时同步调用；producer 在此 spawn/启动并装配 hooks） */
  run: () => JobHooks;
}

/** 注册表快照（只读投影；供 list/get/kill/read 与 job/settled 消费） */
export interface JobSnapshot {
  id: string;
  kind: string;
  label: string;
  status: JobStatus;
  /** 归属 Agent id（owner 分桶键；无主任务缺省） */
  ownerAgentId?: string;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
  meta?: Record<string, unknown>;
}

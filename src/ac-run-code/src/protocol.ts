// ============================================================
// ac-run-code/src/protocol.ts —— 主线程 ⇄ worker 桥接协议（纯类型）
//
// 结构化克隆可序列化（无函数/无引用逃逸面）。主线程是唯一执行方
// （worker = containment 非 boundary，DSH 口径）：子调用全部发回
// ctx.tools.execute 走全安全面；worker 只做资源约束与控制流。
// ============================================================

/** 主线程 → worker：启动载荷（worker 就绪后第一条消息） */
export interface WorkerInit {
  type: 'init';
  /** 运行 id（run_code 调用的 toolCallId 缺省合成） */
  runId: string;
  /** 可擦除 TS 程序体 */
  code: string;
  /** 预算：子调用累计执行耗时上限毫秒（0 = 不限） */
  computeMs: number;
  /** 预算：墙钟上限毫秒（含审批等待；0 = 不限） */
  maxWallMs: number;
  /** 预算：返回值序列化字节上限（0 = 不限） */
  maxOutputBytes: number;
  /**
   * 会话级 lib 注册表注入（2026-09-17 lib 扩展）：key = 库名，value =
   * 源码文本（函数源码或含 return 的程序体——worker 侧前置求值）。
   * 主线程 run 间持有（同 agent+conversation 命名空间），worker 即用即弃。
   */
  libSource?: Record<string, string>;
}

/** 主线程 → worker：子调用结果回填 */
export interface WorkerInvokeResult {
  type: 'result';
  seq: number;
  ok: boolean;
  output?: unknown;
  error?: string;
}

/** 主线程 → worker：中止（用户中断/超预算） */
export interface WorkerAbort {
  type: 'abort';
  reason: string;
}

export type MainToWorker = WorkerInit | WorkerInvokeResult | WorkerAbort;

/** worker → 主线程：就绪 */
export interface WorkerReady {
  type: 'ready';
}

/** worker → 主线程：子调用请求（结构化克隆传值） */
export interface WorkerInvoke {
  type: 'invoke';
  seq: number;
  name: string;
  args: Record<string, unknown>;
}

/** worker → 主线程：程序终值 */
export interface WorkerDone {
  type: 'done';
  ok: boolean;
  /** return 值（序列化 + 截断后） */
  value?: unknown;
  /** value 来源（复合返回协议）：'return' = 程序 return 值；'logs' = 无 return 值时 log 收集合成的文本 */
  valueVia?: 'return' | 'logs';
  /** 错误（编译/执行/预算/中止） */
  error?: string;
  /** 中止（interrupt 语义——loop 收束 interrupted） */
  interrupted?: boolean;
  /** 失败/中止时程序已收集 log 的末 5 条（诊断线索；成功不带） */
  logsTail?: string[];
  /** 执行摘要（子调用计数/耗时/被拒清单） */
  summary: RunSummary;
  /**
   * 本轮程序的 lib 导出（lib 扩展）：程序经 lib.define 注册的全部条目
   * （含此前已注册的存量——注册表整体快照，主线程全量覆写）。结构化
   * 克隆可序列化（源码文本）。
   */
  libExports?: Record<string, string>;
}

export type WorkerToMain = WorkerReady | WorkerInvoke | WorkerDone;

/** 执行摘要（入步记录 output 的骨架——裁决 #1：程序体全文不回上下文） */
export interface RunSummary {
  /** 子调用总数 */
  calls: number;
  /** 成功/失败计数 */
  ok: number;
  failed: number;
  /** 子调用累计执行耗时毫秒（审批等待不计入——ac-tools durationMs 口径） */
  computeMs: number;
  /** 墙钟毫秒（含审批等待） */
  wallMs: number;
  /**
   * 预算冻结区间毫秒（ask_questions/approval 用户应答等待期）：含在
   * wallMs 内但不计入 compute/墙钟预算（预算约束机器时间，人的应答
   * 时间不是机器时间）。无冻结区间时省略。
   */
  frozenMs?: number;
  /** 被安全面拒绝的子调用（name + error） */
  denied: Array<{ name: string; error: string }>;
  /** 串行执行的子调用 seq（写路径/命令类，提交序） */
  serialized: number[];
  /**
   * 子调用轨迹（UI 卡片「工具调用」段数据源；二测复盘：卡片要能展示
   * 调用了哪些工具——紧凑摘要级，不回原始结果）。上限 50 条，超出
   * 计入 traceTruncated。
   */
  trace: SubcallTrace[];
  /** 超上限截掉的子调用数（trace 上限 50） */
  traceTruncated?: number;
}

/** 单条子调用轨迹（紧凑摘要——name + 一句话 + 耗时 + 状态） */
export interface SubcallTrace {
  seq: number;
  name: string;
  ok: boolean;
  /** 执行耗时毫秒 */
  ms: number;
  /** 一句话简述（subcallBrief 生成：关键参数/结果字段，截 80 字符） */
  brief: string;
  /** 失败时的错误（截 200） */
  error?: string;
}

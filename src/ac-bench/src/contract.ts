// ============================================================
// ac-bench/src/contract.ts —— 评测域契约（纯类型，零运行时）
//
// 契约归属 owning package：谁提供 ctx.bench，谁声明本域类型与
// bench/* 事件（events.ts）。
//
// 设计要点：
//   · 域模型与具体基准解耦——BenchCase 是"提示词 + 临时工具集 +
//     期望调用"的中性形状，BFCL/τ²/Terminal-Bench 适配器负责把
//     各自的数据集翻译进来（谁翻译谁住 suites/，服务零基准知识）；
//   · 期望调用是"可接受值集合"形状（argsSpec 每参数一列可接受值，
//     BFCL ground_truth 语义），对拍逻辑见 eval.ts；
//   · 评测跑批 = 机制 run（meta 带 ARCHIVE_REVIEW_META，不入会话
//     账 / 不记 usage / 不进上下文视图——M20 机制标记语义）。
// ============================================================

/** 用例临时工具定义（进模型可见的 schema 面；执行体由服务合成桩） */
export interface BenchToolDef {
  name: string;
  description?: string;
  /** JSON Schema（参数表） */
  parameters?: Record<string, unknown>;
}

/**
 * 期望调用（对拍规格）：name + 每参数可接受值列表。
 *   · argsSpec 缺省/空 = 无参调用（模型不得带参）；
 *   · 列表多值 = 任一可接受（BFCL ground_truth 的 possible values 语义）；
 *   · expected 为空数组 = 反例用例（模型不应调用任何工具）。
 */
export interface BenchCallSpec {
  name: string;
  argsSpec?: Record<string, unknown[]>;
}

/** 实际调用（从 run 步记录聚合；arguments JSON 解析后的参数对象） */
export interface BenchActualCall {
  name: string;
  args: Record<string, unknown>;
}

/** 单个评测用例（中性形状，各基准适配器负责翻译） */
export interface BenchCase {
  /** 稳定用例 id（报告行/过滤锚点；建议 `<category>-<原 id>`） */
  id: string;
  /** 类目标签（报告分组用；可空） */
  category?: string;
  /** 用户提示词（驱动 run 的唯一 user 消息） */
  prompt: string;
  /** 基准自带系统提示词片段（与 run 级 system 拼接） */
  systemHint?: string;
  /** 本用例暴露给模型的临时工具集 */
  tools: BenchToolDef[];
  /** 期望调用集合（空 = 反例用例） */
  expected: BenchCallSpec[];
}

/** 评测套件（数据源无关；load 幂等可重复调用） */
export interface BenchSuite {
  name: string;
  description?: string;
  load(): Promise<BenchCase[]>;
}

/** 单用例判定结果 */
export interface BenchCaseResult {
  id: string;
  category?: string;
  pass: boolean;
  /** 未过原因（缺失/多余/参数不符/执行错误） */
  reason?: string;
  /** run 收束态（stop/max-steps/error/interrupted/veto） */
  finish?: string;
  /** ReAct 步数 */
  steps: number;
  durationMs: number;
  expected: BenchCallSpec[];
  actual: BenchActualCall[];
  /** 累加轨输入 token（run usage.promptAccumulated） */
  promptTokens: number;
  /** 累加轨输出 token（run usage.completion） */
  completionTokens: number;
  /** run 异常（finish='error' 或跑批过程抛错） */
  error?: string;
}

/** 跑批报告 */
export interface BenchReport {
  suite: string;
  model: string;
  provider?: string;
  runId: string;
  startedAt: string;
  durationMs: number;
  total: number;
  passed: number;
  /** 通过率（0-1；total=0 时为 0） */
  accuracy: number;
  promptTokens: number;
  completionTokens: number;
  cases: BenchCaseResult[];
}

/** bench/run-started 载荷 */
export interface BenchRunInfo {
  suite: string;
  model: string;
  provider?: string;
  runId: string;
  total: number;
}

/** 跑批选项 */
export interface BenchRunOptions {
  /** 路由模型名（裸名按 llm 路由，或 name@model 引用） */
  model: string;
  /** 显式 provider（缺省按 model 路由） */
  provider?: string;
  /** run 级系统提示词（与用例 systemHint 拼接） */
  system?: string;
  /** 最大步数（缺省 6；单轮用例 1-2 步即收束） */
  maxSteps?: number;
  /** 仅取前 N 例（冒烟/快速验证） */
  limit?: number;
  /** 跳过前 N 例 */
  offset?: number;
  /** 用例 id 子串过滤 */
  filter?: string;
  /**
   * 脚本化冒烟：把期望调用编码为指令块追加进 prompt，配合
   * scriptedBenchRow 的 mock provider 回放——验证"注册中心→loop→
   * 工具执行→对拍→报告"全链路（不触真实 LLM）。真实评测勿开。
   */
  scripted?: boolean;
}

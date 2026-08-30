// ============================================================
// ac-tools/src/contract.ts —— 工具域契约（纯类型，零运行时）
//
// 契约归属 owning package：谁提供 ctx.tools，谁声明本域类型与
// tool/* 事件（events.ts）。消费方 `import type {} from 'ac-tools'`
// 即同时获得服务类型、域类型与事件目录的类型增强。
//
// M11 契约扩展（地图 §3.4 工具域审查结论）：
//   · 执行身份——ToolCall 附 agentId/conversationId/toolCallId：
//     per-Agent 沙箱、ask_questions 对账（correlationId=toolCallId）、
//     job owner 隔离、settings 查询全部依赖它。身份由调用方（loop /
//     直接调用者）装配；工具行与安全行只读取。
//   · 语义化中断通道——ToolResult.interrupt：reload / reload_modules /
//     register_plugin / unregister_plugin / system_restart 五类工具的
//     "请求 → loop 收尾 → 宿主执行 → 续跑"闭环。工具体不执行宿主级
//     行为，只上报意图；loop 收束检测负责 finish='interrupted'。
//   · AbortSignal + 流式输出——bash 超时/取消、长任务进度上报。
// ============================================================

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema（参数表单/模型 schema 注入用） */
  parameters?: Record<string, unknown>;
  /**
   * 能力标签要求（M11 门禁，AND 语义）：调用方 Agent 的能力集（默认
   * ['base']）必须包含全部 requires 才放行。已知标签：base/dev/admin/
   * conductor。执行面在 ac-security 行（tool/before-execute 查
   * tags ∪ settings['security'].capabilities 覆盖层——M24 X4）；AgentConfig.tools
   * 白名单只解决"暴露哪些"，requires 解决"谁可用"（include 不可绕过）。
   */
  requires?: string[];
  execute(args: Record<string, unknown>, call: ToolCall): Promise<ToolResult> | ToolResult;
}

export interface ToolCall {
  name: string;
  args?: Record<string, unknown>;
  /**
   * 执行身份（M11）：发起 Agent id。
   * per-Agent 沙箱（ac-security 查 AgentConfig.settings）、job owner 分桶、
   * 工具命名空间配置（settings['<工具行名>']）依赖它。可空（宿主直调）。
   */
  agentId?: string;
  /**
   * 执行身份（M11）：会话键。
   * ac-session 定向 checkpoint（按会话 flush 而非 flushAll）、
   * 会话级隔离依赖它。缺省 = 无会话上下文。
   */
  conversationId?: string;
  /**
   * 执行身份（M11）：模型侧工具调用 id（OpenAI tool_calls[].id）。
   * ask_questions 等对账型工具以 correlationId=toolCallId 回对。
   */
  toolCallId?: string;
  /**
   * 中止信号（M11）：长任务工具体应尊重（bash 杀进程 / 浏览器停止加载）。
   * loop 把 request.signal 透传到这里；直接调用方可自带。
   */
  signal?: AbortSignal;
  /**
   * 流式输出（M11）：进度回调挂在 call 上（地图认可的两形态之一，
   * 事件化之外的轻量路径）。工具体在长任务中周期上报增量文本；
   * 谁提供回调谁消费（工具体只管调，缺省为 no-op）。
   */
  onProgress?: (chunk: string) => void;
  [key: string]: unknown;
}

/**
 * 语义化中断请求（M11，ADR-2）。
 * 工具体返回 interrupt 字段 = 请求宿主级行为（reload / restart /
 * 插件装卸），本 run 到此收束（finish='interrupted'，
 * interruptReason.type='tool-interrupt'），宿主执行动作后可续跑。
 * type 是开放词汇，已知值：'reload' | 'reload-modules' |
 * 'register-plugin' | 'unregister-plugin' | 'system-restart'。
 */
export interface ToolInterrupt {
  type: string;
  /** 人类可读理由 */
  reason?: string;
  /** 工具提供的补充载荷（如插件 manifest 摘要） */
  [key: string]: unknown;
}

export interface ToolResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  /**
   * 语义化中断请求（M11）：工具体不执行宿主级行为，只上报意图。
   * loop 收束检测消费本字段；带 interrupt 的结果仍如实入步记录。
   */
  interrupt?: ToolInterrupt;
  [key: string]: unknown;
}

/**
 * 工具执行的可变载体（waterfall 拦截链的事实对象）。
 * 拦截器改写调用的唯一方式是变异本载体
 * （`execution.call = { ...call, args: {...} }`），再 `return next()`。
 * 执行身份字段（agentId/conversationId/toolCallId）随载体可见——
 * 安全行据此查 per-Agent 配置；改写时须保留身份。
 */
export interface ToolExecution {
  call: ToolCall;
}

/**
 * 工具结果变换载体（tool/transform-result waterfall 的事实对象）。
 * `result` 即最终回填给模型/通知的值；变换器直接改写它后 `next()`。
 */
export interface ToolTransform {
  /** 实际执行的调用（before-execute 改写后的最终形态） */
  call: ToolCall;
  /** 变换中的结果（工具体产出或上游变换器的中间值） */
  result: ToolResult;
  /** 工具体执行耗时（毫秒） */
  durationMs: number;
  /** 工具体抛出的原始错误（收敛为 result.error 前；成功时缺省） */
  error?: unknown;
}

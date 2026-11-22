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
//   · AbortSignal + 流式输出——bash 超时/取消、长任务进度上报。
// ============================================================

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema（参数表单/模型 schema 注入用） */
  parameters?: Record<string, unknown>;
  /**
   * 能力标签要求（cr-953 退役面：requiredTags 门禁随 AgentConfig.tags
   * 全链退役——授权 = 行装载单闸（AgentConfig.rows 行集引用，装了即可
   * 见）。字段保留仅为兼容存量声明与测试桩，运行时零消费（恒 true 过渡
   * 函数 toolAllowedFor 已随 cr-1092 删除）；各工具包声明已删。新工具不
   * 挂本字段。
   */
  requiredTags?: string[];
  /**
   * 权限轴声明（access-tier 双轴门禁）：无人审核时执行本工具所需的
   * 档位；有人审核时可经询问提权放行（人审批 = 单次按 full 执行）。
   * 与能力轴（requiredTags）正交：能力轴管"装载/暴露面"（不满足连
   * 询问资格都没有），权限轴管"敏感动作的档位门"。
   *   · true —— write/edit/str_replace_editor/pwsh(bash)/browser/
   *     web_search/submit_issue/run_harness（文件写 + 命令执行 + 非
   *     LLM 出口通道：浏览器交互/搜索查询词/对外发布/harness 委托）；
   *   · false / 缺省 —— 读与协作面不设权限门。
   * 执行面在 ac-security 行（tool/before-execute 的档位矩阵）。
   */
  needPermission?: boolean;
  /**
   * 风险自评建议（cr-1066 权限门）：纯函数——对本次调用参数给出
   * 'allow' | 'ask' | 'deny' 建议。**建议非决定**——allow 不直通（环境
   * 按信任面裁决）、deny 直效不可被设置放宽（工具自愿收紧）、ask 上抛
   * 设置链（会话键 > Agent settings > 行 config 缺省）定归宿。有声明缺
   * 函数（undefined）= 恒 'ask'；throw 按 'ask'（fail-closed 方向——门
   * 消费侧约定，本契约只声明语义）。无 risk 声明 + needPermission: true
   * ≡ risk: () => 'ask'（存量等价映射）；两者皆无 = 门视野外（零开销
   * 放行）。执行面 = ac-permission-gate 行（tool/before-execute 决策序）。
   * 第二参（cr-1217 面1）：执行身份最小面（agentId）——per-Agent 设置化
   * 白名单等自评输入；可选，存量单参声明继续有效。
   */
  risk?: (args: Record<string, unknown>, call?: { agentId?: string }) => 'allow' | 'ask' | 'deny';
  /**
   * 发现谓词（cr-1049 两步投影·发现步）：本工具当前可否被发现进工具面。
   * 缺省 true。须为纯函数——入参是投影上下文纯数据（生效 toolMode 等，
   * effectiveToolMode 本就无 run 可求值——估算/预览/快照/真 run 四面同
   * 口径的前提），禁副作用；throw 按 false 处理（fail-closed）。
   * 模式入口工具在此声明与模式的强关联（如 run_code 的
   * ctx => ctx.toolMode === 'tc-programmatic'）；普通工具不写——对模式
   * 零感知。写全条件：若表达「条件门控但非模式入口」须显式含模式条件
   * （如 toolMode === 'tc-base' && …），漏写则扩展模式下会被当作入口
   * 保留（投影第②步按 discover 在场性保留显式声明者）。
   * 先例：run_code（cr-1049 前名 injection:'mode'）。
   */
  discover?: (ctx: ToolFaceContext) => boolean;
  /**
   * 交互性声明（interaction 轴）：true = 本工具执行中会挂起等待用户
   * 应答（ask_questions / 审批类）。self 会话（对角线桶 a~a——机制 run
   * 落点，无人值守）自动排除：等用户回音的操作在那里永无应答。
   * 判定收进 formDeniedBy 单源（ac-agents），无需逐工具配置。
   * 纯可见面裁剪：LLM 不见 schema；执行面不额外拦（幻觉调用仍走
   * requiredTags 等既有门禁）。与 discover 正交。
   */
  requiresInteraction?: boolean;
  execute(args: Record<string, unknown>, call: ToolCall): Promise<ToolResult> | ToolResult;
}

/**
 * 投影上下文（cr-1049 发现步入参——纯数据，无 run 依赖）：discover 谓词
 * 与两步投影核心的判定输入。toolMode = effectiveToolMode 单源合成值
 * （conv-settings 覆盖 ?? toolModeOf(agent)）。
 */
export interface ToolFaceContext {
  /** 生效工具调用模式（tc-* 开放词——扩展档由 ctx.agents.registerToolMode 注册） */
  toolMode: string;
  /** 发起 Agent id（可空——宿主直调/干跑面） */
  agentId?: string;
  /** 会话键（可空） */
  conversationId?: string;
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
   * 执行身份（2026-09-24 身份贯通）：所属 run 的身份键——与 loop/run-started
   * 载荷的 runId 同值（loop 装配；run_code 桥接子调用继承宿主 runId）。
   * tool/started·after-execute·progress 帧据此按键定位所属 run/步载体——
   * run_code 子调用的宿主归属从「tool_call_id 前缀提示」升格为判据。
   * 身份由调用方装配，工具行与安全行只读取。
   */
  runId?: string;
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
  /**
   * 执行边界档位（cr-1082 access 轴退役后两态；cr-1248 修订注入分级）：
   * 'full-access' = 唯一授权态，合法来源唯一 = 权限门**弹卡批准**注入
   * （cr-1248「知情通过即 full」——弹卡 payload 含完整命令，批准即知情
   * 授权；设置链 allow / run 缓存命中注入的是 'sandbox-access'：免弹卡
   * 但保留沙箱检查——预授权放行的是类别执行，不是解除一切检查）；
   * 缺席与一切其他值 = 沙箱缺省态（所有人的执行底座，常量语义——无
   * per-Agent 配置）。身份由调用方（loop / 门行）装配；工具行与安全行
   * 只读取。
   */
  access?: 'sandbox-access' | 'full-access';
  /**
   * run_code 子调用标记（2026-09-17 程序化模式）：本调用由 run_code
   * 程序内桥接发起（非模型直接 tool_call）。开放词汇面（结构化标记
   * 供 ac-session 入账/UI 区分——tool_call_id 的 `<runId>#<seq>` 形
   * 是提示不是判据）；工具行与安全行只读取，执行面语义不变。
   */
  runCodeSubcall?: boolean;
  [key: string]: unknown;
}

/**
 * 工具源承诺面条目（cr-1114 批2）：boot 同步期可枚举的名 + schema。
 * 「boot 期承诺名与形，run 期兑现连与果」——承诺面是静态投影（零 I/O），
 * 与实际发现集对账后收敛（差异经 tools/source-changed 通知）。
 */
export interface ToolSourceFace {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * 工具源契约（cr-1114 批2）：schema 不能在 boot 同步期可靠枚举的工具提供方
 * 的共同形态——host-face（ipc 远程工具）与 MCP（子进程/HTTP 服务器）同构。
 *
 * 三方职责：
 *   · bootFace() —— boot 同步期可承诺的名与形（零 I/O、零连接）。注册面
 *     据此建立静态代理，模型首 run 即可见（不必等发现完成）。
 *   · discover() —— 活发现（建连 + 列举），结果与注册面对账：增 / 删 /
 *     schema 变 → 重建对应代理，并 emit `tools/source-changed`。
 * 　 · execute —— 惰性连接后转发；源不可达 = 调用时报可读错误，不阻塞 boot。
 *
 * 归属词约定（改动 10）：`listWithOwner()` 的 owner = 注册方 fiber 名（包名
 * 或动态插件 manifest.name），**不等于** AgentConfig.rows 的行 id。行 id →
 * 工具名的展开靠 boot 的 fiberNames 桥（行 id ↔ fiber 名）现算——本契约不
 * 引入第二套归属词汇。
 */
export interface ToolSource {
  /** 源标识（诊断与事件载荷——如 'host-face' / 'mcp:<server>'） */
  readonly source: string;
  /** boot 期承诺面（同步、零 I/O） */
  bootFace(): ToolSourceFace[];
  /** 活发现（建连列举；失败应 reject，调用方降级） */
  discover(): Promise<ToolSourceFace[]>;
}

/** 工具源对账差异（tools/source-changed 载荷） */
export interface ToolSourceDiff {
  source: string;
  /** 新发现并注册的工具名 */
  added: string[];
  /** 发现集已无、被注销的工具名 */
  removed: string[];
  /** schema/描述变更后重建的工具名 */
  changed: string[];
}

export interface ToolResult {
  ok: boolean;
  output?: unknown;
  error?: string;
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
  /** 工具体抛出的原始错误（收敛为 result.error 前；成功时缺省。cr-347 起随 payload 构造填充——此前恒 undefined） */
  error?: unknown;
}

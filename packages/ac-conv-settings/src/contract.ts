// ============================================================
// ac-conv-settings/src/contract.ts —— 会话设置域类型
//
// 会话设置 = 按 conversationId 寻址的会话级覆盖（llm-provider-model-plan
// P6/D4 裁决：服务端会话元数据域）。承载：
//   · model：模型覆盖（name@model 引用或裸模型名——deliver 边界由
//     router 拆分）；形态上与 singles 的 session.json.model 同源，
//     但**归属面不同**：
//     - 独立会话（sid）的模型覆盖恒走 ac-singles（session.json 自包含
//       语义），本域不收 sid 键（防双源）；
//     - 对桶 `a~b`（user⇄agent 直答）/ 群 gid 的覆盖归本域。
//   · access：会话安全档位（cr-947：前名 elevation「提权水位」——三档
//     化统一 access 词汇，与 browserTier 同款会话覆盖形态）。值域
//     'base-access' | 'sandbox-access' | 'full-access'；无键 = 跟随
//     Agent tags 档位（accessOf 单源）。用户输入框选档随消息投递并写
//     本键；run 装配点合成「信封 access ?? 本键 ?? Agent 底座（只升不
//     降）」。读兼容：存量 elevation 旧值回读映射进 access（写恒新键；
//     sid 键同前水位语义合法在库——只有 model 分流 singles）。单次审批
//     注入（ac-security approval）不写本键——它是"本次调用"授权，非
//     会话级武装。机制唤醒继承语义不变（deliver sanitizeAccess 上限）。
// 持久化：<root>/conv-settings/<conversationId>.json（规约 2：文件名即
// conversationId；`~` 已被 assertAgentId 挡在路径危险字符外）。
// ============================================================

/**
 * 会话设置（wire 形 = 持久形态；逐键可选 = 覆盖语义）
 *
 * wire 值域约定：字符串枚举键（toolMode）的合法值经 set patch 面原样传入
 * （patch 泛型为 string | null | undefined——键级覆盖语义统一），非法值
 * （含 null/''）= 删键。持久形态为枚举字符串。
 */
/**
 * 键域（2026-09-26 注册制裁决）：内置键（下方接口）+ 生态扩展键
 * （ctx.convSettings.registerKey——插件贡献会话覆盖键的正路；值域
 * 枚举校验与内置键同一管线，RPC 边界泛透传零改动穿通）。扩展键值
 * 不在本接口（编译期类型面）——经 get() 的 Record 尾巴透出。
 */
export interface ConvSettings {
  /** 会话级模型覆盖：`name@model` 引用或裸模型名（清除 = 删键） */
  model?: string;
  /**
   * 会话安全档位（cr-947——前名 elevation 提权水位，三档化）：值域
   * 'base-access' | 'sandbox-access' | 'full-access'；无键 = 跟随 Agent
   * tags 档位。读兼容存量 elevation 旧值（两档映射）；写恒本键。
   */
  access?: 'base-access' | 'sandbox-access' | 'full-access';
  /**
   * 工具调用模式覆盖（2026-09-17 统一重构：tc-* 标签轴——与安全档位
   * access 同构的会话级覆盖；取代旧 programmatic 布尔键，存量键不
   * 迁移直接失效、回落跟随 Agent）：核心两档 'tc-base' / 'tc-none' +
   * 扩展档开放词（cr-1049——扩展档由模式行注册，先例 tc-programmatic
   * 住 ac-run-code）；无键 = 跟随 Agent（toolModeOf 单源判定，缺省
   * tc-base）。router execute 按「本键 ?? toolModeOf(agent)」
   * 收窄 LLM 工具面：tc-programmatic ⇒ ['run_code']、tc-none ⇒ 空面纯
   * 聊天、tc-base ⇒ 不收窄。tc-programmatic 覆盖但 Agent 无该标签
   * （run_code 不可见）时惰性 warn 并忽略（回落 tags 档）。键面同
   * access 口径：全形态会话（含 singles sid——model 才分流 singles）。
   */
  toolMode?: string;
  /**
   * 浏览器能力会话级覆盖（2026-09-26 CDP 化收尾——输入框「实验性 → 浏览器」
   * 档位钮）：值域 'observe' | 'manipulate' | 'inject' | 'disabled'。
   * 无键 = 跟随 Agent tags（browser-tier 抉择组）；有值则覆盖层级判定
   * （observe ⊂ manipulate ⊂ inject 单源序不变，disabled = 本会话 browser
   * 工具整体不可用）。消费方 = ac-web-tools 的 tool/before-execute 分层
   * 门禁（能力集合成后覆盖——比 tags 优先，同会话即刻生效）。键面同
   * toolMode 口径：全形态会话（含 singles sid——独立会话接入的通路）。
   */
  browserTier?: 'observe' | 'manipulate' | 'inject' | 'disabled';
  /**
   * ISSUE 提交会话开关（cr-41——输入框「实验性 → ISSUE 提交」档位钮）：
   * 值域 'enabled' | 'disabled'。无键 = 跟随 Agent tags（issue-report
   * 标签）；enabled = 本会话注入 issue-report（grants 可见性通路——
   * 无 tags Agent 也能用 submit_issue）；disabled = 本会话禁用（执行
   * 前置拦截，优先于一切）。键面同 browserTier 口径：全形态会话。
   */
  issueSubmit?: 'enabled' | 'disabled';
  /** 生态扩展键（registerKey 注册的键以 string 值透出——索引签名尾巴） */
  [extensionKey: string]: string | undefined;
}

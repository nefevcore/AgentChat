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
//   · elevation：会话提权水位（2026-09-12 设计：机制唤醒继承）——用户
//     run 的快捷提权档位留痕，同会话后续机制唤醒（job 回投/timer/
//     late-reply/插件回执等 source='event' 信封）deliver 未显式带
//     档位时自动继承（ac-conversation deliver 边界消费；继承不降档
//     ——full 水位原样继承 full，见 deliver 注释）。**水位键面比 model
//     宽**：deliver 对一切会话形态（含 singles sid）写水位——sid 键
//     的 elevation 合法在库（只有 model 分流到 singles；实测 sid 键
//     已在写，此注释如实记录）。单次审批（ac-security approval）
//     不写水位——它是"本次调用"授权，非会话级武装。
// 持久化：<root>/conv-settings/<conversationId>.json（规约 2：文件名即
// conversationId；`~` 已被 assertAgentId 挡在路径危险字符外）。
// ============================================================

/**
 * 会话设置（wire 形 = 持久形态；逐键可选 = 覆盖语义）
 *
 * wire 值域约定：布尔键（programmatic）经 set patch 面以字符串 'true' 写入
 * （patch 泛型为 string | null | undefined——键级覆盖语义统一），'true' = 开，
 * 其余值（含 null/''/'false'）= 删键。持久形态为真 boolean。
 */
export interface ConvSettings {
  /** 会话级模型覆盖：`name@model` 引用或裸模型名（清除 = 删键） */
  model?: string;
  /** 会话提权水位：用户最近一次快捷提权档位（机制唤醒继承用；清除 = 删键） */
  elevation?: 'sandbox-access' | 'full-access';
  /**
   * 工具使用模式（2026-09-17 开关化终裁，research §十）：true = 程序化——
   * 本会话 run 的 LLM 工具面收窄为 ['run_code']（真互斥形态，router
   * execute 消费）；缺省/false = 标准（传统工具逐个直调）。run_code 不可见
   * （无 code-exec 授权）时开关惰性（router warn 并忽略）。键面同 elevation
   * 口径：全形态会话（含 singles sid——model 才分流 singles）。
   */
  programmatic?: boolean;
}

// ============================================================
// ac-conv-settings/src/contract.ts —— 会话设置域类型
//
// 会话设置 = 按 conversationId 寻址的会话级覆盖（llm-provider-model-plan
// P6/D4 裁决：服务端会话元数据域）。首期承载模型覆盖（name@model 引用
// 或裸模型名——deliver 边界由 router 拆分）；形态上与 singles 的
// session.json.model 同源，但**归属面不同**：
//   · 独立会话（sid）的模型覆盖恒走 ac-singles（session.json 自包含
//     语义），本域不收 sid 键（防双源）；
//   · 对桶 `a~b`（user⇄agent 直答）/ 群 gid 的覆盖归本域。
// 持久化：<root>/conv-settings/<conversationId>.json（规约 2：文件名即
// conversationId；`~` 已被 assertAgentId 挡在路径危险字符外）。
// ============================================================

/** 会话设置（wire 形 = 持久形态；逐键可选 = 覆盖语义） */
export interface ConvSettings {
  /** 会话级模型覆盖：`name@model` 引用或裸模型名（清除 = 删键） */
  model?: string;
}

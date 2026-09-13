// ============================================================
// ac-tag-registry/src/contract.ts —— 标签域契约（纯类型，零运行时）
//
// 手工声明的形状（A1 注册制同款）：行包入口模块 `export const
// tagDeclarations`——插件包为「不从 requiredTags 可推导」的标签自行
// 注册（先例：browser 动作分层——requiredTags 只有工具级地板
// ['web','observe']，manipulate/inject 由行内监听器判定，注册面
// 采集不到）。tag-registry 扫 cordis registry 读取：行装载即声明在、
// 卸载即声明失，装载序无关（catalog 查询时现扫，不依赖事件时序）。
// ============================================================

/** 单条手工标签声明（行包入口 export const tagDeclarations: TagDeclaration[]） */
export interface TagDeclaration {
  /** 标签名（与 AgentConfig.tags / requiredTags 同词表；不得以 agent: 开头） */
  tag: string;
  /** 人类可读说明（目录呈现 + 悬浮提示） */
  description: string;
  /**
   * 消费本标签的工具名（呈现「启用后解锁」用；手工维护——声明方
   * 最清楚自己的门禁结构）。不填 = 纯领域词（如共享标签），仅呈现说明
   */
  tools?: string[];
  /**
   * 独立分组（声明方自组——目录按此聚合成组，组内按 order 升序）。
   * 缺省 = 「能力标签」通用组。先例：web-tools 把 web/observe/
   * manipulate/inject 四词自组「Web 与浏览器」——门禁词表是本行
   * 的完整能力面，独立成组比混在通用组更可导航
   */
  group?: string;
  /**
   * 目录排序提示（缺省 50；同组内升序）：分层族给 1/2/3 这类小序，
   * 使 observe → manipulate → inject 按层级呈现
   */
  order?: number;
  /**
   * 分层族提示：本组标签构成「低 ⊂ 高」的单向层级（如 browser 的
   * observe ⊂ manipulate ⊂ inject）——目录按 order 升序呈现，UI 可
   * 据此给出「含低层级全部能力」的语义提示
   */
  tier?: boolean;
}

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
  /**
   * 抉择组（2026-12 标签配置语义升级）：同组标签互斥——Agent 配置时
   * UI 把整组聚合成一个下拉（选一项而非逐个勾选）。目录侧只做元数据
   * 标注（不进任何判定：tierOf / toolModeOf / browser 层级门禁全部
   * 基于「tags 含某词」原语，与抉择组正交——UI 落词规则负责一致态：
   * 选组内任一项时移除其他项，保证 tags 上同组至多一词）。
   * 与 tier 的组合语义：抉择下拉选「含低层级」的高层词时，落词由
   * UI 的 tier 落词规则连带写齐全部低层词（browser 组选 manipulate/
   * inject 连带 observe——工具 requiredTags 是 AND 地板 ['web','observe']）
   */
  exclusive?: string;
  /**
   * 抉择组的「都不选」词（与 exclusive 同用）：该词本身留在目录
   * （下拉可见），但落词时**不写入 tags**——缺席即语义（缺省档由
   * 判定函数兜底，如 base-access / tc-base）。目录侧照常透出（用户
   * 需要在下拉里看到「基础档/标准档」选项才能理解全貌），仅在
   * TagCatalogEntry 上加 exclusiveNone: true 标注供 UI 落词区分
   */
  exclusiveNone?: boolean;
  /**
   * 抉择组「全关」的后果说明（与 exclusive 同用，同组一致）：无
   * exclusiveNone 缺省词的组（如 browser-tier）关闭态没有缺省词
   * 描述可借用——声明方在此说明关闭意味着什么（如「停用后 browser
   * 工具不可见（observe 是可见性地板）」）。UI 胶囊关闭态旁注 +
   * 弹层「关闭」选项描述共用。有 exclusiveNone 的组无需此字段
   * （关闭态描述 = 缺省词自身 description）
   */
  exclusiveOffDesc?: string;
}

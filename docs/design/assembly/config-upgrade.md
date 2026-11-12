# config 升级（config-upgrade）

> 性质：域深设计——行内 config（用户定制面）的版本化升级：声明式迁移边 + boot 惰性迁移 + 无损门槛。
> 状态：现行 · cr-1037 2026-11-12 立项（plan 态未动工；menu-assembly.md §六-4 遗留裁决的承接档）。上游依赖：[migration-chain-completeness.md](migration-chain-completeness.md) 批 1 的链立法。
> 读者：改行级 config 键名的插件作者、维护 agent.patch.yml 读写面（patch-doc / boot 校准面）的人。

## 一、设计目标

菜单代数落地后，agent.patch.yml 条目 = 行定义（指纹校准管）+ **config（用户数据，无人管）**。插件演进改键名时，存量 config 静默失效——用户以为还开着的档位早已不生效，比丢配置更危险。三种朴素方案均不可取：

| 方案 | 问题 |
|---|---|
| 保守：旧键保留 + 新代码读别名 | 别名债在每个插件累积（补丁式修复累积腐化） |
| 无条件重写（定义面同款） | config 变更未必机械（值域随语义变），猜错即损坏用户数据 |
| 读时适配不落盘 | 「文件所见」≠「实际生效」，复刻病灶 4 |

面拆分重申：**定义面无策略（缓存，指纹校准）；config 面有策略（用户数据，版本化保守）**。

## 二、终态规格

### 2.1 声明面

- owning 包 `ac` 字段声明 `configMigrations`：`[{ from, to, map }]`——`map` 为纯函数（旧 config → 新 config），**必须可判定无损**（键映射 + 值域兼容）；语义变化写不出无损边的**不写边**。
- 边注册进 [migration-chain-completeness.md](migration-chain-completeness.md) §2.1 的链立法（相邻 / 无重复 / 完备四断言）——config 迁移链是链完备性的第一个消费方。

### 2.2 版本戳与迁移执行

| 步骤 | 规则 |
|---|---|
| 写入 | 行 config 附 `configVersion`（仅存在迁移边的行出现，避免 schema 噪音） |
| boot 对账 | 现算链：stored < current → 逐边应用 → 落盘 + notice；与定义面指纹校准同节奏 |
| 写入纪律 | 原子写 + 留一代备份（与 menu-assembly §2.3 同源） |
| 无损门槛 | 链缺边（该行有存量旧版本但无完整边序列）→ 旧值整体移入 `config.legacy` + notice 明示「该设置需手动重设」——显式麻烦用户，不静默猜 |

### 2.3 纪律红线

- **改任何行级 config 键名的 CR，必须同批处理存量**：登记迁移边，或显式写明「存量作废 + notice」——二选一，不允许第三种「顺手略过」。
- 编辑面写侧校验：config 键面以当前包自述为准，未知键 warn（前向兼容回退场景）不阻断。

## 三、与代码的映射点

| 现状件 | 终态角色 |
|---|---|
| 各包 package.json `ac` 字段 | 增 `configMigrations` 声明（构建期聚合随 gen 链校验完备性） |
| ac-agents-core patch-doc | 行 config 读写挂 `configVersion`（读侧透传、写侧维护） |
| boot 校准面（cr-1029） | 同节奏执行 config 链惰性迁移 + notice |
| 编辑面 | config 键面校验换读包自述 |

## 四、开放裁决

| # | 事项 | 缺省取向 |
|---|---|---|
| 1 | 无损判定的声明形态（map 返回值带 lossless 标记 vs 类型约束） | 实施批定 |
| 2 | notice 通道（boot notice 汇聚 vs 逐行上报） | 随批 2 定 |
| 3 | LEVELS 轴（levels.browser 等结构化档位）是否纳入 config 链 | 暂不纳入——档位轴无键名漂移史，出现首例再收编 |

## 五、迁移分批

| 批 | 内容 | 测试标准（过程门） | 验证目标（目的态） |
|---|---|---|---|
| 1 | 声明面：configMigrations 字段 + gen 链完备性校验 | typecheck + test:unit + gen 再生成 | 声明即可校验——缺环 / 跳边的声明构建期即红 |
| 2 | 执行面：configVersion 戳 + boot 惰性迁移 + 原子落盘 | 单测（无损边 / 缺边 legacy 两路径）+ test:integration | 存量 config 逐位可证地升级或显式进 legacy + notice——零静默失效路径 |
| 3 | 纪律收口：改键名 CR 守门（cr.mjs check 提示 or 审核清单）+ 首例实战 | 全量 test + cr check | 红线成文且可守——改键名不带存量处理的 CR 无法静默通过 |

批次间可暂停；动工顺序先 cr-1036 批 1（链立法）再本档批 1。动工即升 cr-1037 为 doing。两层验收规约见 docs/doc-conventions.md（cr-1026）。

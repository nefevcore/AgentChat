# config 升级（config-upgrade）

> 性质：域深设计——行内 config（用户定制面）的版本化升级：声明式迁移边 + boot 惰性迁移 + 无损门槛。
> 状态：现行 · cr-1037 2026-11-12 立项，同日全批落地（批 1 声明面：ac.configMigrations 声明模块路径 + aggregateConfigChains 聚合器 + gen 链构建期四断言校验；批 2 执行面：configVersion 机制键 + runConfigMigration 执行语义 + boot 校准面同节奏惰性迁移 + notice 单通道；批 3 纪律收口：cr check 锁7 劝告锁〔在途条目键面信号提示〕+ ac.rows[].configKeys 键面自述〔聚合 → row-catalog 投影 → applyAssemblyLayer 未知键 warn 不阻断〕+ 端到端演练）。上游依赖：[migration-chain-completeness.md](migration-chain-completeness.md) 批 1 的链立法。
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

- owning 包 `ac` 字段声明 `configMigrations: { module }`——**模块路径发现面单源**（函数进不了 JSON；实施裁决 #1 定）：迁移边住包内约定模块 `src/config-migrations.ts`，导出 `configMigrations: Record<行id, MigrationEdge<RowConfig>[]>`。
- `map` 为纯函数（旧 config → 新 config），**必须可判定无损**（键映射 + 值域兼容）；语义变化写不出无损边的**不写边**。
- 键名换轨边写法约定：**显式删旧键、写新键**（解构剔除 + 重建——透传式 `{...c, 新键: c.旧键}` 留旧键垃圾）；多键迁移逐键明写，不猜。
- 边注册进 [migration-chain-completeness.md](migration-chain-completeness.md) §2.1 的链立法（相邻 / 无重复 / 完备四断言）——config 迁移链是链完备性的第二个消费方（agent.patch 链为首例）；构建期 gen 链校验（声明即可校验——缺环/跳边 gen 即红）。

### 2.2 版本戳与迁移执行

| 步骤 | 规则 |
|---|---|
| 写入 | 行 config 附 `configVersion`（机制保留键，仅存在迁移边的行出现，避免 schema 噪音；`legacy` 同为机制保留键——legacy 路径旧值整体移入处） |
| boot 对账 | 现算链：stored < current → 逐边应用 → 落盘 + notice；与定义面指纹校准同节奏（boot 校准面同段） |
| 写入纪律 | 原子写 + 留一代备份（复用 writeAgentPatchV3At——config 与定义同文件同纪律） |
| 无损门槛 | 链缺边 / 边 map 抛错 / 未来版本 → 旧值整体移入 `config.legacy` + notice 明示「该设置需手动重设」（configVersion 仍戳 current 不反复触发）——显式麻烦用户，不静默猜 |

### 2.3 纪律红线

- **改任何行级 config 键名的 CR，必须同批处理存量**：登记迁移边，或显式写明「存量作废 + notice」——二选一，不允许第三种「顺手略过」。守门面：本档成文 + gen 链构建期校验（声明即红）+ cr check 锁7 劝告锁（在途〔plan/doing〕条目描述含键面变更信号时提示核对——自由文本判定只提示不阻断）。
- 编辑面写侧校验（批 3 已接）：行 config 键面以**包自述**为准——`ac.rows[].configKeys` 静态声明 → aggregatePackageRows 聚合 → row-catalog 投影携带 → boot 用户差量层应用时（applyAssemblyLayer）未知键 warn 不阻断（前向兼容回退场景；configVersion/legacy 机制键豁免；未自述行不校验）。运行时 ExtensionMeta 聚合链路不在场（契约注释漂移——ac-extension-core 头注提及的扫描面已不存在），故键面自述走静态投影单源。

## 三、与代码的映射点

| 现状件 | 终态角色 |
|---|---|
| 各包 package.json `ac` 字段 | ☑ 批1：增 `configMigrations: { module }` 声明（词汇白名单 fail-closed） |
| packages/ac-agents-core/src/config-chain.ts | ☑ 批1+2：声明解析 + 聚合器（aggregateConfigChains）+ 执行语义（runConfigMigration / needsConfigMigration / readConfigVersion / stripVersion） |
| scripts/gen-row-catalog.mjs | ☑ 批1：构建期聚合 + 四断言校验（缺环/跳边 gen 即红） |
| apps/shell/boot.ts 校准面 | ☑ 批2：deriveAndAssertRowset 挂 config 惰性迁移（链注入参数）+ bootShell 主链路聚合注入；notice 单通道（顺手修正 calibrationNotices 漏汇入） |
| ac.rows[].configKeys（各包 package.json） | ☑ 批3：键面自述声明（aggregatePackageRows 聚合 → row-catalog 投影） |
| applyAssemblyLayer（ac-rowset-core/menu.ts） | ☑ 批3：rowConfigKeys 入参——未知键 warn 不阻断（机制键豁免；未自述不校验） |
| scripts/cr.mjs check 锁7 | ☑ 批3：在途条目键面信号劝告锁 |

## 四、开放裁决

| # | 事项 | 裁决 |
|---|---|---|
| 1 | 无损判定的声明形态（map 返回值带 lossless 标记 vs 类型约束） | ☑ 批1 已定：都不用——map 即纯函数 `RowConfig → RowConfig`，无损靠纪律红线 + legacy 逃生口；configVersion 由执行面维护，边只换算用户键面 |
| 2 | notice 通道（boot notice 汇聚 vs 逐行上报） | ☑ 批2 已定：汇聚 rowset.notices 单通道（cr-1037 同批修正 calibrationNotices 漏汇入的既有缺口） |
| 3 | LEVELS 轴（levels.browser 等结构化档位）是否纳入 config 链 | 暂不纳入——档位轴无键名漂移史，出现首例再收编（levels 已归位装配条目 config.level，进链即本机制覆盖面） |

## 五、迁移分批

| 批 | 内容 | 测试标准（过程门） | 验证目标（目的态） |
|---|---|---|---|
| 1 | ☑ 声明面：configMigrations 字段 + 聚合器 + gen 链完备性校验 | typecheck + test:unit + gen 再生成 | 声明即可校验——缺环 / 跳边的声明构建期即红 |
| 2 | ☑ 执行面：configVersion 戳 + boot 惰性迁移 + 原子落盘 | 单测（无损边 / 缺边 legacy 两路径）+ boot 集成测试 | 存量 config 逐位可证地升级或显式进 legacy + notice——零静默失效路径 |
| 3 | ☑ 纪律收口：cr check 锁7 劝告锁 + configKeys 键面自述 + 编辑面校验 + 端到端演练 | 全量 test + cr check | 红线成文且可守——键面信号 CR 有提示、未知键用户层有 warn；首例真实迁移边留待首个改键名 CR |

批次间可暂停。批 3（守门收口 + 编辑面键面校验 + 首例）留待首个改键名 CR 实战时闭环。两层验收规约见 docs/doc-conventions.md（cr-1026）。
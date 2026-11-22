# 迁移链完备性（migration-chain-completeness）

> 性质：域深设计——版本化持久形态的换轨器统一组织：相邻边迁移链 + 完备性校验立法。
> 状态：现行 · cr-1036 2026-11-12 立项，同日全批落地（批 1 链纯库 `ac-migration-core` + 批 2 agent.patch 链注册与 migrate 换轨 + 批 3 boot 惰性迁移与 config.json 收编退役）；cr-1037 批 1-2 增第二消费方（行内 config 迁移链——见 [config-upgrade.md](config-upgrade.md)）。下游依赖：[config-upgrade.md](config-upgrade.md) 的迁移边复用本链立法。
> 读者：给任何持久形态（agent.patch.yml / 基座文档 / installed / 单元 config）做版本演进、写换轨器、跑 migrate 工具的人。姊妹校验器：[ledger-invariants-plan](../session/ledger-invariants-plan.md) 的 ledger doctor（cr-1245 裁决 D5：轻共基座——severity 词汇共享〔info/warn/error〕+ 文档互引；迁移链校验静态注册结构、doctor 对拍运行时数据，验证对象不同构不深合并）。

## 一、设计目标

cr-1029 把差量→菜单的换算收口进迁移工具后，迁移器是**一次性脚本**形态：下一形态再演进时要新写一个脚本，旧脚本是否仍适用、两代脚本能否接力、链是否连续——无人保证。病灶：

| # | 病灶 | 现状证据 |
|---|---|---|
| 1 | 换轨器散置：每次演进一个独立脚本，无注册面 | migrate 工具单档；上一代脚本随批删除 |
| 2 | 无完备性校验：缺环 / 跳版 / 重复边要到运行时碰运气 | 无任何静态断言 |
| 3 | 未来版本静默 mishandle 风险：旧代码读新数据无拒绝语义 | 校准面只对定义面有指纹比对，格式版本无链 |

DSH 先例（CompiledSessionFormatChain）：会话格式 v0→v4 每边独立包、启动时校验链完备、缺环 fail-loud、未来版本拒绝——单开发者仓库不需要四代独立包，但**链的立法**照搬。

目标一句话：**新增换档 = 注册新边**——迁移器从「每次一批脚本」变为「链上注册一个纯函数边」，完备性由校验器静态保证。

## 二、终态规格

### 2.1 链立法

- 每个版本化形态注册一条链：`edges: { from, to, migrate }[]`，migrate 为纯函数（旧形态值 → 新形态值，可判定无损或显式报告不可迁）。
- 校验器四断言（注册时即红，不待运行）：
  1. **严格相邻**：`to === from + 1`；
  2. **from 无重复**：同一起点两条边 = 注册错误；
  3. **链完整**：v0..current 每环都在，缺环 fail-loud 列名；
  4. **未来拒绝**：输入版本 > current → 显式报错，绝不静默降级读。
- 执行语义：`plan(storedVersion)` 现算剩余边序列，逐边应用；逐边可审计（notice 报告每边应用结果）。

### 2.2 形态清单（首批收编）

| 形态 | 基线 | 说明 |
|---|---|---|
| agent.patch.yml（菜单片段格式） | v1 = cr-1029 迁移产物 | 结构性换档进链；定义面漂移仍走指纹校准（两机制正交：链管格式、指纹管内容） |
| 基座文档 / 各包 ac.rows | ac-base-version 戳（内容哈希面已随 v2 基线戳退役——cr-1067） | 已有戳与对账，链只收编**结构性换档**（如再分区、字段改名），日常行编辑不进链 |
| 旧 config.json 窗口存量 | ☑ 一次性收编后退役（批 3：v3 在场者转 config.json.migrated 留审计副本；读窗关闭——残留死文件视同缺席；ac-import 写口同批换 v3，产线死透） | 迁到 agent.patch.yml 后该形态死亡，不留链 |

### 2.3 禁令与入口

- **一次性 migrate 脚本禁令**：立项后新增换档只许注册边；独立迁移脚本不再立项。
- 入口恰两处：migrate 工具（人工触发，链驱动 + 对账报告）、boot 读面（发现存量版本落后 → 惰性走链，原子纪律同 [menu-assembly.md](menu-assembly.md) §2.3）。
- 纯库落点（裁决 #1 已定）：独立纯库包 **`ac-migration-core`**（链是跨形态横向机制，不隶属行集推导域；与指纹机制物理分包含示正交），零 cordis 依赖。

## 三、与代码的映射点

| 现状件 | 终态角色 |
|---|---|
| scripts/migrate-agent-patch.mjs | ☑ 链驱动执行器 + 对账报告（换轨逻辑退居注册边——工具内零换算代码） |
| packages/ac-migration-core/src/chain.ts | ☑ 链核心：`MigrationEdge` + `validateChain` 四断言 + `planChain`/`runChain` |
| packages/ac-agents-core/src/patch-chain.ts | ☑ agent.patch 形态链（v0 前菜单身份 → v1 数组差量 → v2 菜单片段）+ `detectPatchForm` 探测 + `migrateAgentPatchAt` 链驱动执行 |
| apps/shell/boot.ts 装配读面 | ☑ v3 缺席 → 惰性走链 + notice（批 3） |
| packages/ac-import/src/agents-tree.ts | ☑ 导入写口换 v3（config.json 产线退役——批 3） |
| boot 校准面（cr-1029） | 读面接链：格式版本落后 → 惰性迁移，与指纹校准同节奏 |
| gen 链 | 构建期跑链完备性校验——注册即红，不待运行 |
| cr-1175 服务通道 | 非持久形态迁移（通信协议位）——六类宿主寄居信封退役为服务帧；HostInbox 转发 shim 是混布窗兼容件（随发版删），无盘上形态 |

## 四、开放裁决

| # | 事项 | 缺省取向 |
|---|---|---|
| 1 | 纯库落点（ac-rowset-core 内 vs 独立包） | ☑ 批1 已定：独立包 `ac-migration-core` |
| 2 | 边的审计面形态（notice 逐边报告格式） | ☑ 批2 已定：EdgeReport { from, to } 逐边记录，工具/boot notice 由 reports 拼装 |
| 3 | 基座文档「结构性换档」判据（何种编辑进链、何种走版本戳） | 留待首个实际换档裁决（现无实例） |

## 五、迁移分批

| 批 | 内容 | 测试标准（过程门） | 验证目标（目的态） |
|---|---|---|---|
| 1 | ☑ 链纯库：edges 注册 + 四断言校验器 + 单测 | 纯库单测（四断言各有点名用例）+ typecheck + check:deps | 校验器就位；四断言违反各有 fail-loud 单测 |
| 2 | ☑ agent.patch 格式链注册 + migrate 工具换轨为链驱动 | migrate 对账 + 全量 test | migrate 逻辑退居注册边——工具内无换算代码；多代存量（模拟 v0→v2）逐边接力可证 |
| 3 | ☑ boot 读面接链（惰性迁移）+ config.json 存量收编退役 | test:integration + 对账 | config.json 形态死亡（清单内零存量）；boot 惰性迁移 notice 可见 |

批次间可暂停；动工即升 cr-1036 为 doing。两层验收规约见 docs/doc-conventions.md（cr-1026）。

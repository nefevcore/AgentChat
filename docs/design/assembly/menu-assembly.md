# 装配菜单代数（menu-assembly）

> 性质：域深设计——装配第二模型：骨架基座 × 菜单片段 patch × 指纹校准，按 cordis-plugin-loader 原语合成，取代差量词形（cr-1004）与 bundle 机制（cr-1007）。
> 状态：现行 · cr-1022 2026-11-12 立项；cr-1025 2026-11-12 修订（合成回归装载器原语 + 行词汇白名单 + 重写原子化）；cr-1027 2026-11-12 批1 落地（mergeMenu 引擎 + 双区解析）；cr-1028 2026-11-12 批2 落地（基座双区化 v4 + 行词汇瘦身 + 模板物化 v3/指纹写入 + 旧机制死代码清零）；cr-1029 2026-11-12 批3 落地（v3 唯一读面 + migrate 对账收口 + boot 校准面 + 指纹足迹依赖闭包——旧差量模型代码死透，换算只存于迁移工具）；cr-1032 2026-11-12 批4 落地（subagent spawn 词面换父壳活装配行集——bootShell 装配产物注入，readCatalog 静态目录依赖从 ac-shell-subagent 退役；cr-1022 收官）；cr-1033 2026-11-12 §六-5 落地（能力定义归包：shell.yml v5 单区骨架 + 各包 ac.rows 构建期聚合 + readCatalog 合并语义——骨架归基座/能力归投影）；cr-1067 2026-11-14 修订（v2 基线戳 `# ac-base` 退役——差量承重语义随本模型消亡，基座/安装态演化经 §2.3 定义面校准自动传导，migrate `--rebase` 档删除）。
> 读者：改装配求值引擎（ac-rowset-core）、写 agent.patch.yml / 预设模板、做插件安装适配的人。

## 一、设计目标

cr-1004 把 Agent 装配建为差量代数（全局菜单 + 点名/停用/config 差量条目）；cr-1007 用 bundle 把预设专属行摘出基础集。两步各解即时问题，留下五处结构性病灶：

| # | 病灶 | 现状证据 |
|---|---|---|
| 1 | 基座混装：骨架行与默认能力行同层，基础集语义被「哪些行进基础集」的裁决绑架 | shell.yml 基础集含 run-code/math/web-tools/browser/subagent 等能力行；sap-adt 曾混入后靠 cr-1007 摘除 |
| 2 | bundle 是混装的创可贴：捆绑词只为表达「不在基础集、可成组点名」而存在 | evaluate.ts 四函数 8 处 byBundle；捆绑值把预设名焊进出厂基座 |
| 3 | 负差量预设：瘦面 Agent 在胖基座上做减法 | dsh-minimal 模板靠排除十余基础集能力行得到 2 件工具的面 |
| 4 | 生效面不可直读：引用式差量下「Agent 实际装了什么」需运行时现算 | cr-1007 §六自注「组合读重建白名单供工具面热更新」 |
| 5 | 行集词汇越界：目录长成第二注册表——带内真值被抄进手写文档 | tools 抄注册面（byTool 撞名优先补丁 + parity 锁的存在本身）；packs 抄装配代码（无对账锁、纯库链接 edit-core 级不入指纹盲区） |

目标模型一句话：**菜单合成取代菜单求值**——agent.patch.yml 本身是菜单片段（行定义形态），与骨架基座合并（撞名护栏）即得该 Agent 的完整菜单，菜单同时就是装配清单，不存在「求值先于合成、求值需要完整菜单」的两段式。合成按 cordis-plugin-loader 原语进行：行集词汇不超出装载条目可表达的范围（§2.1 词汇白名单），基座文档与 patch 的唯一职责就是合成最终装配清单。

与 cr-1007 的关系：**目标保留，机制翻转**——预设专属行不进默认面的裁决不变；实现从「bundle 摘出基础集 + 点名装载」翻转为「能力行一律显式进 patch，不进即不装」。

与病灶 5 的关系（cr-1025）：行文档只保留本体词汇（选择与身份）；一切带内真值的派生面（工具目录、包足迹）由 gen 链从带内真值生成，不进手写文档。

## 二、终态规格

### 2.1 分层模型与词汇白名单

行分两类，**分层是立法面不是约定**（分区即校验输入）：

| 层 | 语义 | 物理位置 | 可否被 patch 携带 |
|---|---|---|---|
| 骨架（skeleton） | 会话循环的结构性前提；平台设施（非 Agent 装备） | shell.yml 骨架区 | 否——撞名即丢弃并告警 |
| 能力（capability） | Agent 可选装备行 | 各能力包 package.json `ac.rows`（出厂目录事实源——cr-1033 归包）+ agent.patch.yml（实例菜单片段）+ installed（第三方） | 是 |

配套立法（静态校验，gen 脚本承担）：

- **行定义词汇白名单：`id` / `name` / `requires` / `config`（分区归属由所在区隐含）**。tools / packs / bundle 及一切「真值在带内另有所属」的派生词汇一律禁入——基座文档与 patch 的唯一职责是合成最终装配清单，不承担能力目录 / 指纹足迹等第二注册表职能；派生面（工具目录、包足迹）由 gen 链从带内真值生成（注册面 dump、package.json 依赖闭包，见 §四 / §五）。
- requires 语义 = 完备性校验，非自动注入：合并后校验每行 requires ⊆ 菜单，缺失 = fail-loud（错误行列出缺失行）；菜单不因 requires 静默长行（与「不进即不装」同哲学）——patch 显式携带全部能力级依赖（现状数据零能力→能力边，骨架级依赖恒在场）；requires 是静态闭包校验的本体输入（无运行时真值可抄），推导自包内 inject 导出登记为后继（§六-7）。
- 骨架行不得注册工具面（tools 基座行属骨架，memory/goal/todo 等工具行属能力层——分层即载体，无需行内字段表达）。
- 撞名优先级：骨架 > patch > installed（installed 面护栏沿用 plugin-rows.ts 三判据）。

### 2.2 菜单代数

```
menu(agent) = 骨架区(shell.yml)
         ∪ agent.patch.yml 定义        # 菜单片段：行定义数组（id/name/requires/config——白名单见 §2.1）
         ∪ fit(installed × shell)      # 第三方行，反向适配（现行机制不变）
```

- 合并即装配：产物直接交装载器（条目自带 name: link: 装载路径），无引用解析步骤。
- patch 条目词形 = 行 id 单一（工具名别名 / 捆绑词退役——存量工具名条目随 §六-3 迁移归一，行名/工具名撞名优先补丁一并消解）。
- 用户全局层（shell-custom.patch.yml）不带定义——只做停用与 config（防第二定义入口，见 §2.4）。
- 模板物化 = 把模板声明的能力行**定义**（从出厂能力区拷贝 + 来源指纹）写进新 Agent 的 agent.patch.yml。

### 2.3 指纹校准（定义副本是缓存，不是数据）

patch 内的定义副本会随出厂定义演进而过时。裁决：**行定义无保守升级语义**——用户保留旧定义不是定制，是漂移。校准规则：

| 步骤 | 规则 |
|---|---|
| 写入 | 物化/编辑面写定义时附 src-fingerprint（出厂定义或 installed manifest 定义的规范化序列化哈希） |
| boot 对账 | 现算来源定义指纹 ≠ patch 内指纹 → 定义面自动重写为来源定义，行内 config（levels/settings）原样保留，notice 上报 |
| 编辑面语义 | 用户对行定义的手改视为编辑面 bug 防护（写侧校验拒绝），定制面只有 config |

更新管道因此从「有状态策略引擎」坍缩为「无状态校准」，与现行 rebase 复杂度同阶。需要保守/替代策略的是 config 面（插件改名配置键后存量设置迁移），它是独立特性，不在本档展开（开放裁决 §六-4）。

**基线戳退役（cr-1067）**：v2 遗留的 `# ac-base` 基线戳（基座 + installed 存在合成哈希）在本模型下失去承重对象——patch 是菜单片段而非差量，基线敏感点（定义漂移 / 孤儿 / 行引用缺失）各由 §2.3 校准与 R3.2 断言守门，`--rebase` 实测为纯盖章。漂移 fail-loud 门恰拦自我迭代闭环（基座/安装态演化 → `restart_shell` 确定性死）。裁决：全链退役——读侧存量注释行容忍忽略，写侧不再落，`assemblyBaseStamp` 与 migrate `--rebase` 档删除。若未来需要「Agent 逐个显式追新」的产品语义，应为显式版本协商机制另立项，不复活哈希戳门。

**写入纪律（cr-1025）**：定义面的每次重写（模板物化 / 编辑面 / boot 校准）走「临时文件 + fsync + 原子 rename」，且重写前留一代备份（`agent.patch.yml.bak`）。备份保护对象是行集合与 config（跨版本持久的用户数据），非旧定义本身——校准 / 迁移失败可恢复已知良态重放，成功后备份可清。

### 2.4 硬约束保持

评审（cr-1022 会话四轮 + cr-1025 修订）钉死的约束在新模型下的落点：

| 硬约束 | 落点 |
|---|---|
| 无进程求值（spawn 词过滤等） | 父菜单 = 无状态现算（骨架 ∪ 父 patch ∪ installed）；词解析在父壳运行时问活注册面（ctx.tools 归属信息 + 行→条目映射），不查静态目录、无 token 展开 |
| 代码入口收敛受审 | 定义入口恰三处：出厂基座（代码评审）、installed（approve + hash）、实例 patch（写侧只拷贝受审来源 + boot 校准）；用户全局层不带定义 |
| 装配期依赖完备 | requires 校验 fail-loud（缺行报错并列名，boot 前拦截）——与现行 expandRequires 自动注入不同：注入变校验、静默补全变显式携带；现状零能力→能力边，两语义产物逐位等价 |
| 升级传播 | 指纹校准（§2.3）自动传导；基座物化对账（`# ac-base-version` 版本戳 fail-loud）语义保留；v2 基线戳门已退役（cr-1067，见 §2.3） |

## 三、骨架/能力分界

判据：**摘除该行后，user⇄agent 会话循环（串行化门 + ReAct + 工具注册）是否还能跑**；平台设施类（非 Agent 装备语义）归骨架。逐行分界：

| 骨架（13） | 说明 |
|---|---|
| logger-console / config | 基座设施 |
| ledger / conversation | 会话状态机 |
| tools | 工具注册基座 + 授权门 |
| llm / llm-pool | 模型会话与连接池 |
| agent-loop | ReAct 编排 |
| persona / conduct / host-face-client / durable-interaction | 身份只读 / 行为基线 / 宿主代理面 / 交互承重——平台设施 |
| jobs | 后台任务基座（worker 壳子进程设施）——裁级行，见下 |

| 能力（其余全部） | 例 |
|---|---|
| 工具面 | fs-tools / fs-search / str-replace-editor / shell-tools / run-code / math / web-tools / browser / issue-tools / harness-tools / sap-adt / skill / mcp / subagent / ask-questions / goal / todo / memory / session-query |
| 拦截/编排行 | auto-title / datetime / artifacts / archive / bench / collab-tools |

裁级行（☐ 分界待终裁，默认按表内归置）：jobs（摘后会话循环可跑，但为进程级基础设施，与 tools 同类）；host-face-client（懒装配面，语义是平台代理非装备）。

## 四、与代码的映射点

| 现状件 | 终态角色 |
|---|---|
| packages/ac-rowset-core/src/evaluate.ts | 菜单合并纯函数（mergeMenu）：撞名护栏 + 词汇白名单校验；byBundle / byTool / 基础集语义 / expandToken 退役 |
| packages/ac-rowset-core/src/base-docs.ts | 双区解析（骨架区/能力区）+ 分区校验 |
| apps/catalog/profile/shell.yml | v5 单区骨架 13 行（cr-1033：能力定义归各包 ac.rows，构建期聚合进 row-catalog.json 投影——指纹校准的来源 + 编辑面可选项随投影走）；行内 tools / packs / bundle 字段全数删除 |
| agent.patch.yml（ac-agents-core/patch-doc.ts） | 条目 = 行定义 + src-fingerprint + config；顶层数组形态沿用 |
| 预设模板 templates/*/config.json | rows 点名清单 → 能力定义物化（从出厂能力区拷贝 + 指纹）。collab-tools 于 cr-1342 改名 messaging-tools（包目录同步 ac-messaging-tools） |
| row-catalog.json / tool-catalog.json 投影 | 角色降级：从求值先决条件 → 骨架装载投影 + 编辑面目录；工具目录选面反转为 dump 驱动（boot 真装配注册面即选面），parity 对账锁随真值单一化退役；gen 链保留 |
| subagent（inherit.ts / service.ts） | spawn 物化 = 拷父合并菜单子集（定义形态）；词过滤 = 父壳活注册面解析（工具名 → 归属行 → ⊆ 父行集），不再查静态目录 |
| apps/shell/boot.ts 主体指纹足迹 | 行包足迹从 catalog path/packs 数组 → 条目包根 × package.json workspace 依赖闭包（顺带闭合纯库链接不入指纹的盲区） |
| installed 面（plugin-rows.ts） | 不变——manifest.rows 自述 + 反向适配 + 三判据 |

## 五、被取代机制清单

| 退役件 | 替代 |
|---|---|
| bundle 字段 + byBundle（evaluate.ts 8 处） | 能力行一律显式进 patch；成组选择由模板物化承担 |
| 基础集语义（bundle===undefined → 恒装） | 骨架区即恒装面；存量桥与 v3 写侧缺省面经 LEGACY_BUNDLE_ROW_IDS 冻结旧捆绑行边界（写读同口径——裸 agent 物化不静默长行），随批 3 migrate 退役 |
| 捆绑词展开（expandToken 第三段）/ 模板捆绑词 | 正清单直读；spawn 词过滤改父壳活注册面运行时解析（§2.4） |
| legacyRowsToAgentPatch / evaluateLegacyShellRows 读侧桥 | 定义形态无换算；migrate 收口提前至本批 |
| 差量条目（disabled 加法/no-op 精简 §六 cr-1007） | 菜单片段天然只记离差（不写即不装） |
| dsh-minimal 负差量模板 | 2 行正清单 |
| 行内 tools 字段 + byTool 词形（evaluate.ts 四处） | 工具目录纯 dump 生成；spawn 词运行时解析；patch 条目行 id 单一词形（撞名优先补丁一并消解） |
| 行内 packs 字段 + catalog path 数组指纹面 | boot 指纹足迹改依赖闭包（§四 boot.ts 行） |
| tool-catalog parity 对账锁 | 真值单一化（注册面唯一）后无第二份可漂移 |

## 六、开放裁决

| # | 事项 | 缺省取向 |
|---|---|---|
| 1 | 骨架裁级行（jobs / host-face-client）终裁 | 按表归置 |
| 2 | 指纹算法（规范化序列化 + 哈希选型）与 src-fingerprint 字段名 | 实施批定 |
| 3 | 存量迁移推导：现生效行集（基础集+差量现算）∩ 能力行 → 菜单片段；migrate-agent-patch.mjs 换轨 | 机械推导可行 |
| 4 | config 升级策略（保守/替代）——插件改名配置键后存量设置迁移 | ☑ 已立项承接：[config-upgrade.md](config-upgrade.md)（cr-1037 plan） |
| 5 | ~~第一方包自述归一~~ 已落地（cr-1033）：能力定义迁各包 package.json `ac.rows`（词汇 id/description/requires——name 由聚合器按包根派生禁自写；多行包合法）；构建期聚合（aggregatePackageRows → gen-row-catalog.mjs）；readCatalog 合并语义（骨架归基座/能力归 JSON 投影，部署链随行物化 row-catalog.json）；shell.yml v5 单区骨架（双区读面退役，zone 变为投影派生词） | 收口（存量基线戳经 migrate --rebase 一次收敛，定义指纹零漂移） |
| 6 | 旧 config.json 存量（模板物化窗口期产物）在迁移批的处置 | 随 §六-3 同批 |
| 7 | requires 推导自包内 inject 导出（服务名→行映射 gen 期生成）——白名单内唯一可再降级的字段 | 后继方向；本档保留手写（它是静态闭包校验的本体输入，无运行时真值可抄） |
| 8 | 伴生行立法回归：COMPANION_ROWS 例外（fs-tools × file-snapshots）收口——并包或转正为行，恢复「一行 = 一包 = 一插件」 | 随 §六-5 同域后继 |

## 七、迁移分批（概览）

| 批 | 内容 | 测试标准（过程门） | 验证目标（目的态——做完后世界应有的样子） |
|---|---|---|---|
| 1 | 引擎：mergeMenu 纯函数（并集 + 撞名 + requires 校验 + 词汇白名单拒绝）+ 双区解析 + 分区校验立法 | ac-rowset-core 单测三护栏 + typecheck + test:unit + check:deps + 定向 eslint | mergeMenu 就位且三护栏各有点名单测（撞名丢弃 / 缺依赖 fail-loud 列名 / 白名单外字段拒绝）；**diff 面纯新增**——evaluateAssembly 与 apps/ 零改动（并存纪律：旧路径留给批 2/3 换轨） |
| 2 | 基座双区化 + 行词汇瘦身 + 模板物化换轨 + 指纹写入 | typecheck + test:unit + 全量 pnpm test（装配链 e2e）+ gen 投影再生成 | 换轨后**死代码清零**：行内 tools / packs / bundle 字段、byBundle / byTool、基础集语义、parity 对账锁从在役代码与文档全数消失（grep 零残留）；tool-catalog 完全由 dump 生成（无手写来源）；存量 Agent 装配行为不变；物化写入原子 + 备份在位 |
| 3 | 存量迁移：migrate 换轨 + boot 对账校准面 + boot 指纹足迹换轨（依赖闭包） | 对账脚本比对 + 样本常驻回归 + typecheck + test:unit + test:integration | 存量 Agent 菜单**逐位等价**（对账脚本，样本固化为常驻回归）；legacy 读侧桥（legacyRowsToAgentPatch / evaluateLegacyShellRows / 工具名别名）删除——旧差量模型代码死透；boot 指纹足迹含依赖闭包（edit-core 级改动指纹可见） |
| 4 | subagent 换轨 + 文档同步 | 全量 pnpm test + cr.mjs check | spawn 词解析不再读静态目录（catalog 依赖从 inherit.ts 消失）；文档无双轨叙事（agent-assembly.md 状态翻转、host-shell-row-manifest.md 行表换轨、本档翻转为现行） |

两层验收规约见 docs/doc-conventions.md（cr-1026）：测试标准全绿是必要非充分，收官只认验证目标全达。批次间可暂停（每批自洽可验收）；动工即升 cr-1022 为 doing。裁决论据全文见 [host-shell-decisions.md](host-shell-decisions.md)〈菜单合成原语与行词汇纪律〉。

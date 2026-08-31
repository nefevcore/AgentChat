# M24 设计稿：词汇收口、全局默认层与目录信息架构

> 状态：**✅ 已实施（2026-08-30，按定稿 v8 全批落地 P1-P6——三轮审查收敛
> 后的收敛终态即为实施形态）**。正文为各轮裁决的**收敛终态**；行内
> （B/N 系）仅作追溯锚点、不叙述修订过程。版本史与审查档案：
>
> | 版本 | 轮次 | 裁决系 |
> |---|---|---|
> | v1 | M23 §六候选正式化 | A1 全局默认层 / 配置弹窗 / 收敛 / 轮转 |
> | v2–v3 | 本轮讨论 | **hook 词汇退役**（C 档全链改名）→ 定名 **settings**（经 extensions 中间稿；排除理由见 §〇） |
> | v4 | UI 原型 v2 | **目录信息架构**（两页签/三视图/内置本地分组/市场首期/Agent 装配同构；UI 事实源 `docs/m24-m25-ui-prototype.html`） |
> | v5 | 一审 | 消费点补全 + **类型删除强制迁移** + 编号统一 + 生产源首期裁掉 |
> | v6 | 二审 | B2 三缺口（collab-tools 运行时写 / workspace admin 写 / agent-admin 白名单）+ B3 白名源头 + C1-C5 |
> | v7–v8 | 三审 + 定稿 | N 系修文（grep 理由 / webui 前端归 P1 / 索引精度）+ 精简规范化（零新裁决） |
>
> 来源：M23 §六 M24 候选（方案1 UI 线，已裁决未排期）正式化 + 词汇收口
> 裁决 + 目录 IA 裁决。前置：M23 ✅（configNs 挂点 / 双轨对账告警 /
> capabilities 并集语义已就位）。
> 姊妹线：事件治理与行树治理归 **M25**——**X1 须先于 M25 P1**（其
> agentGate 词汇依赖 settings；倒排时对方带同窗双读兜底）；其余批次互不
> 依赖（目录·事件视图壳本文交付，描述与治理开关随 M25 P2）。

---

## 〇、词汇裁决（本文全部条目的前置）

src 的 "hook" 在 preview 分裂为两物：**执行面**（→ 事件/监听器，已彻底取代
——挂载点 = 事件，注册物 = 监听器[细分拦截器/变换器/观察者]）与**配置面**
（`hooks[具名]`——机制是"已装行的 per-Agent 可配置项"，名字是历史遗留）。
裁决：

- 配置面**概念保留、词汇全链退役**：`hooks` → **`settings`**。命名对象 =
  可配置项容器：**键承载锚点**（稳定单元名：行名 / 动态插件 manifest.name），
  容器零本体承诺（每个键的形状归各行自定义——VS Code settings 按贡献者
  分节同款模式）。
- **不采用"具名事件"**（范畴错误：事件是分发机制，settings 是数据）；不采用
  机制词 listener/handler（配置与监听器 1:N、web-tools 零监听器）；事件维度
  归**治理面**（M25 `owner::event` 停用键），不进配置键。
- M23 §3.9 的「具名钩子」页签随 §2.3 IA 重构消解（组件并入目录视图）。

---

## 一、目标与范围

| # | 项 | 一句话 |
|---|---|---|
| X1 | 词汇与契约收口 | `AgentConfig.hooks` → `settings` 全链改名 + **类型删除强制迁移** + 存量迁移 |
| A1 | 全局默认层 | config.json `settings` 域 + `settingsOf` 单点合成（读取消费侧） |
| X2 | 目录信息架构 | 插件库两页签 + 三视图 + 内置/本地分组 + Agent 装配同构 + 配置弹窗归位 |
| X3 | 插件市场首期 | npm/github 话题搜索 + 暂存人审安装流 |
| X4 | tags/capabilities 收敛 | tags 单源，`settings.security.capabilities` 退位为追加覆盖层 |
| X5 | audit.jsonl 轮转 | 大小上限 + 轮转保留 |

维持：装载徽章四态（含熔断）、监听器排序不做（执行序 = 注册序）。

---

## 二、目标设计

### 2.1 X1 词汇与契约收口

| 层 | 旧 | 新 |
|---|---|---|
| 契约字段 | `AgentConfig.hooks?: Record<string, unknown>` | `AgentConfig.settings?: Record<string, unknown>`（键 = 行名 / 动态插件 manifest.name） |
| 合成口（A1 交付物） | — | `AgentsService.settingsOf(id, name?)` |
| config.json 域 | —（A1 新增） | `settings` |
| RPC | `agents/assembly` 的 `hooks:{enabled,configs}`；`assembly/update` 与 `update-config` 的 `patch.hooks`；ac-agent-admin `ALLOWED_FIELDS` 白名单含 `'hooks'` | `settings:{enabled,configs}` / `patch.settings` / 白名单换名（漏改则新键 **fail-closed 拒写**）；**线格式同批原子切换、无兼容窗**——M23 动态插件 UI 直调这些 RPC 属越权面，破坏性显式接受 |
| UI | hooks 参数弹窗 | 配置弹窗双实例（§2.3） |
| 内部类型 | `SecurityHooks` 等消费包内类型 | 随契约更名（如 `SecuritySettings`） |
| 技能/模板 | hooks[具名] 词汇 | settings[具名]（两个 .dsh 技能 + templates 同步） |

**存量迁移与兼容**：

- **P1 从 `AgentConfig` 类型删除 `hooks` 字段**——typecheck 强制全量迁移
  （§2.2 清单只是验收辅助）；双读归一只放 **store 加载边界**
  （agent-store / agents-dir 读取时旧 `hooks` 键归一为 `settings`，类型层
  之下），其余一切读取点由编译器暴露，不靠清单。
- `scripts/migrate-hooks-to-settings.ts`：`<root>/agents/<id>/config.json`
  键改名——纪律**取既有脚本纪律之并集**（幂等 + marker（.migrated-\*）+
  `--dry-run` + 迁移恒等门测试；无单脚本全取四要素，勿抄单一"完整先例"；
  既有脚本无备份逻辑）。
- 写侧只写新键；兼容窗保留至下次数据清仓 / major。
- M21 singles 前缀快照修订键含 hooks 哈希 → 键变 = 显式失效重拍一次（无害）。
- 散词清理：「钩子优先度」→「监听器优先度」等——聚集地在 **webui 前端
  生产面**（见 §五），ac-web-api 中文「钩子」零命中。

### 2.2 A1 全局默认层（X1 之上）

- **存储**：config.json 新白名单域 `settings`——`{ '<行名>': { …全局默认 } }`；
  `enabled` 合法（全局软停用，Agent 差异层可覆盖回 true）。
- **合成口**：`settingsOf(id, name?)` =
  `deepMerge(config.settings[name] ?? {}, agent.settings?.[name] ?? {})`——
  与 `agents/update-config` 同源语义（对象递归合并、数组整体替换、**差异层
  键优先**）；preset / 未知 id 回落全局层。
- **消费侧迁移（X1 之后仍读/写旧键的全部生产点）**：

| 消费点 | 类型 | 风险/备注 |
|---|---|---|
| persona / memory / skill / datetime / security / system-prompt / archive / web-tools | 读 | 迁到 `ctx.agents.settingsOf(id,'<名>')` |
| **ac-singles** | 读（持续） | **正确性风险**：persona 解析 + 前缀快照修订键读 `agent?.hooks`——漏改 = persona 恒空 → KV 前缀快照静默漂移 |
| **ac-collab-tools** | 读 + **运行时写** | update_agent_profile 浅合并写回旧键（PROFILE_ALLOWED_FIELDS 含 'hooks'）——漏改则持续写回旧键，风险最高 |
| ac-workspace | 读 + 写 | sandboxWorkdir 读 + admin.hooks 构造写点 |
| ac-plugin-registry / ac-web-api | 读 | security 读 / archive 读 |
| **ac-agent-admin** | 白名单 | `ALLOWED_FIELDS`（service.ts，'hooks' 恰在行 39）换名——漏改则新键 fail-closed 拒写 |
| ac-agent-presets | 写 | preset 构造字段 |

  `AgentsService.get()` 保持差异层原样。**若 M25 P1 已先行，ac-gate-core
  读点随本批升级 `settingsOf`**（M25 §3.3 互引认领）。
- **冻结坑守卫（显式测试）**：get-config / getAgentConfig 恒返回差异层；
  守卫链 `settingsOf 合成 → get-config → update-config 回写` 后差异层
  不出现仅存在于全局层的键。

### 2.3 X2 目录信息架构（UI 事实源 = `docs/m24-m25-ui-prototype.html`）

**IA 骨架**：插件库两页签「目录 | 插件市场」；目录 = 左导航（插件/工具/事件
三项）+ 右面板；Agent「装配」页 = 目录同构拷贝（左导航同三项）。M23 四页签
（装配行/已安装/待审暂存/开发与会话）退役——行卡片、四态徽章、执行链、
安全模式横幅等已落地组件原样搬入目录视图。

**插件视图**（两组）：

- **内置组**——来源 = **包源清单**，非 cordis.yml（它只答"装了什么"，答不了
  "有什么可装"）：dev = 扫描 `preview/ac-*/` 的 package.json 元数据
  （`rowMetaOf` 解析先例）。生产源首期不裁——生产 bundle 形态下内置组
  **为空 + UI 注明"内置目录仅开发形态可用"**（目录 IA 此时只剩本地组，
  显式接受）；后裁触发条件 = 首个生产 bundle 部署出现时（bundle manifest
  可参考 src 轨道 `scripts/gen-bundle-rows.mjs` 形态，系 src 轨道脚本、
  非直接复用）。RPC 透出，装配状态列与 cordis registry 交叉
  （已装配/未装配）。
- **本地组**——扫描 `<数据根>/plugins/`：registry.json 安装态 ∪ devScan
  开发面 ∪ 会话装载（M23 F11 判据收编为单一清单）；**待审暂存并入为
  徽章态**（待审行 + 审查弹窗，M23 staging 组件复用）。
- **行能力**：启停（内置 = patch toggle 重启生效；本地 = 卸载装载 /
  永久卸载）+ **点击弹出可配置项**（有 configNs 才可点）。

**工具视图**：仅 schema 查看——可配置项已移至所属插件卡片；弹窗内容 =
`tools/list` 现有形状（name/description/parameters/requires），零后端改动。

**事件视图**：壳 + `events/listeners` 数据（M23 已有）；事件/监听器描述
与治理开关随 M25 P2（声明机制见 M25 §3.4）。

**Agent 装配同构**：插件视图 = settings **差异层**编辑（enabled/参数/facet
行——facet 机制 M25 §3.3，本批仅 UI 位预留）；工具视图 = include/exclude
三态 + 能力标签；事件视图 = 本 Agent 生效链（`events/listeners` ×
`agents/assembly` settings 门控态，前端可算；facet 感知随 M25）。
**软约定告警**：门控态呈现依赖"该行尊重 enabled"（ADR-4 自查约定）——
声明目录未覆盖的行 UI 注明"停用未必生效"（respectsEnabled 标记随 M25）。

**配置弹窗（双实例同组件）**：插件库·插件卡片 → 全局默认层（写
`config/set` → `settings.<configNs>`，文案"全局默认，Agent 层覆盖"——
RPC 域白名单 = ac-web-api `CONFIG_KEY_PREFIXES` 加 `settings` 键，ac-config
本身无白名单）；Agent 装配·插件卡片 → 差异层（写 `agents/update-config`，
文案"只存差异项，空 = 继承全局默认"）。数据源 = EXTENSION_CATALOG 条目
**赋 configNs**（`fields` 大多已声明——实际只缺 configNs 赋值；facet 字段
扩展随 M25；注册制目录仍不做）。

### 2.4 X3 插件市场首期

- **行回归**：`ac-plugin-market`（M13/M15/M23 显式缩水项复活；src 轨道
  同名能力参考）。
- **源**：npm registry 话题搜索 + github topic / repo 定位；清单元数据拉取
  （名称/版本/描述/下载量/contracts 声明）。
- **安装流 = 暂存人审**（复用 M23 staging 全套：只读文件代理/内容哈希/
  权限快照/来源锚定 repo·ref·commit）——**第三方供应链维持人审（M23 B2
  裁决），与 Agent 自开发免审流分立**；安装确认弹窗声明来源与权限
  （含 ui 高亮）。
- **落位**：安装 → 暂存 → 「目录 · 插件 · 本地」组待审徽章 + 审查弹窗 →
  人审批准 → 安装装载（M23 approve 流原样）。

### 2.5 X4 tags/capabilities 事实源收敛（F14/L1 收口）

- **事实源 = `AgentConfig.tags`**；有效能力集 = `{ base, agent:<id> } ∪
  tags ∪ settings.security.capabilities`（后者降级为**追加覆盖层**：只加
  不减，收窄出口仍是 AgentConfig.tools include/exclude）。
- 共享动作单写 tags：AgentPane 双写退役；ac-security 双轨对账告警退役
  （覆盖层有值时降级一次性提示）。存量零迁移（已有值继续作覆盖层生效）。

### 2.6 X5 audit.jsonl 轮转（G7 收口）

- `appendAudit` 写前检查大小：超 5 MiB → 轮转 `audit.jsonl.1`（保留 2 份），
  串行队列内 rename；`readAudit` 只读当前份。

---

## 三、迁移步骤（分批，每批独立可验收；**P1 必须先行**）

验收命令统一：`pnpm --filter ac-webui-app typecheck` +
`pnpm exec vitest run preview/webui/tests` + `pnpm preview:typecheck &&
pnpm preview:test` + `pnpm preview:smoke` / boot 手测该批功能。

**P1 X1 词汇收口**：**类型删除旧字段**（typecheck 强制全量迁移）+ 全链改名 +
迁移脚本 + store 边界双读 + ac-singles 修订键改读新键（正确性风险点显式
测试：persona 变更仍使前缀快照失效）+ ac-agent-admin 白名单换名 +
ac-collab-tools 写面换新键 + **webui 前端改名面（§五所列）——RPC 原子切换
后前端 `patch.hooks` 即 fail-closed 硬错，且 shims 是手写类型 typecheck
不报，必须同批落地**。测试：双读归一 / 迁移幂等 / 旧键只读不写 /
**typecheck 零 `\.hooks` 残留**（grep 排除项：`data.bak-m19/` 自然语言、
ac-web-api `_hooks` 执行面监听器表[概念异义]；`templates/` 在 preview 内但
tsconfig include 只扫 src/tests——人工同步；`.dsh` 技能在 preview 外——
人工同步）。

**P2 A1**：config `settings` 域 + `settingsOf` + 消费侧迁移（§2.2 全表）+
ac-gate-core 读点升级（若 M25 P1 已先行）+ 冻结坑守卫 + 合并语义测试。

**P3 目录后端**：`plugin/catalog` RPC（dev 扫描——生产源首期不裁）+
装配状态交叉 + 本地组合并判据 + 待审并入。测试：内置清单与 preview 包集
一致 / 未装配态正确 / 本地四态（装载/安装/熔断/待审）。

**P4 目录与装配前端**：两页签 IA + 左导航三视图 + 内置/本地组 + 工具
schema 弹窗 + 配置弹窗双实例 + Agent 装配同构 + M23 四页签退役。前端测试
按原型走查形状。

**P5 市场首期**：ac-plugin-market 行（搜索/元数据拉取/暂存投递）+ 安装
确认与审查弹窗接线 + 待审落位。测试：搜索结果形状 / 暂存人审全流 /
来源锚定。

**P6 X4 + X5**：能力收敛（§2.5）+ audit 轮转（§2.6）+ 各自语义锁定测试。

---

## 四、显式缩水（接受，不恢复）

1. 注册制目录（扩展行 apply 时注册 schema）仍不做——静态 configNs/fields 够用。
2. 市场首期 = 搜索 + 人审安装：评分/评论/依赖解析/版本升级与自动更新不做。
3. capabilities 不做减法语义（覆盖层只能并集追加）。
4. audit 历史份不进 UI（取证手工查）。
5. 监听器/可配置项排序不做（维持 M22 D3 裁决）。
6. 旧 `hooks` 键双读兼容窗不做自动清理（数据清仓 / major 时人工退役）。
7. 生产形态内置目录为空（§2.3，显式接受，后裁触发 = 首个生产 bundle 部署）。

---

## 五、事实源索引

| 内容 | 文件 |
|---|---|
| **UI 事实源（IA/弹窗/分组原型）** | `preview/docs/m24-m25-ui-prototype.html` |
| 契约字段与合成口落点 | `preview/ac-agents/src/service.ts`（AgentConfig / AgentsService） |
| **RPC 域白名单（settings 键落点）** | `preview/ac-web-api/src/index.ts`（CONFIG_KEY_PREFIXES）；ac-config 为无白名单全量读写服务 |
| config.json 读写与 config/changed 热更 | `preview/ac-config/src/index.ts` |
| deepMerge 合并语义（合成口同源规约） | `preview/ac-config-merge/src/index.ts` |
| 存量迁移与双读落点（store 加载边界；agent-store 本身不感知 hooks 词汇） | `preview/ac-agent-store/src/index.ts`、`ac-agents-dir/src/index.ts` |
| 消费点（§2.2 全表）：ac-singles / collab-tools / workspace / plugin-registry / web-api | 各包 `src/index.ts`（或 service.ts） |
| ac-agent-admin 白名单（ALLOWED_FIELDS，'hooks' 恰在 service.ts 行 39） | `preview/ac-agent-admin/src/service.ts` |
| M21 快照修订键（重拍验证） | `preview/ac-singles/src/index.ts`（prefix-snapshot） |
| 包元数据解析先例（内置清单扫描） | `preview/ac-web-api/src/index.ts`（rowMetaOf） |
| bundle manifest 参考（src 轨道脚本，非直接复用；生产源后裁） | `scripts/gen-bundle-rows.mjs` |
| 本地组判据（registry ∪ devScan ∪ session） | `preview/ac-plugin-registry/src/service.ts`（M23 F11 落地形态） |
| 暂存人审基础设施（市场安装流复用） | `preview/ac-plugin-core/src/store.ts` |
| configNs 挂点 / fields 声明（弹窗数据源） | `preview/ac-web-api/src/index.ts`（EXTENSION_CATALOG） |
| capabilities 双轨现状（收敛对象） | `preview/ac-security/src/index.ts`（M23 P2 落地形态） |
| 前端改名面 + tags 双写点（退役对象；含 webui 生产面） | `preview/webui/src/settings/`（api.ts + components）+ useSettings.ts（delete config.hooks）、ExtToolsPane 参数弹窗、shims/protocol.ts、roster.ts、PluginLibraryPane 可见文案 |
| audit 追加与串行队列（轮转落点） | `preview/ac-plugin-core/src/{audit,fsx}.ts` |
| 三轮审查档案（B/C/D·N 系裁决出处） | `preview/docs/m24-m25-review.md` |
| 词汇与 M24 候选裁决出处 | `preview/docs/m23-agent-plugin-plan.md` §六、§3.9 |
| 迁移脚本先例（幂等 + marker + dry-run + 恒等门之并集——无备份逻辑） | `preview/scripts/migrate-*.ts` |

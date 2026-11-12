# Agent 装配文档（agent-assembly）

> 性质：域深设计——装配合成代数（两段式求值引擎如何把基座、安装事实与差量层合成为一份装配）。
> 状态：已被 [menu-assembly.md](menu-assembly.md) 取代 · cr-1022 批2 2026-11-12 换轨完成（差量求值引擎 evaluate.ts 退役，菜单合成 mergeMenu 就位——本文差量词形自该日起不再是运行现状；cr-1004 批1 / 批2 / 批2b / cr-1007 增量落地史实见下）。
> 读者：改装配求值、写装配文档（差量层）或做插件安装适配的人；身份/数据切面先读 agent-data.md，管控裁决先读 assembly-governance.md。
> 后继：cr-1022 2026-11-12 立项装配第二模型（菜单代数取代差量词形；cr-1025 修订：合成回归 cordis-loader 原语 + 行词汇白名单）——设计稿 [menu-assembly.md](menu-assembly.md)（plan 态）；实施落地前本文描述的差量模型仍为运行现状。
> 分批落地史实（原状态行保留）：**批1 已落地（2026-11-11）**：统一求值
> 引擎 `ac-rowset-core` `evaluate.ts`（两段式 + 席位护栏注入 + 告警分级
> warnings/notices/errors）、文件族改名（`<base>.yml` / `installed.yml` /
> `<base>.patch.yml` 用户差量层——旧名只读兼容 + 版本戳判据的存量
> reconcile）、installed scope 退役（反向适配分析 §三，host 面
> fail-closed）；存量 rows 绝对清单经读侧确定性桥（§七 公式）求值。
> **批2 已落地（2026-11-11）**：agent.patch.yml 差量化落盘（§五——纯
> cordis 条目数组 + `# ac-base` 基线戳：写面保真、boot 对账漂移 fail-loud
> 触发 rebase）；档案字段与 origin 迁 `agent.json`（agent-data.md §三）；
> `scripts/migrate-agent-patch.mjs` v2 档（确定性转换 + 幂等 + --rebase /
> --revert）；写面统一 v2（旧映射/config.json 只读窗口）。
> **批2b 已落地（2026-11-11）**：levels 归位装配条目 config
> （`LEVELS_ROW_OF` 映射单源：browser/collab 行锚定 `config.level`；
> dev-tools 键随行退役〔cr-520——'dev' 能力词无消费面〕）；子身份物化
> 同形 v2（children 不再产 config.json 新存量；会话恢复键 originConversation
> 迁单元文件 origin.json）。读侧桥（legacyRowsToAgentPatch）保留为旧形态
> 读窗口（migrate 收口后随下批退役）。
> **cr-1007 已落地（2026-11-11）**：①写侧精简——expansion 完全落入
> 基础集的加法条目不落盘（§六 只记离差；migrate --rebase 同步瘦身；
> 组合读重建白名单供工具面热更新——无工具行 id 由会话面滤除）；代价
> 裁决：基础集行不再被实例「点名」，用户层停用对实例为静默良定义降级
> （捆绑/installed 加法条目仍 fail-loud）。②基座去预设并集化——预设专属
> 行移出基础集：sap-adt→bundle:abap、plugin-dev→bundle:creator、
> harness-tools/bench→bundle:dev（升 ac-base-version；空白 Agent 不再
> 恒装预设并集，预设经差量点名装载）。
> 本文只讲**装配合成**——一个求值引擎
> 如何把基座、安装事实与差量层合成为一份装配。**词汇表里没有「Agent」**：
> 代数不知道 Agent，身份层知道代数（单向依赖）。权限/信任/管控裁决不在此处
> （见 `assembly-governance.md`）；身份与数据见 `agent-data.md`。配图（2026-10-13 版）
> 未随修订更新——已随批 1 检阅移除引用（原配图自母档时代，与现两段式模型不符，
> 存档于 `docs/design/archive/assembly/per-agent-instance-architecture.html`）。

## 一、分家判据（三文档边界）

| 问 | 归属 |
|---|---|
| 装什么、怎么配（行成员 / 适配分析 / 行内 config） | **装配**（本文档） |
| 谁允许用什么词形、第三方信任边界、审批与熔断 | 管控（assembly-governance.md） |
| 文档放哪、档案数据、积累性状态 | 身份/数据（agent-data.md） |

## 二、合成模型：两段式、一个引擎

### 文件族与命名纪律

**「patch」中缀专属差量文档**——基座与登记不是差量，不带中缀：

| 文件 | 角色 | 命名逻辑 |
|---|---|---|
| `<base>.yml` | 出厂基座（repo 源码化——行→包映射，cordis-plugin-loader 方言，带 `# ac-base-version` 戳） | 它就是基座，非 patch |
| `installed.yml` | 安装事实单源（名字/目录/owner/disabled/哈希——**无 scope 投影**） | 登记簿，非 patch |
| `<base>.patch.yml` | 用户全局差量 | patch ✓ |
| `agent.patch.yml` | 实例差量（agents/<id>/ 内——名字沿用，语义直观：定义此 Agent 的差量） | patch ✓ |

### 两段式合成（每进程种类同形，可泛化到任何装配启动）

```
存在合成（无差量语义——并集与适配分析）：
  rows = <base>.yml
       ∪ 适配分析(installed.yml × ac.faces.<base>)   # 见 §三

差量合成（逐层 delta，外层剔除内层不可见）：
  ← <base>.patch.yml        # 用户全局差量
    ← agent.patch.yml       # 实例差量（仅多实例基座有此层——host 单例无）
```

```
evaluate(base, installed, patches) → composition    # 纯函数：无身份、无权限判断
```

- 层序即优先级：实例层点名被 `<base>.patch.yml` 停用且无豁免的行 =
  求值 fail-loud（点名不可见行，非静默丢面）；
- 现状病灶（本模型取代）：① deriveShellRowset 双形态与 custom 过滤**双轨消费**；
  ② 恒并席位六件特判（双轨病理的收信面补丁）——统一引擎后席位 = 基础集
  成员，特判自然消解；③ 安装器 scope 正向投影（双源漂移面——反向适配取代）。

## 三、适配分析（反向处理——基座分析包，非包投影基座）

```
fit(installed.yml, base) = { row | p ∈ installed
                               ∧ p 未 disabled
                               ∧ p 的包声明命中本基座 face（ac.faces.<base> /
                                 manifest.rows 声明——词表随基座泛化）
                               ∧ owner 锚放行（机制在此，策略见管控文档） }
```

- **登记的是事实，适配是求值**：不持久化投影文件（base-installed 之类），
  消灭「包内容改了、投影没刷」的双源漂移；
- 不适配 = 自然跳过 + 警告（降级语义，同「点名缺席」口径）；
- **泛化免改**：新进程种类注册 processes.json 后，其基座求值器查自己的 face 键，
  安装器与登记簿零改动；
- **face 是事实声明，不互斥**：包可同时声明多个 face（node + web——内聚
  交付物的合法形态；各基座求值器独立查自己的键，零干扰）。「1」锁在装载
  入口：每 face 恰一个 entry/channel manifest（装载失败熔断、指纹、watch
  热重载的单元边界）；行是 face 内的复数能力。face 组合的信任限制归
  管控文档，不进 schema。

## 四、条目词形与求值代数

### 词形（全层共用一套，cordis 方言邻接；**层权限表在管控文档**）

| 键 | 语义 |
|---|---|
| `id` | 行 id / 工具名 / 捆绑词（消歧：行名优先——声明面单位是行） |
| `disabled` | 减法（闭包后执行——显式排除 = 良定义降级） |
| `except: [instanceId]` | 停用豁免（仅随 disabled） |
| `replace: 'link:<dir>' ∨ 裸包名` | 实现替换：id 不变 path 换向；替换件 manifest 同 id 条目覆盖 tools/requires |
| `config` | 行内配置（cordis 方言原生）——现 levels 机制归位于此 |

### 代数

```
基础集 = 基座非捆绑行（恒并席位天然在内——conversation/persona/conduct/
         llm-pool/auto-title/host-face-client，无需特判）
  ∪ fit(installed)                    # §三适配分析
  ∪ 各 patch 层加法展开（byRow / byTool / byBundle——词形单源）
  − 各 patch 层减法（disabled；闭包后执行）
  → requires 闭包（依赖行递归并入）
  → 静态断言（fail-loud 契约，boot 消费）
```

replace 在 `<base>.patch.yml` 层先行换向，agent.patch.yml 对换向后的行
正常加法点名。席位护栏（custom 层停用拒绝）是管控策略非代数，见管控文档。

## 五、基线参数化（策略与代数分离）

agent.patch.yml 是**纯 cordis 条目数组**（与整栈同方言——层差异只在求值器
语义，不在文件格式）；基线指纹是文档元数据，走注释戳（`# ac-base-version`
同款纪律，写面随差量重写时负责保留）：

```yaml
# ac-base: <fingerprint>      # 基线戳——本差量相对的存在合成指纹
- id: fs                       # 加法（行 id / 工具名 / 捆绑词——标准条目）
- id: memory
  disabled: true               # 减法（标准条目）
- id: shell-tools
  config: { profile: full }    # 行内配置（levels 归位——cordis 原生 config）
```

> 否决过的变体：伪插件行（`- id: agent-patch, name: <ac-agent-patch>, config: {base}`）
> ——元数据穿插件马甲：name 指向不存在的模块（真 Loader 误食即炸）、求值器需
> 特判该 id（刚消灭特判又造一个）。DSH 的 preset 行先例不适用：那是**有注册
> 行为的真插件**，config 携带语义合法；空壳假插件只为带数据不值得。

- 求值**恒对 ac-base 戳对应的存在合成快照**执行——基座/安装态演化对存量
  实例**不静默传导**；
- 追新 = **rebase**：调用方策略触发（身份层的升级裁决，见 agent-data.md
  §origin），代数对 rebase 无感知——只是对一组新输入重新求值。
- 写侧归一副产品：`<base>.patch.yml` 与 `agent.patch.yml` 同方言同条目形，
  toggle 归一代码跨层复用。

## 六、写侧归一纪律（防文档腐化）

写面（编辑器 / update_agent_profile / 迁移脚本 / 设置 UI）：

- **改一行 = 写一条差量；与基线一致 = 删条目**——文档永远只记离差，
  不落全量快照；
- 违反者会把差量文档重新腐化成快照，读侧代数救不回来。

## 七、迁移（确定性转换，非读侧窗口）

存量 `rows:` 绝对清单 → 差量：以当时**基础集 B** 为参照、目标集 T 已知 →
`加法 = T − B`、`减法 = B − T`，基线指纹取迁移时点。幂等可逆，migrate 一档。
读侧不做双窗口（转换无损）。**基座改名（`<base>.patch.yml` → `<base>.yml`、
`installed.patch.yml` → `installed.yml`）与 scope 投影退役随实施批顺带做**：
materializeBaseDocs 对账、版本戳、gen-row-catalog 投影、bundle 资产面、
存量数据根 reconcile 同批同步。

## 八、与现状的差异清单（实施对照）

| 现状 | 目标 |
|---|---|
| deriveShellRowset 双形态（缺省基础集 / 点名恒并补丁） | 统一 evaluate（§四） |
| applyShellCustom + rows 派生双轨消费 | 单引擎两段式求值 |
| installed.patch.yml 单文件 + scope 字段正向投影 | installed.yml 事实单源 + 反向适配分析（§三） |
| shell-custom.patch.yml（装配 + 管控混名） | shell.patch.yml（词形权限表移管控文档） |
| agent.patch.yml 的 rows 字段 | agent.patch.yml 差量化（名字沿用，内容只剩装配） |
| levels（AgentConfig 平铺字段） | 装配条目 config（cordis 方言原生） |
| origin 块住 agent.patch.yml | base 指纹住装配头；origin 全量块住 agent.json（数据） |

# 插件体系规范（纯设计稿）（plugin-architecture）

> 性质：域深设计——插件体系现行规范与裁决：包即插件、装配差量代数、治理与进程边界。本稿只写**规范与裁决理由**：不记实施台账、不记 CR 号、不留「切片一/已落」这类在途注记——那些住 `cr-log.md` 与 `git log`。读本稿应当能一次建立完整坐标系。
> 状态：现行 · cr-1006 2026-11-11 立稿；cr-1008 2026-11-11 批 4 检阅：装配代数经 cr-1004/1007 落地后 §四文档族已按现行文件名（`<proc>.yml` 基座 / `installed.yml` / `<proc>.patch.yml` 用户差量层）对齐，§十三现状列补 cr-1004/1007 落地注。
> 读者：写插件、改装配链或动插件治理门禁的开发者；考古 v2.1 迁移过程读 [plugin-architecture-v2.md](../archive/plugin/plugin-architecture-v2.md)。

关系：取代 `plugin-architecture-v2.md` 的规范性内容，以及原 cr-1004 立项稿
`agent-patch-delta.md`（工作稿，未入 git；其裁决内容由
[agent-assembly.md](../assembly/agent-assembly.md)、[agent-data.md](../assembly/agent-data.md)、
[assembly-governance.md](../assembly/assembly-governance.md) 三档定稿承继）§3.2
（成员闸）、§3.4（rebase 代数）部分。被取代的裁决不构成待办。

用语：**必须 / 禁止 / 仅可** = 强制；「裁决」= 结构性选择 + 理由，偏离须先改本稿。

## 一、一句话

一个插件 = 一个包；一个 Agent = 一份装配差量 + 它自己的数据；**存在什么由平台声明，
要什么由 Agent 声明，二者互不代写**。

## 二、本体

- **Agent ≡ 壳（两态）**：定义态（文档族）/ 运行态（进程），一 Agent 一壳。
- **进程种类**：host / webui / shell，开放集。webui 是**可独立部署的前端产物**
  （断连降级），不是宿主 spawn 的普通子进程。
- **三层身份**（见下表）：存在域 / Agent / Conversation 不可合并。

| 层 | 回答 | AgentChat |
|---|---|---|
| ① 存在域 | 什么可用 | 基座 ∪ installed |
| ② Agent | 我是谁（跨交互连续） | `agents/<id>/`：装配 + 记忆 + 锁 + 地址 |
| ③ Conversation | 这次发生什么 | conversationId 寻址 |

> 裁决：②③ 必须劈开。社交寻址、记忆积累、插件信任的进程边界都挂在 ② 上。
> DSH 由 Session 兼任 ②③ 是个人工具的解（密度 + 缓存稳定），不是同一问题的另一答案。

## 三、插件单元

唯一格式：npm 包（或等价目录）。AgentChat 专属声明住 `package.json` 的 `ac` 字段。

```json
{
  "name": "ac-plugin-todo",
  "engines": { "node": ">=23", "agentchat": "^2" },
  "ac": {
    "faces": {
      "node": { "entry": "./src/index.ts" },
      "web":  { "entry": "./client/index.js", "seats": ["tool-card"] },
      "data": { "skills": "./skills", "theme": "./theme" }
    },
    "permissions": ["fs"],
    "provides": { "tools": ["todo-add"] }
  }
}
```

- **三面**：node（进壳进程，**授权面**）/ web（浏览器，**降级面**）/
  data（技能、主题、人格，**零装载纯物化**）。node 面禁止再分 host/shell
  ——多进程贡献 = 子路径 entry 在不同基座各插一行。
- **TS 源载统一**：entry 直指 `.ts`，Node strip-only 直载，**发布无构建步**；
  `engines.node` 门住 strip 能力。出厂行与第三方行**同一装载形态**。
  > 裁决：双形态（出厂制品 / 第三方源码）会立刻长出两条通道、两套门禁。
- **兼容门自求值**：`engines.agentchat` 由装载器读字段自判 semver，不依赖包管理器；
  peerDependencies 仅元数据，**禁止作门**。
- 一个包可贡献多进程行：子路径 entry，在不同基座各插一行。
- provides 对账、保留字护栏、owner 私有性照旧。

## 四、存在域与生效域

**四份文档，每份写者唯一。**（文件名已按 cr-1004 文件族改名：基座与登记不带
「patch」中缀——中缀专属差量文档；旧名 `<proc>.patch.yml` 基座 / `installed.patch.yml`
只读兼容。）

| 文档 | 写者 | 回答什么 |
|---|---|---|
| `profile/<proc>.yml`（repo 内，随 app 部署） | 出厂 | 该进程出厂有哪些行 |
| `profile/installed.yml` | 安装器 | 第三方加了哪些行（`name` 定位 + owner 锚 + `scope`） |
| `profile/<proc>.patch.yml` | 用户 / 设置 UI | 该进程的**默认**停用集 `{id, disabled}` |
| `agents/<id>/agent.patch.yml` | 用户 / 创建流 / Agent 自身 | 该 Agent 要什么（差量）+ 档位 + origin |

- **存在域（菜单）M = 基座(proc) ∪ installed(scope:proc)**；菜单只回答「有这件东西」。
- **生效域 = 默认层（custom）× 逐 Agent 差量（assembly）**。
- **行内定位，不定位物理位置**：行以 `name` 指名插件（cordis 原生解析：包名 /
  `link:<dir>` 路径 / 目录）。物化位置不是身份。

| 形态 | 落位 | 依赖解析 | 定格指纹 |
|---|---|---|---|
| npm（`@scope/pkg` / `pkg`） | profile 的 pnpm 根（lock 锚定） | 完整 | 锁文件树指纹 |
| link / 目录 | 原址或 `plugins/<name>/` | **禁止裸依赖**（import 失败 = 装载失败） | 内容 hash |

- **行元数据**（基座声明，装载器消费）：`id` / `name` / `packs` / `tools` /
  `bundle` / `requires` / `adopt` / `seat`。`id` **仅基座内唯一**（`config` 在
  host 与 shell 各一条是合法的），跨基座引用必须带 `scope`。
- **`adopt: auto | manual`**（缺省 auto）——见 §五 代数，**这是「基线跟随」的唯一机关**。
- **`seat: true`**——席位行：在语义基线上恒在，且 **custom 停用被写侧拒绝并说明原因**
  （防静默半激活）。席位集是**数据**，不是代码常量。
- **基座部署链**：boot 把 repo 基座逐字节物化到数据根副本并对账——副本缺席 / 源版本更新
  → 重物化；副本版本更高（旧应用压新数据根）/ 同版本内容漂移 / 写后读回不符 → **fail-loud**。
  版本戳 = 文档头注释 `# ac-base-version: N`（官方方言顶层数组不容元数据字段）。
- **出厂基座永不运行时写入**；用户行级启停只走 custom 层。
- **不存在顶层全局 patch 文档**：全局文件没有剩余职责。

## 五、装配代数

每 Agent 壳 boot 用四份文档现算一次，**不缓存决策**（boot-graph.json 只是审计快照，不承重）。

```
M = 基座(proc) ∪ installed(scope:proc)          存在域
D = custom 停用集                               默认层
B = M 中非捆绑行
E = { r ∈ B | adopt(r)=auto } − D               语义基线（无 Agent 私存状态）
A = assembly 加法（行 id / 工具名 / 捆绑词）     显式意图
S = assembly 减法
R = closure(E ∪ A) − S                          闭包先于减法
```

**闭包** = 捆绑词展开（词本身即显式意图，不受 `adopt` 约束）+ `requires` 递归并入。
**减法作用于闭包之后**：用户减法不被闭包复活；减掉幸存者的依赖 → boot 装配终检
**fail-loud** 拦截。

- **加法不受 D 与 adopt 约束**（显式胜默认），但仍须在 M 内命中；越权覆盖默认时
  **记一条提示**（不是静默，也不是拒绝）。
- **`adopt: manual` 行只有被点名才出现**——这就是「基座新增行不得静默扩张能力面」的
  全部代价：repo 内一个比特。
**未命中 → 警告 + 跳过 + 上报，禁止阻断 boot**：

| 情形 | 处置 |
|---|---|
| 加法点名不在 M（未安装 / 已删行） | 警告 + 跳过 + 上报（指路：装、或删差量条目） |
| 减法点名不在 M | 警告（撤销一个已不在的行，幂等无害） |
| 基座新增 auto 行 | 自动到达（这是特性，不是漂移） |
| 基座新增 manual 行 | 不进壳；进「待领养」报告（设置面可见） |

- **缺省形态唯一**：assembly 缺席 = `R = E`。不存在「点名形态 / 缺省形态」双分叉。
- 领养（把 manual 行纳入某 Agent）= 往该 Agent 的 assembly 写一条加法。**可逆、可归属、
  意图可读**；拒绝该行 = 什么都不做。无 rebase、无确认流、无逐 Agent 已知集。

  > 裁决：**基线跟随靠 adopt 标记，不靠 Agent 侧快照**。快照（全量清单）让基座演化
  > 不传导、意图不可分辨、模板不能 rebase；而 per-Agent 已知集只是把快照换成机器私存
  > 状态——67 份文档各带一份与 repo 文件赛跑的时间戳，换取同一保证。一个比特换 67 份状态。

## 六、Agent 定义

```
agents/<agent-id>/
  agent.patch.yml     # 装配差量 + 档位 + origin
  <plugin>.json …     # 插件配置：各插件自定自读，框架不解释内容
  *.md …              # 人格数据：persona 行按自身配置选择（文件名不写死）
  sessions/ children/ interactions.jsonl boot-graph.json   # 运行产物
  activation.lock     # 壳单例
```

```yaml
assembly:
  - id: fs
  - id: subagent
  - id: memory
    disabled: true          # 减法 = 显式撤销
tier: …
tool-mode: …
levels: …
origin: { template: creator, hash: … }
```

- **档位全部归装配**（tier / tool-mode / levels 等，能力面 = 装了什么 × 什么档位，同居
  一份可审计文件）。**框架级 settings 域不存在**；插件配置各归插件。
- **无系统提示字段**：系统提示由平台行分权组装；人格是 persona 行消费的数据。
- **origin = 出生来源 + 模板指纹**，只用于「模板演进要不要提示」。
  **模板是初值，不是常驻层**：没有 `presets/<name>.patch.yml` 这一层。
- **写侧归一纪律**：改一行 = 增/删一条差量；与基线一致 = **删条目**（文档不腐化）；
  unknown 键 fail-closed。
- 运行时注册的动态 Agent 物化同一文档形状（契约是数据形状，不是代码路径）。
- **组装权限分离**：往基座加新行 = 安装器（Agent 可触发，仅限 owner 域，审批**人签**，
  最坏情况 = 给自己壳装代码，与既有 run-code 权力等价）；从菜单挑行 = agent.patch 的
  天然权力。

**迁移形态**：cr-1022 批2 起装配口径 = 菜单片段（行定义正清单——见 assembly/menu-assembly.md）；存量差量/绝对清单经 boot 读侧桥与 migrate 脚本确定性换算（旧 B−T 语义：加法 = T−B，
减法 = B−T），一次性执行、幂等可逆。**不做读侧双窗**——转换无损，双窗只会延长两套语义
并存期；存量绝对清单读侧仅留警告并指路迁移。

## 七、治理

- **审批卡（仅 node 面）**：permissions + provides + 来源锚定 + 依赖树变更（lock diff）+
  豁免规则命中清单。
- **免审 ≠ 无门禁**：web 面保留 ui 权限显式授予 + 高危席位评审 + RPC 白名单；
  data 面如实定性为**提示注入面**（来源徽章 + 署名）。**ignore-scripts 强制**。
- **指纹分轨**：npm = 锁文件树指纹；目录 / link = 内容 hash。link 的 watch 仅 dev 态
  会话级，不触安装态定格。
- **回执两轴**：`install-result（applied / failed / needs-reinstall）` ×
  `effective-state（live / restart-required / overridden / blocked-by-live-process）`。
  后者联动 `activation.lock`（Windows EPERM/EBUSY 显式回报）。
- **授权 = 行装载单闸**：行不在 R 内即不可调用。
- **owner 锚**：owner 行只进 owner Agent 候选集；共享 = owner 侧显式放行 + 对方点名，
  放行动作**人签**（Agent 不可代签）。
- **安装器事务**：根锁 + 半态恢复；装上 ≠ 生效必须显式回报。
- **降级可见面（硬要求）**：一切 fail-soft 处置必须汇入**用户可见面**——「降级 /
  待领养 / 冲突」三类计数常驻（Agent 卡片 + healthz），**禁止只落文件日志**。
  > 裁决：警告产生 ≠ 用户知道。分层 fail-soft 若无可消费出口，等于把 boot 崩溃换
  > 成静默部分激活——那正是本体系要消灭的病。

## 八、进程边界

- **R0a**：宿主永不装载第三方代码。node 面在壳进程，web 面在浏览器，data 面零装载。
- **启动脚本禁止进数据根**：boot 期代码执行入口放在用户可写区 = 安全红线。
  **进程种类注册表住 repo**（boot 入口 / spawn argv 契约 / IPC 与端口 / 审批归属）；
  数据根只有声明式启用配置（启用哪些进程形态、端口），无脚本、无轮询。
  「加一种进程 = 注册表一行 + 一份基座源文档」。
- **web 面统一通道**：工厂 web 件与第三方 web 件走**同一资产通道**，按 webui 装配文档
  装载，可 override / disabled。工厂件保留 TS/Vue→JS 构建步（浏览器不 strip TS），
  但产物走同一通道——**无特权路径 ≠ 无构建**。

## 九、数据根

```
<dataRoot>/
  agents/<id>/            # 装配 + 插件配置 + 人格 + 运行产物
  files/<id>/             # 沙箱；自开发插件源码
  groups/ memory/ usage/ timer/ … sap-adt/ remote/
  config.json             # 全局配置 + 进程启用声明（声明式，无代码）
  .runtime/               # 易失运行时态
  profile/                # <proc>.patch.yml · <proc>-custom.patch.yml ·
                          # installed.patch.yml · package.json · pnpm-lock.yaml
  plugins/<name>/         # 目录形态物化（含自开发定型）
```

备份口径：**lock + patch + plugins/ 随行，npm 形态的 node_modules 重装**（恢复钩子 +
needs-reinstall 回执）。

## 十、不变量（回归判据）

1. **单一格式**：唯一插件格式 = 包；不存在第二入口、第二通道。
2. **单一写者**：每份文档只有一个写者；谁写的语义，谁负责解释。
3. **存在与生效分离**：菜单变化不改变任何 Agent 的装配意图（差量不变即意图不变）。
4. **显式胜默认**：默认层可被逐 Agent 显式覆盖，覆盖必须可见（提示一条）。
5. **无静默**：每个跳过都有上报，每个上报都有可见消费面。
6. **fail-soft 边界显式**：用户域与 Agent 文档不得打死 boot；平台级不一致必须 fail-loud。
7. **授权 = 装载单闸**：不在 R 内即不可调用。
8. **零特权路径**：出厂件与第三方件走同一装载路径、同一通道、同一门禁。

## 十一、显式留白

- **实现替换（`replace`）**：仅 dev 态会话级（换自己壳里的实现，重启即失）。进用户域
  需先有真实消费方——当前为零。
- npm scope 与既有 asset / manifest 词法的收敛（放宽正则 or 命名约定）。
- 离线 / 私域 registry；Windows link 跨盘。
- webui 独立部署与连接协议（另档）；UI 插件形态细节（另档）。
- 「待领养」报告的呈现形态（读侧报告 + 写侧普通差量编辑；不引入第二套交互动词）。

## 十二、被否决的方案

- **绝对清单 / 快照式 agent.patch**：基座演化不传导、意图不可分辨、模板不能 rebase。
- **per-Agent 已知集 + 钉住式 rebase + 确认流**：机器私存状态 × Agent 数，与 repo 文件
  赛跑；同一保证由 `adopt` 一个比特承担。**默认钉住 = 基座每加一行产生 N 条待办**，
  把平台演进变成运维跑步机。
- **custom 层 `except` 豁免**：权威倒挂——Agent 想开的行要写进全局文档的 agentId 列表，
  同一决定两个写者、单向解析。改「显式胜默认」，一条规则。
- **custom 层 `replace`**：id 不变 + path 换向 + 工具面覆盖 + 授权域例外，一套依赖注入
  覆盖子系统，零消费方。属提前抽象。
- **`presets/<name>.patch.yml` 文档层**：无行为缺口的对称层（模板已是初值）。
- **恒并席位常量**（代码内六 id 并集）：席位属数据，且差量形态下天然在基线内。
- **单组合树 + 行锚 tree + boot 过滤**：R0a 靠规则不靠结构；两值枚举焊死拓扑。
- **顶层全局 `cordis.patch.yml`**：per-进程 custom 后无剩余职责。
- **pnpm 独占据位**：行名定位多形态取代，依赖分层规则保住解析必要性。
- **dist 直供特权通道 / SPA 内模块**：重建两条路径病根，且不可 disabled。
- **boot/ 目录进数据根**：用户可写区获得 boot 期代码执行。
- **四词单枚举回执**：三种语义塞一个枚举。
- **自建 plugin registry**；**peerDependencies 作兼容门**。

## 十三、与现行实现的差（实施批依据）

> 批 4 检阅注（cr-1008）：本表为 cr-1006 立稿时的差距快照；cr-1004/1007（两段式
> 求值引擎 + 文件族改名 + agent.json 档案）落地后部分「现状」已演进——逐行注记如下，
> 未注行截至检阅日仍是现状。

| 现状 | 本稿 |
|---|---|
| `origin.known` 成员闸 + rebase 代数 + 确认流（未实施） | 基座行 `adopt` 标记 + 逐 Agent 加法领养 |
| `shell-custom` 的 `except`（现行词形；cr-1004 改名后住 `<proc>.patch.yml`，仍是现行词形） | 删除；改「显式胜默认」 |
| `shell-custom` 的 `replace`（现行词形；cr-1004 改名后住 `<proc>.patch.yml`，仍是现行词形） | 退出用户域，仅 dev 态会话级 |
| `SEAT_ROW_IDS` 常量（`ac-rowset-core`）——cr-1004 起经 `evaluate` `seatIds` 注入消费（策略与代数分轨），常量本身仍在 | 基座行 `seat: true`，deriver 不认常量 |
| 五层装配链（基座→custom→installed→preset→agent）——cr-1004 起已收敛为两段式单引擎（`ac-rowset-core` `evaluate`：存在合成 = 基座 ∪ installed 反向适配；差量合成 = 用户层 → 实例层），方向与本稿一致、词形有差（见 [agent-assembly.md](../assembly/agent-assembly.md)） | 四份文档、两轴（存在域 / 生效域） |
| 规范内含实施台账与 CR 注记（v2 稿形态） | 台账迁 `cr-log.md`，本稿只留规范（本稿即 cr-1006 产物） |

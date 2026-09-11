# M27 WebUI 纯 Slot 重构计划 · 二次评审（对 v2.1）

> **【存档 2026-11 · M30 收官后整理】** 历史评审实录——修订已折叠进
> 计划 v2.2/v2.3 并随 M27 实施收官。快照时点行号，勿按本文对拍当前代码。

> 评审对象：`docs/m27-webui-slot-refactor-plan.md` **v2.1**。纯读评审，无代码改动。
> 方法：① 首评（`m27-webui-slot-refactor-plan-review.md`）§7 修订清单 11 项逐条
> 核对 v2.1 落实情况；② 计划事实断言对当前代码再核（防首评后代码漂移）+
> 新查首评未覆盖项；③ 决策索引 ↔ 正文 ↔ 阶段落点三方一致性排查；
> 四份输入文档交叉比对。
> 结论速览：**v2.1 对首评修订清单全量落实（11/11），未引入新的编号/落点
> 矛盾，事实底座零漂移；但发现 1 个 P1 缺裁（客户端 Context 类型身份与
> 服务端服务名撞名）与 3 个 P2 缺口（第三方 slot 开口策略 / runview
> 落点 / 横切约定挂靠）。补齐后即可开工。** 明细见 §4。

---

## 1. 总体结论

- **修订落实到位**：首评 P0（D19 贯穿）已彻底重写 S3/S4/§3/§4；S1.5
  增强门、D15 签名占位、风险表两代断层行、desktop、D13 永久双读、
  D8 收窄、参照系注记、D21 遗留入口、D1 分两步、编号映射注记、
  main.ts 24 行——全部落地且相互一致（§2）。
- **事实底座零漂移**：关键数字与首评字节级一致（feed.ts 79828B /
  chat.ts 40821B / main.ts 24 行 / App.vue 15 组件 import），代码自
  首评以来未动，首评 §2 的 16 项核查继续有效；本次新查 7 项，6 项
  通过、1 项失名（§3）。
- **本次发现的问题集中在「计划两轮都没问到的面」**：客户端与服务端
  共享同一 vendored cordis 类型身份时的服务命名冲突（P1）、第三方
  slot 声明的开口策略、runview 域的物理落点、slot 树 §5 横切约定的
  挂靠（P2×3）。均可用少量裁决句收口，不动架构方向。
- **纪律符合度维持**：首评 §6 的全绿判定不受 v2.1 重排影响；P1 缺裁
  本质是「契约归属 owning package」纪律在客户端侧的未完成部分。

## 2. 首评修订清单落实核对（11/11 ✅）

| 首评条目 | v2.1 落点 | 判定 |
|---|---|---|
| P0 · D19 贯穿 S3/S4/§3/§4 | S3 改「迁入行包 client/，不新建包不新增行」+ 验收改「卸载 ac-todo 行 → 后端 + 前端消费面一并消失」；§3 影响面改「行包（≥15）各加 client/」；§4 不变量改「卸载任一域行或客户端件」 | ✅ |
| P0 · 基础七件形态裁决 | D19/D11/S4 三处一致：S4 复核定案（clients/base/ 常驻 vs ac-client-app 单包），S1/S2 期 in-bundle 不受影响 | ✅ |
| P1 · 增强级验收门 | S1.5 独立阶段：五项清单（SlotMap 类型化 / cell 选举 / store 座位 / inject / onEntryError）各带单测 + 「朴素贡献语义锁定」验收门；S0 明确「store 实例轴与 onEntryError 不在 S0」 | ✅ |
| P1 · 两代语义断层入风险表 | §5 专行（断层描述 + D15 占位 + 语义锁定测试 + 差异单测显式记录）；D15 落实「签名按终态形状占位」 | ✅ |
| P2 · desktop 入影响面 | D21 + §3 影响面 desktop 行 + §4 结构性测试（desktop 构建冒烟 S3/S4）+ S3 验收 `pnpm --dir desktop dist` | ✅ |
| P2 · D13 永久机制 | 「manifest ui.slots 双读归一为永久机制、无拆桥期」显式写明；退役的只是前端内部旧注册面 | ✅ |
| P2 · D8 措辞收窄 | 组件贡献类六项转发 slots.register；registerGlobalStyle 维持消毒通道、registerEventHandler/wsOn 并入 D20；isolated 档不进注册表 | ✅ |
| P2 · 参照系版本注记 | 头部注记 0.1.2-rc.1 两包并入事实 + S0 开工前复查条款（并包动机适用则重裁） | ✅ |
| P3 · preview-main / isolated-runtime 归属 | D21 三条（isolated-runtime 迁 ac-client-runtime / preview-main 留薄壳 / desktop 入验收） | ✅ |
| P3 · 240 插口首版形态 | D1 分两步：S0/S1 string key 运行时声明账本 → S1.5 SlotMap 类型化；S1.5 条目 1 显式「240 插口从账本升级为类型化」 | ✅ |
| P3 · 编号映射 / main.ts 行数 | §1 末映射注记（研究文档 "D16"=本文 D19 已澄清）；§0.1 改 24 行 | ✅ |

另核：决策索引 22 条（D0–D21）与正文一一对应、无缺号；「落点」列与
§2 各阶段全部对得上；三处修订关系标注（D19 改裁 D0 / D15 细化 D1 /
D16 细化 D2·D4）与正文一致。

## 3. 事实复核（再核 + 新查）

再核（抽样，全部通过）：main.ts 24 行；App.vue 15 个 .vue import；
10 store 齐全、feed.ts 79828B / chat.ts 40821B（与首评字节级一致）；
BUILTIN_SLOTS 在 `ac-webui-extensions/src/service.ts:68`；desktop
`DEFAULT_PORT = 3830` + `loadURL`；preview-main.ts / isolated-runtime.ts /
scripts/check-deps.mjs 存在；webui 包名 ac-webui-app（vue-tsc + vite
build）；src/ 下无 ac-client-* 包（「未实施」声明成立）。

新查（首评未覆盖项）：

| # | 计划声明 | 结果 | 证据 |
|---|---|---|---|
| 1 | D20「现 wireRpc.onWireEvent 的 cordis 化」 | ✅ 存在；且消费方比计划表述更广：onWireEvent 10 处消费（feed/jobs/groups/singles/chat 五 store + useQueuedMessages/useTaskTracking/useSettings 三 composable + host/isolated），§0.3「feed/chat/jobs 各自解析帧」程度低估、方向正确——D20 收益只会更大 | `webui/src/api/wire.ts:54` 及各消费点 |
| 2 | §0.3 层 2「由 **api-remotes** 喂养」 | ❌ **失名引用**：全库无 api-remotes 模块。实际形态 = `webui/src/api/` 目录 13 个远程模块（roster/jobs/runs/groups/singles/usage/tasks/skills/files/chat-ops/system/extensions/wire）+ `core/api/client.ts` | `webui/src/api/*`（§4-G） |
| 3 | §0.3 客户端服务命名（ctx.jobs / ctx.singles 等） | ⚠ 服务端已占用同名：ac-jobs 声明 `Context.jobs`、ac-singles 声明 `Context.singles`（augmentation 目标同为 '@agentchat/cordis'）→ 见 §4-A | `src/ac-jobs/src/service.ts:183`、`src/ac-singles/src/service.ts:579` |
| 4 | D5「直接复用 src/vendor/cordis」的浏览器可用性 | ✅ 维持首评判定（首评 §2-11）；本项补充的是**类型身份**问题而非运行时问题（§4-A） | — |
| 5 | webui 现状与服务端类型的隔离方式 | ℹ 现状用本地 shim（`shims/@agentchat/protocol.ts`）避开服务端类型导入——该模式与 S3「行包 client/ 半边同包」形态天然冲突（半边 import 同包 contract 类型才是自然形态），佐证 §4-A 需在 S0 定身份 | `webui/src/shims/` |

## 4. 新发现问题（按优先级）

### 4.1 【P1】客户端 Context 类型身份未裁决；ctx.jobs / ctx.singles 与服务端服务名撞名

- **事实**：服务端 ac-jobs / ac-singles 均经 `declare module
  '@agentchat/cordis'` 声明 `Context.jobs` / `Context.singles`。计划
  §0.3 把客户端域投影暴露为 `ctx.<domain>`（归属表：jobs.ts →
  ctx.jobs、singles.ts → ctx.singles），D5 只裁了**运行时**复用
  vendor cordis，未裁客户端服务的**类型身份**（augmentation 目标）。
- **后果**：客户端包若同样 augment '@agentchat/cordis'，同名异型 →
  TS2717 声明合并冲突。S1/S2 期冲突还只是潜在（webui 现用 shims 与
  服务端类型隔离）；**S3 行包双半边同包后，server `service.ts` 与
  client `client/` 在同一包程序内，撞名必然显形**。且这不是 S3 才
  能处理的决策——按 D15 自己的纪律（「API 签名从首版起按终态参数
  形状设计……演进 = 行为增强而非签名变更」），Context 身份是 S0 建
  ac-client-runtime 时就要定的一等签名。
- **修订方向**（三选一，建议 a）：
  a. ac-client-runtime 导出独立客户端 Context 类型身份（`class
  ClientContext extends Context`；客户端服务与 slot 声明合并目标 =
  'ac-client-runtime' / 'ac-client-slots'，不碰 '@agentchat/cordis'）；
  b. 客户端服务统一加前缀（如 ctx.ui.jobs）；
  c. 逐个更名避让（最差——撞名集会随两侧演进取交集增长）。
  并把「客户端服务名与服务端占名查重」（服务端扁平命名空间纪律的
  客户端镜像）写进 S0 验收或新增能力域 checklist。

### 4.2 【P2】第三方 slot 声明的开口策略与校验数据源未裁

- 旧世界 fail-closed 是双层的：后端 BUILTIN_SLOTS 静态表（**只开 6
  个** slot）+ 前端 assertSlot 白名单（运行时注册不可超出 manifest
  声明）。D1 裁「BUILTIN_SLOTS 退役，fail-closed 改由声明账本 +
  装载校验承担」——但声明账本是客户端 SlotCore 的**第一方 seat
  声明**；第三方 manifest `ui.slots` 声明的合法性由谁、依据什么校验
  未写明。
- 关键未裁点：**240 键树是否全量对第三方 manifest 开放？** 旧门 6
  开口 → 新门若默认全开是信任面的数量级扩张（overlay/高危替换型
  尤甚）；D8 收窄的是 bridge 的「转发面」，不是 manifest 的「声明
  校验面」。这也关系 slot-tree §5.10 安全边界不变式的延续。
- **修订方向**：D13 补一句裁决——第三方可声明集合 = 声明账本的
  显式公开子集（维持开口表语义，数据源从静态数组改为账本派生），
  高危替换单列门槛；S3 验收补「第三方声明未公开 id 被拒」用例。

### 4.3 【P2】runview（运行矩阵）域在 D19 形态下无物理落点

- §0.3 归属表有 runview 域（runs.ts → ctx.runs），ownership §3.3
  把运行矩阵标为「（宿主裁决 D4）」——它**没有后端行**（数据走
  api/runs RPC），D19「域 UI 落行包 client/」对它套不上。D19 预留
  的「若确需，为该域单开 client-only 行」恰为此场景，但计划全文
  未点名 runview；D12 拆解顺序与 S2/S3 迁移清单也都没有它。
- **修订方向**：一句话点名裁决（建议：S2 随域拆解 in-bundle，S3 走
  首个 client-only 行；或明确随 webui 常驻进基础集合），避免 S3
  迁移时悬空。backup/restart 等「并入 settings 基础集」条目依赖
  配对表语义可接受，runview 是唯一的独立域级缺口。

### 4.4 【P2】slot-tree §5 横切约定未挂靠到 owner props 契约

- slot 树 §5 的 11 条横切约定中至少 6 条是 owner props 契约的实质
  内容：**z-index 配额秩序**（插件弹窗禁自选高位）、**替换型必须
  继承移动端行为**（三面板共用左抽屉模式——替换型最大隐性成本）、
  **命令式通道保留**（ask()/open()/initialAgentId）、**启停两层
  分家不可绕开**（不得出现第四条启停路径）、四态回落、行点击导航
  宿主所有。
- 计划里 D2「owner props 类型化」与 S1.5「240 键声明集类型化」均未
  显式吸收这些约定；S1 手工冒烟只覆盖移动端抽屉一项。若 S1.5 类型
  化时不挂靠，这些不变式在 240 键契约中将**无处承载**，S2 逐域
  可摘除性验收也无从对照。
- **修订方向**：D2 或 S1.5 补一句「owner props 契约吸收 slot-tree
  §5 横切约定（z-index 配额 / 移动端行为继承 / 命令式通道 / 启停
  分家等随 seat 声明落地）」；S2 验收把「替换型继承移动端行为」
  「z-index 配额」列为逐域检查项。

### 4.5 【P3】杂项（措辞与精度）

| # | 问题 | 修订 |
|---|---|---|
| A | D13「旧 8 个 UISlotId 映射到新 slot id」与 D8「两项非视觉不走 slot」残留张力 | 改述：六项组件类映射新 slot id；ws-event / global-style 维持常设通道（manifest 声明照旧授权，不进 slot 注册表） |
| B | D3「动态注册者恒低优」在 S0/S1 朴素形态（无 priority/cell）下不可表达 | D3 落点补时序注记：S0/S1 期 root 防线 = 装载校验「非出厂注册一律拒绝」；「恒低优」语义随 S1.5 cell 选举生效 |
| C | §0.3「api-remotes」失名（§3-2） | 改为实名：「api/ 目录各远程模块 + core/api/client.ts」 |
| D | D16①「宿主默认可被排前/排后」在 S1.5 后对 single 型不再成立（有贡献时仅胜者渲染，宿主默认退为零贡献回落） | D16 补分型说明：同轴 order 合并持续适用于 list/chain；single 型 S1.5 后 = cell 选举 + 零贡献 fallback |

## 5. 框架纪律符合度复核

维持首评 §6 全绿判定；v2.1 的重排与增补（S1.5 门、D19 贯穿、D21）
未引入新违例。一处补强：§4.1 的缺裁本质是**契约归属 owning
package** 纪律在客户端的未完成部分——客户端服务的声明合并目标
（= 客户端契约归属点）与客户端服务命名查重，应随 S0 定案并纳入
checklist。

## 6. 修订建议汇总

| 优先级 | 修订 | 落点 |
|---|---|---|
| **P1** | 裁决客户端 Context 类型身份（建议独立 ClientContext / 独立 augmentation 目标）；客户端服务名与服务端占名查重入验收 | §4.1；S0 / D5 |
| P2 | 第三方可声明 slot 集 = 账本显式公开子集（高危替换单列门槛）+ 拒绝用例 | §4.2；D13 / S3 验收 |
| P2 | runview 域物理落点点名裁决（client-only 行 or 随 webui 常驻） | §4.3；D12 / S3 |
| P2 | owner props 契约挂靠 slot-tree §5 横切约定；S2 逐域验收补移动端继承 / z-index 检查项 | §4.4；D2 / S1.5 / S2 |
| P3 | D13 六项/两项分述；D3 恒低优时序注记；api-remotes 改名；D16 分型说明 | §4.5 |

## 7. 证据索引

- 计划与输入：`docs/m27-webui-slot-refactor-plan.md`（v2.1）、
  `webui-{slot-tree,plugin-ownership,koishi-console-research}.md`、
  首评 `m27-webui-slot-refactor-plan-review.md`
- 现状代码：`webui/src/{main.ts,App.vue}`、`stores/`（10 文件，字节
  数见 §3）、`api/`（13 远程模块 + wire.ts）、`core/api/client.ts`、
  `core/extensions/{slots,bridge,host,isolated}.ts`、
  `shims/@agentchat/protocol.ts`、`webui/package.json`
- 撞名证据：`src/ac-jobs/src/service.ts:183-188`（Context.jobs）、
  `src/ac-singles/src/service.ts:579-584`（Context.singles）——
  augmentation 目标均 '@agentchat/cordis'
- 宿主/构建：`ac-webui-extensions/src/service.ts:68`（BUILTIN_SLOTS）、
  `desktop/main.mjs`（DEFAULT_PORT=3830 / loadURL）、
  `scripts/check-deps.mjs`

# 装配管控文档（assembly-governance）

> 性质：域深设计——装配管控裁决（层权限、face 信任边界、安装审批、替换授权、熔断审计）。
> 读者：做插件安装链 / 行集权限门 / 第三方装载裁决的人；合成代数本身见 agent-assembly.md。
> 状态：现行 · cr-1004 2026-11-11 立档（批1 已落，见原状态行）——cr-1008 2026-11-11 批1 检阅经代码核实。权限、信任与管控裁决**独立于合成代数**：代数（`agent-assembly.md`）描述文档怎么合成，本文档决定**谁允许用什么词形、第三方代码的信任边界、审批与熔断**。原则：机制住代数，策略住本文；
> 代数不为任何一条管控裁决改形状。

## 一、层权限表（词形 × 层）

词形定义在 agent-assembly.md §四；各层可用子集在此裁决：

| 层 | 可用词形 | 不可用及裁决理由 |
|---|---|---|
| `<base>.patch.yml`（用户全局） | disabled / except / replace | 用户手写域独占换向权——替换实现是高授权动作，只信用户笔迹 |
| `installed.yml`（安装事实） | 登记（id/name/owner/disabled） | 行内容由包 manifest 声明，登记簿不自述行面 |
| `agent.patch.yml`（实例差量） | 加法 / disabled / config | **无 replace**——实例文档可由 preset/创建流代写，不得自我宣布换实现；**无 except**——豁免是否决权的一部分，与 disabled 同住用户层 |

## 二、第三方信任边界（face 门禁）

- **装载 = 授权动作**：第三方代码只进具备进程隔离边界的基座（现即 shell）；
- `<base>.yml` 求值器的适配分析（agent-assembly.md §三）是**机制**：任何
  face 键都能被分析；**门禁是策略**：
  - `node` face（shell 基座）：✅ 开放——壳进程隔离，装载经安装器人审/免审
    门禁（§三）；
  - `web` face（webui 基座）：✅ 开放——前端通道，浏览器内隔离；
- **face 可多声明，信任按 face 裁**：包同时声明多个 face（node + web）是
  事实陈述，schema 不禁——授权词表本就按 face 分轨（node 权限 / UI 席位），
  多面包 = 多份 face 级授权待审；未来若裁「高风险 face 组合需加审」也在此
  处登记，不让 schema 替管控做事；
  - **宿主 face（host 基座）：❌ fail-closed**——宿主是信任域（进程内、沙箱外），
    第三方宿主行不开放。位的分析能力存在（泛化免费带来），门关着；开放需
    专项裁决（信任模型大改，另立 CR）。

## 三、安装审批与登记纪律

- 安装器统一写 `installed.yml`（单写者）；**绕过安装器手写登记 = 反模式**
  （cr-908 裁决沿用）；
- 市场安装走 staging 人审（哈希/只读代理/权限快照——复用 ac-plugin-core 纯库）；
  人签安装 owner 锚留空（全体候选）；对话免审安装走门禁（engines 自求值/
  保留字护栏/权限边界）；
- owner 锚 = 准入 gating 的**机制**（求值期过滤，agent-assembly.md §三）；
  **谁被写进 owner 是策略**：创建流装给特定 Agent 时锚定该 Agent，公共能力
  安装留空。

## 四、替换授权（replace 词形裁决）

- replace 只住 `<base>.patch.yml`（用户手写域）——插件 manifest 不得自述
  替换（保留字护栏 F13/G1 挡同名，安装器 `findReservedConflict` 挡抢注）；
- 恒并基座席位**停用**拒绝生效（cr-1003 护栏——防「能 boot 缺收信面」的
  静默半激活）；席位**替换**放行（换实现不断席位）；
- 替换件 manifest 声明多行条目仅同 id 生效，其余警告忽略（捆绑替换随设置
  UI 批再裁）。

## 五、装载失败与熔断

- 壳侧装载失败：emit `plugin.load-failed` + 跳行（fail-closed 对插件——该行
  缺席即其工具面缺席，壳自身 boot 不被第三方插件拖死）；替换件装载失败同口径；
- 宿主侧熔断闸门：阈值 3 → 现算视图剔除该插件行 + 审计入账（`.load-health`
  持久；installed.yml 登记不动）；清熔断记录 = 人工急救面。

## 六、审计

- `agents/<id>/boot-graph.json`：派生终态快照（「这个 Agent 实际装了什么」——
  含替换换向后的 path），非承重面、写失败仅警告（cr-910 口径）；
- 安装/卸载/熔断走 plugins/audit.jsonl（plugin-registry 行 owning）。

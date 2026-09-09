# UI 行册与 Slot 树架构复审（M28 收口后）

> **状态：复审实录（M28 收口后时点；对拍基准 = `ui-rows-and-slots.md` 2026-11-08 快照）。**
> 审查方法：全量代码实勘，非文档复述——`slots.declare/register` 面 grep 逐条对拍、
> 26 行包跨包 import 网络（含深路径 `ac-client-ui-*/client/...`）、package.json
> 依赖声明比对、`scripts/check-deps.mjs` 源码审读、包体量实测（排除 tests/dist）。
> 结论先行：**席位/slot 机制层设计合理且高质量（席位归属纪律真达成）；问题集中在
> 行包间"数据面与视图面归属纪律"被执行期漂移侵蚀**——T4 依赖方向失守（base 行
> 静态依赖 domain 行，含一个未声明依赖）、check-deps 六规则对新架构全盲、
> settings 沦为外域数据面宿主、conversation 巨石实际体量超文档一倍。发现按
> F1-F5 分级（F1 最严重），均附行号级证据与复核命令（§六）。

---

## 一、总评

| 维度 | 判定 | 要点 |
|---|---|---|
| 席位归属纪律（"宿主退化为 slot 提供者"） | ✅ 真达成 | 16 席声明全部在 base 行，19 域行零声明全贡献（grep 实证） |
| 扩展机制（election/inject/封印/order 锚） | ✅ 与文档一致 | `slots.inject` 存活期效应、root 封印、选举席防叠加均落实 |
| 行粒度镜像后端域（T2） | ✅ | fs 三卡同行对 ac-fs-tools；web 双 def 对浏览器族；无机械拆分 |
| 跨域数据纪律（服务面 + inject + 三态静默） | ✅ 基本达成 | jobBoard/roster/sessions/singleBoard 全走 ClientContext 服务面 |
| **T4 依赖方向（base 不依赖 domain）** | ❌ **失守** | 四个 base 行静态 import domain 行模块，形成多个包级环（F1） |
| **依赖守卫有效性** | ❌ **全盲** | check-deps R1-R6 对 ac-client-ui-* 图一条都看不见（F1） |
| settings "纯壳"声明 | ❌ 名不副实 | 41KB api.ts 持有 ≥4 域数据面 + schema 引擎 + 组件 kit（F3） |
| 文档数据准确性 | ⚠️ 漂移 | conversation 实际 ~506KB（文档 ~240KB）；"双向可独立摘除"仅 boot graph 层成立 |
| conversation 内聚性 | ⚠️ 巨石未收敛 | 五簇职责；GroupDrawer（群域资产）疑似漏迁（F4） |

---

## 二、文档断言对拍（ui-rows-and-slots.md vs 代码）

| 文档断言 | 实勘结果 | 判定 |
|---|---|---|
| 16 席位：layout 9 / settings 3 / sidebar 1 / tool 1 / conversation 2，全在 base | grep `slots.declare(` 于 client/ 目录逐条吻合（layout/client/index.ts:49-128 九处、settings:41-63 三处、sidebar:44、tool:39、conversation:129/144） | ✅ |
| 26 前端行 = 基础七件 + 19 域行 | cordis.yml 行集与 ac-app TREE 吻合 | ✅ |
| 域行零声明、全贡献；摘域行只损失贡献叶 | 属实——但"物理摘包"会断 webui 构建（F1，boot graph 层摘除不受影响） | ⚠️ 半属实 |
| conversation ~240KB（§4 注 7） | **实测 ~506KB / 38 文件**（次重 plugin-registry 172KB） | ❌ 漂移 |
| settings = "设置面板纯壳：左树 + 保存编排 + 3 席声明" | api.ts 41KB/44 导出函数 + dataFaces 再导出层 + schema 引擎 + SettingField/ConfirmDialog 组件件，被 4 个域行消费 | ❌ |
| T7 裁决：composer 不拆，conversation 仍 ~240KB 巨石 | 裁决成立但体量数据翻倍，且 GroupDrawer/VIEWER_ID 等新漂移未入册 | ⚠️ |
| roster 由 ui-agents 提供、行间走 inject fiber 等待 | 属实（ui-group inject ['rpc','sessions','roster','slots']；feed-core/chat-core 经 useRosterCore 惰性取用口——M28 §4.2 深批①裁决形态） | ✅ |
| 工具卡行镜像表（M28 §2.2） | 逐卡吻合；tool 宿主零卡属实 | ✅ |

---

## 三、发现（按严重度排序）

### F1｜T4 依赖方向失守 + 守卫全盲（最严重）

T4 明文："**base 宿主不得 runtime 依赖 domain 行（phase 序）**"。实勘 base 行的
静态运行时依赖（深路径 import 域行 client 模块）：

| base 行 | 静态依赖的 domain 行 | 证据（生产代码，非测试） |
|---|---|---|
| conversation | **agents** / **group** / **workspace** / **skill** / jobs | DialogView.vue:14-15（rosterApi + groupApi）、ChatInput.vue:7/17（rosterApi + skillsApi）、GroupDrawer.vue:10（groupApi）、feed-core.ts:15-16 与 chat-core.ts:15-16（rosterAccess——裁决过的取用口形态）、fileApi.ts:9-14（workspace）、ConversationJobsChip.vue:25（jobs） |
| layout | **agents** | AppFrame.vue:24（rosterAccess）+ viewer.ts（conversation，base→base） |
| settings | **agents** / **plugin-registry** / **timer** / workspace | useSettings.ts:28（agents）、dataFaces.ts:8-19（agents）、AgentPane 消费链 |
| sidebar | **system** | Sidebar.vue:10（systemApi）——**有 M28 §5.1 显式裁决**（"版本入口动作跨行消费合法"） |

由此形成**包级环**（按真实模块图，.vue 边在 bundler 层同样是运行时边）：

```
conversation ⇄ agents     （feed-core.ts→rosterAccess.ts .ts 边；
                            AgentList.vue→chatStore.ts .vue 边）
conversation ⇄ group      （DialogView/GroupDrawer→groupApi.ts;
                            group→DialogView.vue + types/viewer）
settings ⇄ agents         （useSettings.ts→agents/client .ts 边;
                            AgentPane.vue→settings .vue 边）
agents → plugin-registry → settings → agents   （3 节点环:
                            AgentPane.vue→ExtToolsPane.vue;
                            ExtToolsPane.vue→settings/api.ts;
                            settings/api.ts 内 agent CRUD）
```

**守卫为什么没拦**（check-deps.mjs 源码审读）：

- `IMPORT_RE`（:34）只匹配 `@agentchat/*`——`ac-client-ui-*` 是**非域名包名，
  一条都匹配不上**，R1-R4 对整个 UI 行树失明；
- R5 环检测 `listFiles`（:67）只走 `src/` + `tests/`——**`client/` 目录不在扫描
  范围**；且 :193 明文 `.vue 不进包级环图`；
- R6 守卫的 `webui/src/clients` 目录**已随 M28 退役（目录不存在）**——规则守着
  空目录，属幽灵规则。

**具体伤害**：

1. "卸 UI 行 → 前端消费面消失"只在 **boot graph 层**（行停用，模块仍在
   virtual:row-clients 静态映射与 bundle 里）成立；**物理摘包即断 webui 构建**
   （unresolved import）。文档"双向可独立摘除"的表述强于现实。
2. phase 模型的隔离价值被掏空：base 先于 domain 封印装载，但 base 的模块图
   里已经拖着 domain 代码。
3. M28 §8 风险 2 预言过此场景（"跨包 .vue import 增多……若出现运行时环，回落
   保守形态"）并备了回退方案——但没有任何检测器能触发它，回退条件永不确定。

### F2｜未声明运行时依赖（本轨自己的红线）

`ac-client-ui-conversation` 的 `ChatInput.vue:17` import
`ac-client-ui-skill/client/skillsApi.ts`，但 conversation 的 package.json
dependencies **不含 `ac-client-ui-skill`**——靠 workspace hoisting 隐式生效。
README"兼容性红线"明文："运行时依赖必须在 package.json 显式声明——禁止靠
workspace hoisting 隐式生效"。R1 本应拦截，因 F1 的非域名盲区而漏网。
**一行修复**。

### F3｜settings 不是纯壳：外域数据面宿主 + agent 数据面双宿主

- `settings/client/api.ts`（41KB / 44 个导出函数）持有：
  **agents CRUD**（createAgent/deleteAgent/getAgentConfig/saveAgentConfig）、
  **timer**（getAgentTimers/saveAgentTimers）、**plugin 全套**（market/staging/
  approve/uninstall/patch 列表与写入）、**event policy**（get/setEventPolicy）、
  **llm/search pools**（savePoolDomain/probeLlm*）、assembly、全局配置——
  ≥4 个域的 RPC 数据面住在 settings（base），而它们的**视图已经迁去了各自的
  域行**。M28 P2 迁移只迁了视图没迁数据面，T3"数据面跟域走"半途。
- **agent 数据面双宿主**：`settings/api.ts`（createAgent/getAgentConfig…）与
  `agents/client/rosterApi.ts`（fetchAgents/deleteAgent/fetchSessionTokens…）
  并存——DialogView 从后者拿 deleteAgent、设置面板从前者保存。同域 RPC 面
  两个 owner。
- `settings/client/dataFaces.ts` 是 agents 自己函数的再导出中转（补 defaultRpc
  缺省）：agents 的组件经 settings 间接 import 自己的包——构成 .vue 媒介的
  agents⇄settings 环（见 F1）。
- schema.ts + SettingField/ConfirmDialog + types.ts 已成事实上的"设置 UI
  组件 kit"（agents/plugin-registry/timer/llm-pool 四域行消费）——这个角色
  本身合理，但与"纯壳"表述冲突，应在文档记裁决或拆 kit。

### F4｜conversation 巨石未收敛 + 域资产错放 + 身份常量散落

- **实测 ~506KB / 38 文件**（文档 ~240KB，落后一倍）。五簇职责：sessions
  服务核心（feed-core 79KB + chat-core 41KB + chatOps）、composer（ChatInput
  60KB + InputMention + mention）、DialogView 族（DialogView 68KB +
  PairDialogView 17KB + Message/*）、queue/interaction dock、杂项（historyApi/
  format/media/tokens）。T7 裁决 composer 不拆成立（拆出切断与 chatOps 的
  深耦合接线），但体量数据应如实入册。
- **GroupDrawer（群域视图：成员/改名/删除/记忆属主）住在 conversation**，而
  同域的 CreateGroupDialog 住 ui-group；且 conversation 的 DialogView 反向
  import group 的 groupApi——群 UI 知识双向劈开。M28 §5.1 迁移表**没有列
  GroupDrawer**，疑似漏迁而非裁决。
- **VIEWER_ID 以本地常量复制三处**（`conversation/client/viewer.ts`、
  `agents/client/index.ts:24`、`agents/client/rosterApi.ts:15`，均为
  `const VIEWER_ID = 'user'`）——M28 P1-4 注记自认"本地常量防
  conversation↔agents 包环"。身份基线为躲环而复制散落，本该住
  ac-client-runtime 单一出处。

### F5｜小项（记录在案，低优先级）

1. `webui/src/main.ts:33-34` 死导入 `layoutClientPlugin/settingsClientPlugin`
   ——boot graph 已负责装载 base 批次，两行 import 从未使用（装配注释 :63-67
   亦称"本步纯 boot graph 装载"）。建议删除。
2. uiStore 住 sidebar（base→base 合法）但被 10+ 包消费（layout/settings/
   usage/system/workspace/runview/conversation）——shell 级应用状态住在
   "活动栏"域，归属可议；如再动，候选 ac-client-runtime objects 层。
3. webui 兼容 shim 约 15 个 re-export 文件仍在（utils/ settings/
   composables/ types/ core/registry）——文档已承认的过渡债，消费面收敛后
   可除役。
4. `ui-rows-and-slots.md` §1 称产出物统一形态含 `tests/`，但 ui-skill/
   ui-jobs 等薄行无独立 tests 目录（覆盖走消费方测试族）——表述与实况的
   微小出入，随下次文档同步修正。

---

## 四、包依赖矩阵（实勘，生产代码运行时值边）

> 读法：行 → 列 = 该行包静态 import 列包的 client 模块。`〔环〕`标记参与
> 包级环的边。phase 来自各行 package.json `agentchat.client.phase`。

| 包（phase） | → 依赖（phase） | 备注 |
|---|---|---|
| conversation（base） | agents〔环〕· group〔环〕· workspace · **skill（未声明）** · jobs · renderer · sidebar · tool | 最重 base 行；rosterAccess 为裁决形态 |
| layout（base） | agents · conversation · renderer · theme · sidebar | AppFrame→rosterAccess |
| settings（base） | agents〔环〕· plugin-registry〔环〕· timer · workspace · conversation · sidebar | api.ts 外域数据面（F3） |
| sidebar（base） | **system**（有裁决） | 版本入口/备份动作 |
| theme / renderer / tool（base） | （零 domain 依赖） | 唯三干净 base 行 |
| agents（domain） | conversation〔环〕· plugin-registry〔环〕· settings〔环〕· sidebar · theme · timer · | 域行反向依赖最多者 |
| group（domain） | conversation〔环〕· agents | T6 视角形态 |
| singles（domain） | conversation · agents · sidebar · theme · workspace | |
| runview（domain） | conversation · agents · sidebar · jobs · theme | |
| usage（domain） | agents · theme · sidebar | |
| plugin-registry（domain） | settings〔环〕· workspace | 视图已随行、数据面留 settings |
| llm-pool / timer（domain） | settings | 同上 |
| fs / browser（domain） | renderer · workspace | 卡行干净 |
| system（domain） | renderer · sidebar | |
| workspace（domain） | sidebar · renderer | |
| todo / goal / shell / web / subagent / skill（domain） | renderer 或零 | 卡行干净 |

**结论**：domain→base 方向（T4 合法向）密集是预期；**base→domain 方向 4 行
失守 + 3 组包级环**是漂移主体。skill/todo/goal/shell/web/subagent/fs/browser/
workspace/system/usage/runview/singles 等域行自身的卡/面板粒度归属良好。

---

## 五、建议与优先级（尊重既有裁决，不推倒重来）

| # | 建议 | 优先级 | 说明 |
|---|---|---|---|
| 1 | **先修守卫再修代码**：check-deps 增 R7——扫描 `client/`、匹配非域名 `ac-*` 工作区包名、按 `agentchat.client.phase` 断言"base 不得运行时依赖 domain"；R1-R4 的 IMPORT_RE 扩到 ac-*；R6 幽灵规则除役或改守行包图 | **P0** | 杠杆最高：今天的漂移全是静默发生，无检测器则一切修复都会再犯。既有环先入白名单逐步消化 |
| 2 | conversation package.json 补 `ac-client-ui-skill` 声明 | **P0** | 一行修复，本轨红线（F2） |
| 3 | **数据面归域**（兑现 T3）：plugin RPC → ui-plugin-registry、agent CRUD 归并 agents（与 rosterApi 合一）、timer RPC → ui-timer、pool RPC → ui-llm-pool；settings 只留全局配置 + schema 引擎 + 壳；dataFaces 再导出层随迁除役 | **P1** | 顺带消 settings⇄agents 环与 agent 数据面双宿主（F3） |
| 4 | **GroupDrawer 迁 ui-group**：perspective props 已携带 group 上下文，抽屉组件随域走；conversation 内经 props 或席位消费 | **P1** | 消 conversation⇄group 环的群向半边（F4） |
| 5 | **VIEWER_ID 收敛 ac-client-runtime** 单一出处，三处副本改 import | **P1** | 消复制散落（F4）；同时为 #1 的环检测清障 |
| 6 | 剩余 base→domain 的 RPC 包装依赖（ChatInput→skillsApi、Sidebar→systemApi 等）二选一：升为客户端服务/objects 面，或将 T4 措辞改为显式接受"RPC 包装 = 契约词汇，不构成相位耦合"并记裁决 | **P2** | 诚实的例外好过无声的违规；sidebar→system 已有先例裁决可援引 |
| 7 | 文档同步：`ui-rows-and-slots.md` conversation 体量改 ~506KB、§3 增补本文 §四依赖矩阵、§1 形态表述修正；main.ts 死导入删除 | **P2** | 读侧汇总应反映真实耦合（F5） |

---

## 六、复核命令

```bash
# 声明/注册面（对拍 ui-rows-and-slots.md §2/§3）
grep -rn "slots.declare(" src/ac-client-ui-*/client
grep -rn "slots.register(" src/ac-client-ui-*/client

# 跨包深路径依赖网络（本复审主证据）
grep -rn "from 'ac-client-ui-[a-z-]+/" src/ac-client-ui-*/client src/webui/src

# 未声明依赖比对（F2）：package.json deps vs 实际 import
# 例：conversation 是否声明 skill
grep -n "ac-client-ui-skill" src/ac-client-ui-conversation/package.json

# VIEWER_ID 副本（F4）
grep -rn "const VIEWER_ID" src/ac-client-ui-*/

# base→domain 相位违例（建议 #1 落地后的守卫形态）
#   phase 源 = 各行 package.json agentchat.client.phase

# 守卫盲区自证（F1）：check-deps 对 ac-* 非域名包名零匹配
grep -n "IMPORT_RE" scripts/check-deps.mjs
```

---

## 七、复审边界与未覆盖项

- 本复审聚焦 M27/M28 产出的前端行树（26 行 + 基建三包 + webui 壳）；
  后端行（L1-L3、工具行、治理行）未在本轮重审——其契约归属纪律以
  README 契约归属总表为准，event-catalog 静测仍在位。
- 视觉基线/端到端行为未重跑（本复审为静态实勘）；建议 #3/#4 施工时按
  M28 §6 门禁模板全量过门（双 typecheck / 全量测试 / check-deps / 视觉门 /
  webui:build）。
- T7（composer 不拆）与 sidebar→system（动作跨行消费）为既有显式裁决，
  本复审不翻案，仅要求体量与耦合数据如实入册。

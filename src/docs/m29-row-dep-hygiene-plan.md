# M29 行包依赖纪律修复计划 — 守卫先行 + 数据面归域（复审 F1-F5 收编）

> **状态：已全部实施（M29 关闭）。** 来源 = `ui-rows-and-slots-review.md`
>（M28 收口后架构复审实录——行号级证据与复核命令均在彼，本文不重复举证）。
> 目标一句话：**先修守卫再修代码——把复审确认的依赖方向漂移（base→domain
> 四行失守 + 3 组包级环 + 守卫全盲）与数据面归属漂移（settings 外域数据面
> 宿主）分批消化，使「宿主退化为 slot 提供者」的终态在依赖图层面同样成立。**
> 尊重既有裁决（不翻案）：T7（composer 不拆）、sidebar→system（动作跨行
> 消费合法）、rosterAccess 惰性取用口形态（M28 §4.2 深批①裁决）。
>
> 实施摘要（收口对账）：P0-1 守卫 R6/R7 + AST 化落地（`scripts/check-deps.mjs`
> + `scripts/dep-cycles.yml` 白名单只减不增）；P0-2 存量清账 41 包声明修复；
> P1-1 VIEWER_ID 收敛 runtime；P1-2 GroupDrawer 迁 ui-group（group:drawer
> 席位）；P1-3 四域数据面归域（pluginApi/timerApi/poolApi 新面 + agent CRUD
> 单宿主 rosterApi + useAgentSettings 编辑编排归域——顺带修复 M28 P2.5 节
> 宿主静默回归）；P2-1 白名单六条全部定谳（「RPC 包装/纯工具词/惰性取用口
> = 契约词汇」判据入册）；P2-2 文档同步 + main.ts 死导入删除。§3 依赖矩阵
> 更新为消化后形态（ui-rows-and-slots.md §3.5）。

## 0. 开工第一步：确认基线绿 + 漂移快照锚定

```bash
pnpm typecheck && pnpm webui:typecheck
pnpm test                                 # 1597（boot 族偶发负载 flake，红则隔离复跑）
node scripts/check-deps.mjs               # R1-R6（现状绿——但对 UI 行图失明，本批改造对象）
AGENTCHAT_VISUAL=1 pnpm vitest run src/webui/tests/visual-snapshot.test.ts
# 漂移证据基线（复审 §六命令重跑，结果应与复审一致）：
grep -rn "from 'ac-client-ui-[a-z-]*/" src/ac-client-ui-*/client src/webui/src
```

## 1. 工作件清单（依赖序：P0 守卫 → P1 环消化 → P2 裁决与同步）

### P0-1 守卫改造：check-deps 增 R7，R1/R4/R6 修盲（杠杆最高）

**范围**（`scripts/check-deps.mjs`）：
1. `IMPORT_RE`（:34）扩到非域名工作区包 `ac-*`（R1 未声明 / R4 无用声明
   即刻对 26 行生效——先跑一遍盘点存量，属 P0-2 同批修）；
2. 扫描范围补 `client/` 目录（R5 环检测 `listFiles` :67 现只走 `src/` +
   `tests/`）；
3. **新增 R7（相位与行图守卫）**：按各行 `package.json → agentchat.client.phase`
   建相位表，断言 **base 行不得静态运行时依赖 domain 行**（.ts 与 .vue
   边同权重——bundler 层 .vue 互引同样是运行时边，复审 F1 实证）；输出
   违例清单（包 → 包 → 证据行）；
4. **环白名单**：既有 3 组环（conversation⇄agents / conversation⇄group /
   settings⇄agents / agents→plugin-registry→settings 三节点环）以显式
   白名单文件入册（`scripts/dep-cycles.yml` 或 check-deps 内嵌表），
   **白名单只减不增**——P1 各件每消化一环即删对应条目，清零即除役白名单
   机制本身；
5. R6 幽灵规则处置：所守 `webui/src/clients` 目录已随 M28 退役——改为
   守「行包图：domain→domain 跨域 .ts 边需显式裁决注记」或直接除役
   （开工裁定点，倾向改守——R6 语义在行包图上仍有效）。

**验收**：R7 落地首跑 = 复审 §四矩阵逐边复现（白名单内条目不算红）；
人为删一条合法边测红；`grep -n IMPORT_RE scripts/check-deps.mjs` 自证
盲区消除。**独立提交。**

### P0-2 未声明依赖补齐（本轨红线，一行）

`ac-client-ui-conversation/package.json` dependencies 补
`"ac-client-ui-skill": "workspace:*"`（ChatInput.vue:17 消费
`ac-client-ui-skill/client/skillsApi.ts` 靠 hoisting 隐式生效——复审 F2）。
随 P0-1 同批提交（守卫开眼后的第一笔存量修复）。

### P1-1 VIEWER_ID 收敛 ac-client-runtime 单一出处

- 现状三副本：`conversation/client/viewer.ts`（`ref('user')` 形态）、
  `agents/client/index.ts:24` 与 `agents/client/rosterApi.ts:15`（裸字符串
  `const VIEWER_ID = 'user'`）。
- 落点：`ac-client-runtime` 导出 **ref 形态**单源（对齐最大消费面
  conversation 的 `VIEWER_ID.value` 旧形）；agents 两处改 import，同步
  用点（`toAgentList` 的 viewer 比较、rosterApi 的 pairKey 合成）补
  `.value`（机械）。
- 收益：身份基线单源 + 为 R7 环检测清障（conversation→agents 的
  rosterAccess 边之外不再有身份类借口边）。

### P1-2 GroupDrawer 迁 ui-group（消 conversation⇄group 环的群向半边）

- 迁移：`conversation/client/GroupDrawer.vue` → `ac-client-ui-group/client/`
  （群域视图：成员/改名/删除/记忆属主——与 CreateGroupDialog 同域归位）。
- **形态裁定点**（二选一，开工定）：
  a. **props 注入**：group 视角包装组件（ui-group 的 perspective def
     携 group 上下文）自带抽屉，经 props/events 与 DialogView 骨架协作
     ——抽屉渲染时机（showDrawer）由包装层持有；
  b. **席位消费**：DialogView 群视图抽屉区开 `group:drawer` 之类小席，
     ui-group 贡献抽屉组件（零 props 依赖，状态自理）。
  倾向 b（与本树「宿主开席、域行贡献」总形态一致；a 备选防视觉回归）。
- 配套：DialogView 残余群域知识（`deleteGroup` import 群删除编排）随迁
  ——删除动作经 ui-group 包装层或抽屉组件 emit 收口，conversation 零
  groupApi import。
- 验收：`grep -rn "ac-client-ui-group" src/ac-client-ui-conversation` 零
  命中；视觉门零 diff（DOM/CSS 不动，仅模块归属搬迁）。

### P1-3 settings 数据面归域（兑现 T3——最大件，消 settings⇄agents 环）

`settings/client/api.ts`（41KB / 44 函数）分域拆迁：

| 数据面 | 归宿 | 消费方换源 |
|---|---|---|
| plugin 全套（market/staging/approve/uninstall/patch 读写） | `ui-plugin-registry/client/pluginApi.ts`（新面，rpc 必传） | PluginLibraryPane/StagingReviewModal/ExtToolsPane |
| agent CRUD（createAgent/deleteAgent/getAgentConfig/saveAgentConfig） | 归并 `ui-agents/client`（与 rosterApi 同宿——agent 数据面双宿主收口） | AgentPane/AgentSettingsHost/DialogView（deleteAgent 已用 rosterApi 版） |
| timer（getAgentTimers/saveAgentTimers） | `ui-timer/client/timerApi.ts` | TimerPane/GlobalTimerHost/AgentPane 定时段 |
| llm/search pool（savePoolDomain/probeLlm*） | `ui-llm-pool/client/poolApi.ts` | PoolManager 双节 |
| event policy（get/setEventPolicy） | **开工裁定点**：留 settings（全局治理配置，与全局默认层同性质）或随 plugin-registry——倾向留 settings 记裁决 | 治理页 |
| 全局配置 + assembly + schema 引擎 + 保存编排 + 壳 | **留 settings**（这才是「纯壳 + 全局面」的本职） | 不动 |

- `settings/client/dataFaces.ts` 再导出层（agents 自己函数的 defaultRpc
  中转）随迁除役——agents 组件直连本包函数 + rpc seam（`useClientContext()
  ?.rpc ?? null` + 早退守卫，M27.2 先例形态）。
- 验收：settings 对 agents/plugin-registry/timer/llm-pool 的 import 清零
  （R7 白名单对应条目删除）；agent CRUD 单宿主；各域行测试族随迁
  （vi.mock 键换源——M27.2 实录坑）。
- **切分**：四域各自独立提交（plugin → agent → timer → pool），每步
  过全门禁。

### P2-1 剩余 base→domain RPC 包装依赖：显式裁决（诚实的例外好过无声违规）

守卫消化后仍存的 base→domain 边逐条裁决（R7 白名单余量）：

| 边 | 处置候选 |
|---|---|
| conversation→skill（ChatInput skillsApi） | 升客户端服务/objects 面，或记「RPC 包装 = 契约词汇」裁决 |
| sidebar→system（systemApi） | **已有先例裁决**（版本入口动作跨行消费合法）——直接入册 |
| conversation→workspace（fileApi 上传登记） | 同上二选一 |
| conversation→jobs（ConversationJobsChip） | 组件反向（jobs 域 chip 经席位贡献到 chat:header-actions 类席）或入册 |
| agents 组件→conversation（chatStore 等 .vue 边） | 评估经 clientRuntime 服务面取用替代 pinia 门面 import |

裁决产出 = R7 白名单条目逐边附裁决号，或消边。**不追求零边——追求
每条边可辩护、可检测、有期限。**

### P2-2 文档同步 + 死代码清理

- `main.ts:33-34` 死导入（layoutClientPlugin/settingsClientPlugin）删除；
- `ui-rows-and-slots.md` 修正：conversation 体量 ~506KB（client 面）、
  §3 增补复审 §四依赖矩阵（或链接互引）、§1「统一形态含 tests/」表述
  修正（ui-skill/ui-jobs 等薄行无独立 tests）、「双向可独立摘除」加
 限定语（boot graph 层成立；物理摘包需先清 R7 边）；
- webui 兼容 shim ~15 个 re-export 文件：消费面盘点，可除役者除役
  （过渡债收敛，非本批必达项）。

## 2. 提交序与门禁

```
P0-1 守卫改造（R7 + 盲区修复 + 白名单入册）     ← 独立提交，此后每步都过 R7
P0-2 skill 声明补齐                             ← 同批小提交
P1-1 VIEWER_ID 收敛 runtime
P1-2 GroupDrawer 迁 ui-group（含群删除编排收口）  ← 消环 ①，删白名单条目
P1-3 数据面归域 ×4 独立提交                      ← 消环 ②③，删白名单条目
P2-1 余量裁决入册
P2-2 文档同步 + 死代码
```

每步全门禁：双 typecheck / 全量测试 / check-deps（含新 R7）/ 视觉门
（数据面迁移零 DOM 变化应零 diff；P1-2 抽屉搬迁同理）/ webui:build。
收口验收 = 复审 §六复核命令全量重跑：R7 白名单清零或仅剩带裁决号条目、
`grep -rn "const VIEWER_ID"` 单源、settings 外域 import 清零、
conversation→group 清零。

## 3. 坑预告（M27/M28 实录沿用 + 本批预判）

- **vi.mock 键随迁移换源**：数据面拆迁时 grep `vi.mock('../src/…')`
  对照迁移清单（M27.2 实录 13 处先例）；动态 import 带 `.ts` 后缀
  grep 双态扫（M28 实录）。
- **CRLF/LF 混布**：PS 批量替换按文件探测行尾；JSON 一律 edit 工具；
  生成文件一律 write 工具。
- **VIEWER_ID ref 化**：agents 同步用点补 `.value` 时注意
  `toAgentList` 内 `parts.includes(viewer)` 类比较——ref 嵌套解包不
  生效于裸比较，逐处过一遍。
- **R7 首跑存量红**：白名单先入册再施工——守卫落地日 = 全绿日，此后
  「白名单只减不增」是硬纪律（CI 红 = 新增违例或白名单被手改）。
- **数据面迁移的 rpc 缺省语义**：settings dataFaces 的 defaultRpc
  缺省形态迁域行后改「rpc 必传 + 组件 seam」——参照 M28 §4.2 api
  退役同款（勿再复制一层缺省包装）。
- **视觉门**：P1-2/P1-3 均为模块归属搬迁，DOM 不动即零 diff；若 P1-2
  选席位案（b），抽屉挂载点变更需逐像素对照（景 04 会话主区）。

## 4. 与复审报告的对账关系

| 复审发现 | 本计划落点 |
|---|---|
| F1 T4 失守 + 守卫全盲 | P0-1（守卫）+ P1-1/2/3 + P2-1（消化） |
| F2 skill 未声明 | P0-2 |
| F3 settings 外域数据面 | P1-3 |
| F4 GroupDrawer 漏迁 / VIEWER_ID 散落 / 体量失册 | P1-2 / P1-1 / P2-2 |
| F5 四小项 | P2-2（死导入/表述修正）；uiStore 归属与 shim 收敛记为观察项（本批不动，触发条件 = 再动 shell 级状态时升 ac-client-runtime objects 层） |

——完成后：`ui-rows-and-slots.md` §3 依赖矩阵更新为消化后形态，复审
报告 §五建议表逐行销号，M29 关闭。

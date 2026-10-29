# ui 树 · 前端装配模型定调（2026-10-16）

> 性质：**ui 树现行设计规格**（cr-478 立项；cr-690~701 四批落地），只陈述终态；推演过程与批次住裁决簿。被 `apps/ui/client/boot.ts` 引用为装配序列依据。
> 本篇是 webui 大讨论（cr-474 → cr-478）的收束：给 webui 立规范、
> 给用户开自由。依据：host-shell-row-manifest.md（R1/R7-9）+ 母档案 R-2；preview 轨已于 cr-703 归档，通道实施依据 = `../cutover/design-plugin-client-channel.md`。

# 1. ui 树 = 第三棵装配树

webui 表面拆两个身份：**user 壳**（后端半边——R-2 已裁的宿主内极薄 user 端点桩，
固定件，无 boot 子树语义）+ **渲染壳**（前端半边——本篇主题）。渲染壳的装配模型
与宿主树 / 壳树同构，命名为 **ui 树**：

| 装配要素 | 宿主树 | 壳树 | ui 树 |
|---|---|---|---|
| 行集清单 | cordis.yml | AgentConfig 派生（argv 引用） | boot graph |
| boot 编排 | ac-app | 壳 boot 骨架（R3.2） | main.ts 装配序列 |
| 动态注入 | plugin 行 install | 壳行集条目注入 | manifest.ui → 通道注入 |
| 摘行降级 | 行卸载重载 | 摘行=摘能力域 | 域模块卸载=卡片回落 |
| 版本切换 | yml 改行（热插拔） | 派生清单变（重启壳） | boot graph 变（热装载） |

三处显式异构，不强行统一：**信任**（浏览器在信任边界外，隔离=浏览器沙箱+席位
声明校验，不进 guardian 体系）；**生命周期**（开标签页=全新 boot，多标签=多实例
并发，无锁无 idle-exit）；**写权**（零写权——只读投影+经 RPC 的编辑面）。

# 2. 骨架 = 协议持有者（判据）

**骨架 = 表面协议的持有者；模块 = 协议的消费者；变体 = 协议的可替换实现。**
凡件内含「具体呈现策略」（布局编排 / 语法色板 / feed 结构），即模块资产混入。
M27.2「基础七件」解构为 3 件骨架 + 4 份模块资产：

| 件 | 拆解 | 终态 |
|---|---|---|
| layout | 拓扑契约（root/seat/视角注册表解析）+ 形态壳（AppFrame/ResizeHandle/桌面编排） | **骨架**：拓扑契约常量化；形态壳 = 变体层（desktop/mobile/…——同一拓扑契约的实现策略，须完整实现契约，砍视角=改契约非改壳） |
| theme | 状态机 + html class 通道 | **骨架**：令牌词汇契约（token 名词汇住 webui-kit + 极性归属 + 完备性规则——主题须全量覆盖词汇，缺项回落缺省）；选择轴预留 data-theme id 升格，多主题=加数据非改结构 |
| renderer | SlotOutlet 协议 + install 机制 + ScrollableViewport 通用容器 | **骨架**：席位渲染协议持有者 |
| conversation | feed-core + chat-core + ConversationView / TranscriptList 内核族（体量按 `packages/ac-client-ui-conversation` 重测） | **模块**：挂 layout 会话视角的模块实例；可被第三方面板替换（同视角席位竞争） |
| tool | tool-card 通用渲染 + 回落兜底 | **模块**：独立通道 `apps/ui/channel/tool`（声明 `tool-card:result-view` 席 + 解析面），**不随** conversation 装载 |
| settings | 面板壳+左树+保存编排 | **模块** |
| renderer 内 markdown 管线 | useMarkdown 606 行 + hljs + KaTeX + 内联语法色板 | **模块**（markdown-render，新划分）：消息内容渲染策略；conversation 是消费者非独占者；语法色板接 theme 词汇契约；第三方可做自己的内容渲染管线（现态：已建通道 `apps/ui/channel/markdown-render`，资产仍 re-export renderer，物理迁移待做） |

# 3. 模块形态：一份 manifest，三树投影

判定不按「有无后端」（意外属性），按**是否功能模块**（自有目的、自有生命周期、
可整体摘除不毁表面）：

| 模块形态 | 后端半边 | 前端半边 | 例 |
|---|---|---|---|
| 全栈模块 | 宿主树行或壳树行 | ui 树条目 | files / todo / goal |
| 纯前端模块 | 无 | ui 树条目 | onboarding / run-nodes / search-pool / markdown-render |
| 纯后端模块 | 宿主/壳树行 | 无 | post-office / ledger |

`manifest.json` 数据声明（name / version / entry / platform / isolated / seats / channelImports / styles / theme）→ `assembleBootGraph` 扫 `<dataRoot>/plugins/`（plugin-registry 不参与注入）→ boot
graph → 资产静态服务（`/ui-plugin/<name>/*`，已建成）→ 浏览器动态装载。第一方与
第三方同走唯一通道，零特权路径（cr-474 已裁）。**主题包 = 纯数据模块**，通道上
最简形态（token CSS + meta），自定义第一级台阶（换肤开放市场）。存量 25 域桩行
按此收敛（批次随 R7-9 设计档案）；宿主树 ui 组终态清空。**✅ 已兑现（cr-701：catalog 撤 25 ui 域行，86→61 / host 48→23；装载面恒在 webui 行的 manifest 通道）。**

# 4. 物理形态：单应用表面（「单包表面」裁决已被另案取代）

**原裁决（cr-476，保留原文）**：**ac-webui = webui 表面唯一实体**（cr-476）：src/ 服务半边（boot graph 下发 +
扩展清单 + 静态服务 + 传输路由——表面事务，永不增业务端点）+ client/ 前端半边
（main.ts + runtime + isolated-runtime + 骨架 3 件 + slotCatalog）。src/webui/ 消融、
ac-webui-extensions 消融、骨架六包随解构归位（骨架资产入包，模块资产出包）。
webui-kit / ac-client-runtime / ac-client-slots 不属表面（全模块共享基座）。三树对称
彻底化：**ac-webui 之于 ui 树 = ac-app 之于宿主树 = boot 骨架之于壳树**——每树
一个固定本体 + N 个模块投影。包是常量，内容是变量。

> **修订注记（2026-10-27 复核；cr-696 / cr-701 / cr-703 单轨布局之后）**：表面本体已落为 `apps/ui`（包名 `ac-ui-app`）——`src/` 服务半边（`webui-row.ts` / `isolated.ts` / `isolated-runtime.ts`）+ `client/` 前端半边（`boot.ts` / `main.ts` / `rpc-host` / `rpc-wire` / `shared-modules` + 骨架 3 件 in-bundle）+ `channel/`（29 通道）+ `themes/`；`src/webui/` 随 cr-703 消灭、`ac-webui-extensions` 转纯库（未消融）、骨架为 **3** 件（非六包）、模块资产走 29 通道。`ac-webui` 行仍存且**不在 row-catalog**、现役装配不引用——职责收窄 / 待并（见下方疑点）。三树对称改写为：**`apps/ui`（ac-ui-app）之于 ui 树 = `apps/host` 之于宿主树 = `apps/shell` 之于壳树**。

> ⚠️ 疑点（2026-10-27 审查）：`packages/ac-webui` 仍带 `agentchat.plugin: true` 却无人装配、且不在 row-catalog；row-catalog 的 `webui` 行 path 指向 `apps/ui`。是「文档旧、代码已另案」还是「cr-476 单包化未收口」，本文不预判。见 Note 归档根 docs-review-2026-10-27/findings-C-ui.md

# 5. 自定义阶梯与版本切换

第三方自由度四级：① 令牌/主题包（纯数据）② 席位贡献（tool-card/dock/settings
节——现行域行主车道）③ 挂拓扑（新席位/视角）+ 换壳（形态壳/主题/内容渲染管线
替换——「完全自定义」达标线）④ 独立面板/整页。③ 的两半（挂拓扑与换壳）是
R7-9 设计的核心开放点。**现态（2026-10-27 复核）：视角挂载 = `registerView`（cr-694）+ manifest `seats[].view`；主题包 = cr-693；形态壳替换 = 明确不做（v2）。**

v1/v2 共存切换：物理共存（两包或两版本条目）+ 三平面切换语义——宿主树行改
yml（cordis 热插拔，不重启）；ui 树改 manifest/boot graph（热装载，触整页的仅
骨架级变更）；壳树改派生清单（重启壳，S5）。本机偏好走 cordis.patch.yml。

# 6. 工作区语境（第三输入源）

Agent 输入源三层：AgentConfig（per-agent，进指纹）/ conv-settings（per-conversation
运行时门）/ **工作区语境（per-conversation 运行时发现）**。单例锁（R-1）+ run 串行
per-conversation ⇒ 同壳并行两会话各挂不同工作区是合法态 ⇒ **工作区能力恒
per-conversation，永不进 agent 指纹**。两形态同根天然成立（约定文件是物理事实）。

- skill 组：现状双根发现（agentWorkdir + 工作区技能组）已是正确形态，保持。
- mcp：扩源——会话挂载工作区 .mcp.json 运行时并入；装载 lazy + conv-settings
  会话门过滤（注册面细节 ◐ 动工时钉）。
- 工作区登记 = 能力语境目录登记（auth-registry 存指针清单+授权元数据；能力载体
  是物理目录本身，不注册不复制）；挂载关系 = 会话元数据，落会话账本 header。
- 其他候选（AGENTS.md / 工作区 persona / env）◐ 不定向，动工时按需，最小集 skill+mcp。

# 7. workspace 行七面核查（R7-5 收口）

ac-workspace 解散成立，七面去向（①②④⑦为 cr-449 前已裁面的细化，③⑤⑥为本批）：

> **未实施（2026-10-27 复核）**：`packages/ac-workspace` 仍在役且不在 row-catalog；全仓无 `ac-files` 包。本节为历史计划，勿当现状读。

| 面 | 内容 | 去向 |
|---|---|---|
| ① 初始化/引导 | root 布局、默认 user/admin、首启消息 | boot 编排（宿主启动一次性） |
| ② 沙箱推导 | agentWorkdir / sandboxWorkdir / allowedPaths / conversationWorkspaceRoot | **纯库化**：推导函数入 ac-sandbox-core（输入=AgentConfig+settings+会话 header 挂载+登记清单，全程数据根直读，两侧共用） |
| ③ 文件面 | tree / readFile / resolveFile / saveUpload | **ac-files 模块后端半**（→ 宿主树行） |
| ④ 登记数据 | workspaces.json CRUD | auth-registry（指针+授权元数据；能力语境目录） |
| ⑤ 本机交互 | browse/open/pickFolder + native-* 纯模块 | **ac-files 模块后端半**（编排；native 模块原样随迁） |
| ⑥ 类型杂项 | Registration / guessContentType | 随各去向 |
| ⑦ 能力语境发现 | 约定文件（skills/、.mcp.json）读取 | 壳行运行时读面（skill 行保持 + mcp 行扩源 + conv-settings 门），不立行 |

ac-files = 「文件与工作区」功能模块包（src/ 后端半 + client/ 前端半：工作区树面板/
文件预览/上传/登记卡片——原 ac-client-ui-workspace 资产）。插槽-插头验收：摘
ac-files = 面板消失 + 附件上传降级（composer 按钮失效，纯文本聊天照常）。

## 本档案纪律

- 档案纪律：设计规格住 `docs/design/`（`explore/` 已不存在）；实施批次住裁决簿 `docs/design/host-shell-decisions.md`。
- 引用规则：母档案依据写 R-n / D-n / S-n；本簿条目按篇名引用；待钉项写 ◐。
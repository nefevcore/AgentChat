# WebUI Port B 收口后人工回归问题清单（下个 session 开工）

> 2026-08-23 用户浏览器人工回归发现 7 项问题（契约换血收口后首次全页面
> 过一遍）。本文件是开工文档：现象 / 初步定位（标注【实证】= 本 session
> 工具结果可证 /【假设】= 待验证）/ 修复方向 / 验收标准。
> 背景：UI 已直连 preview 协议（适配器退役）；数据为 `preview/data/`
> 迁移真数据（15 Agent / 23 会话 / 1 群 / 3 singles）。
> 复现：`pnpm preview:boot` → http://127.0.0.1:3830/ （构建产物已最新）。

## 修复状态（2026-08-23 同日收口，7/7 ✅）

| # | 根因（实证） | 修复 | 验证 |
|---|---|---|---|
| P1 | migrate-workspace 未迁 config 域；池表单依赖已退役的 schema 面 | 迁移脚本增 §0 config 域增量合并（marker 前执行、幂等；池逐条目 / llm·tool.web_search 指针缺省才写 / timer.tasks 补 id·mode·target 双形状兼容）；PoolManager 无 schema 时字段直联合成（基线字段 ∪ 既有条目观测键） | verify-settings：config/get 5 键、池 4+2、全局 timer/entries 5 条 |
| P2 | 数据本在（tools/list 31）——ExtToolsPane 默认落位空"插件"分区（行组合制下恒空），观感整页空 | 落位改"首个非空分区"（用户手选后不再自动跳）+ 空态文案指路 | tools 分区 31 项（含 requires 徽章） |
| P3 | SessionRecord 对话级五字段，无 reasoning/source | ac-session：assistant 落账带 reasoning_content（run 各步 reasoning 拼接）；router/* 事件目录增 sender 参数，sender='event' 落 role:'event'+source（LLM 回放按 user 喂回）；UI toHistoryMessages 透传（event 行→分隔符、assistant→thinking） | portb-e2e 新断言：reasoning 落盘回放 + event 行持久化 + UI 透传 |
| P4 | toAgentList 不合成 lastActivity/lastMessage | ac-session 增 tail()（尾部一条摘要）；runs/snapshot conversations[] 附 last；roster fetchAgents 三 RPC 聚合（1v1 会话键=agentId）、fetchGroups 聚合群 lastActivity；snapshot 失败静默降级 | portb-e2e + 真数据：23/23 会话带摘要，名册按活动倒序带消息预览 |
| P5 | systemPromptPreview 干跑后回读本地旧 `request` 对象——组装器（persona/system-prompt）以"替换 call.request"变异载体，本地别名恒旧 | 回读改载体 `call.request.system`（契约本义：waterfall 返回后读载体）；测试假组装器改同款替换姿势钉回归 | 真数据 15 Agent 预览全含 framework/系统环境/指引块（~1100 字） |
| P6 | AgentConfig 无 tags 字段（迁移丢弃） | ac-agents 契约 + admin 白名单/形状校验 + roster·settings 双视图透传与写回 + 迁移 §0b 增量回填（缺 tags 才补） | 真数据 15 Agent tags 与 src 一致（含 admin/dev/conductor 徽章） |
| P7 弦图 | includeUserSelf 默认 false 过滤掉全部 user↔agent 弦；且 by_agent 无 user 节点，弦端会错挂"其他"兜底索引 | 默认 true + renderCloud 合成 user 伪节点（弧段配额按矩阵行和重算，伪节点 tokens 仅用于分组） | 弦图渲染 user↔agent 弦（可开关） |
| P7 矩阵 | toRunsSnapshot 恒挂全零 windows 对象 → hasWindows 误判"有窗口数据" → range 停 d7 全取 0 → 格子全透明 | windows 改可选且不携带 → UI 检测缺失自动回退「全部」+ messageCount 色阶（诚实降级） | 矩阵 14 格 + 群对角格按消息量着色 |
| 附 | verify-* 脚本复用 v-1..N requestId，30s dedup 窗内重跑被 ws-bridge 静默 deduped（ack 无 result → 超时） | 全部脚本 requestId 加进程唯一 nonce | 连跑 3×verify-runs 全过 |

## 后续回归 #8（2026-08-23 同日）：模型管理无法填写 API Key ✅

**现象**：设置 → 模型管理，编辑/新建条目没有 API Key 输入框（P1 修复的
字段直连清单漏了 api_key）；且即使能填也没用——**三层断线**：

1. UI：BASE_FIELDS 无 api_key 字段。
2. 后端 config 面：config/save 不提取 key（填了会明文进 config.json，
   或被掩码 sanitize 丢弃）；config/get 不回填掩码（无"已设置"指示）。
3. 运行时：凭据库无人消费——LLM 调用链（ac-llm → 适配器行）只读
   行配置/env，`agents/set-credential` 存的 Agent 级 key 同样闲置
   （名册里迁移 Agent 跑真模型报 401 的根因）。

**修复**（对齐 src /api/config 的提取/回填语义 + preview 事件化形态）：

- **纯库** `ac-openai-completions`：`params.api_key` 单次覆盖构造
  key；序列化请求体前剥离（传输层键永不进 body）。
- **契约** `ac-llm`：`LlmChatInput.api_key?` 透传键（JSDoc 注明
  provider 剥离语义）。
- **凭据行** `ac-credentials`：apply 订阅 `llm/before-chat`，解析链
  注入——`input.api_key`（显式不动）→ Agent 级 `pool:<model>` →
  Agent 级 provider → 全局 `pool:<model>`（模型管理池条目 key）→
  全局 provider → 不注入（行配置/env 兜底）。resolveLlmApiKey 纯函数
  导出（测试友好）；服务访问走 `ctx.get`（M12 铁律 #2）。
- **config 面** `ac-web-api`：config/set·save 提取池条目 api_key 进
  `ctx.credentials.setGlobal('pool:<名>'/'searchpool:<名>')`（掩码=不动、
  空串=删、新值=存），config.json 永不落 key；config/get 回填掩码
  （'••••••••'=已设置 / ''=未设置）。inject 增 'credentials'。
- **UI** `PoolManager`：字段直连两类均加 api_key（password 敏感字段，
  说明文案注明三态语义）；空值清理例外保留 api_key=''（删除语义须
  到达后端）。

**验证**：completions（per-call 覆盖/不进 body）+ credentials（解析链
五级 + before-chat 注入/放行）+ web-api（提取三态 + 掩码回填 + 盘上
无 key）+ portb-e2e 新 it（UI 写口 → 凭据库 → router.send 真链路 →
provider 收到注入 key → 删除后不注入）——preview 全量 630 测试 +
vue-tsc + build + smoke 全绿；真后端 config/get 已回填全部池条目
api_key 字段。

## 后续回归 #9-#11（2026-08-23 晚）：singles 会话分夹 / 用量缺端点对 / 矩阵双 user 与范围按钮 ✅

**#9 独立会话集中分夹**：singles 消息流原与 1v1/群会话混在
`sessions/<sid>/` 顶层。修复 = ac-session 新增**上架（shelving）**机制：
`setShelf(convId, shelf)` 把会话目录归入 `sessions/<shelf>/<convId>/`
（寻址仍是 conversationId——叶子目录名不变，规约 2 不破；索引持久化
`.shelves.json` + shelf 根 `.shelf` 标记防误列；Windows 目录 rename
EPERM 有 copy+remove 兜底；幂等以"目录真在架上"为准，索引失准自愈）。
ac-singles 侧：首次触及（list/create/update）触发 `syncShelves()`——
按 `singles/<workspaceId|ungrouped>/<sid>/` 归位（老数据启动自迁移），
create 即上架、换组即换架。真数据：8 个 singles（含归档）全部分桶
（3 工作区桶 + ungrouped），顶层只剩 1v1/群会话。

**#10 用量缺 (agent,agent)/(agent,group) 端点对**：设计缺陷实证——
`send_agent → deliver` 不传 conversationId → 委托 run 记成
`{agent: 目标, conversationId: 目标}`，与 user⇄agent 同形，**委托方
凭空消失**。修复三层：
- `send_agent` 传**委托对会话键** `[from,to].sort().join('~')`（双向
  同桶，src agent-pair 语义）+ 历史播种（`session.history(pairKey)`，
  委托会话跨 run 连续）。
- `ac-usage` 新增 `byPair()`：行级 (agent, conversationId) 交叉留存，
  查询时分类——conv=agent → (user,agent)；conv='a~b' → (a,b)；
  迁移行 conv=对方 agent（名册判别）→ (agent,counterpart)；群 gid/
  singles sid 不进（弦图是 Agent 间视图）。`usage/tokens` RPC 附带。
- UI `toUsageSummary` 优先消费后端 byPair（agent⇄agent 弦自此可现）；
  旧后端 fallback 推导同步收紧（未知名/对键不误挂）。

**#11 矩阵双 user + 范围按钮不可选**：
- 双 user：`toRunsSnapshot` 无条件合成 `user` 占位成员，而名册已含
  workspace 注册的 user（显示名"风栗"）→ 同 id 两行。修复 = 名册含
  user 则直接用（显示名如实），否则才合成占位。
- 范围按钮：P7 修复去掉伪造 windows 后 `hasWindows=false` → 按钮禁用。
  本次补**真数据**：`ac-session.stats()` 按记录时间戳统计 h1/dN 窗口
  消息数（regex 提 timestamp 不整行 parse；mtime/size 缓存，3s 轮询
  零重算）→ runs/snapshot 透传 → 矩阵范围按钮可用且色阶真实。
  真数据：23/23 会话带窗口计数。

**验证**：ac-session（上架迁移/索引持久化/换架/幂等/窗口统计）+
ac-singles（创建即上架/换组迁移/老数据重启同步）+ ac-usage（byPair
四形态分类/回放重建）+ collab（对键+历史播种+双向同桶）+ port-b
（windows 透传/user 去重/byPair 消费/fallback 收紧）——preview 全量
637 测试 + vue-tsc + build + smoke 全绿；verify-runs 增列（热力窗口/
user 去重/byPair）全过。

> 事故记录：修 nonce 时 PowerShell `-replace` 表达式出错致 6 个 verify 脚本
> 被清空；经 DSH session 记录（jsonl.zstd）二次 JSON 解码完整恢复原版后
> 重放增强与补丁。教训：批量改文件用字面 Replace + WriteAllText，
> 不用 `-replace` 运算符拼多行替换串。

## 问题总览与分类

| # | 问题 | 分类 | 初步根因 |
|---|---|---|---|
| 1 | 模型/搜索引擎/全局定时任务全空；无法新增 | **迁移缺口**（数据没搬）+ 部分已知缩水 | workspace/default 的 config 域未迁移 |
| 2 | 全局/Agent 设置的"扩展和工具"全空 | **疑似 bug**（数据存在） | 待查（tools/list 有 31 项【实证】） |
| 3 | 思维链不渲染；event 消息渲染成气泡 | **后端持久化缺口**（M15 已知项的现实化） | SessionRecord 对话级、无 source |
| 4 | 名册无最后消息摘要、不按时间倒序 | **Port B 合成缺口** | lastActivity/lastMessage 未合成 |
| 5 | system prompt 预览为空 | 待查 | dry-run 装配内容疑空 |
| 6 | 设置面板 Agent 清单无 tag | **后端字段缺口** | AgentConfig 无 tags（迁移丢弃） |
| 7 | 用量弦图不渲染；运行矩阵空 | 弦图=**语义错配**【较确信】；矩阵=待查 | by_pair 全为 user↔agent 被默认过滤 |

---

## P1 模型池 / 搜索引擎池 / 全局定时任务为空，无法新增

**现象**：全局设置里模型、搜索引擎都是空清单；点击新增无法设置。全局定时任务页空。

**初步定位**：
- 【实证】`verify-settings-portb.mjs` 对真数据跑 `config/get` 返回 **0 个键**——
  `preview/data/config.json` 是空的。src 轨道的池配置（llmProviders/
  searchProviders）与全局定时任务（config 'timer.tasks'）住在
  `workspace/default` 的 config 里，`migrate-workspace.ts` **没有迁移这些域**。
- 【实证】`timer/list` 有 10 个 owner（per-Agent 条目），但全局定时任务页
  读的是 `timer/entries`（无 agentId → owner `__global__`）→ 空。
- "无法新增"是两层：① PoolManager 在 M17 就是**查看态**（无池 CRUD 面，
  已知缩水）；② schema 驱动表单依赖 `/api/plugins/*-schemas`，preview 无
  schema 面（Port B 显式降级为空表）。

**修复方向**：
1. 迁移补齐：`migrate-workspace.ts` 增量迁移 config 域（llm/
   llmProviders/searchProviders/timer.tasks，注意 preview config 白名单键
   与掩码 sanitize）——重跑幂等。
2. 若要"可新增"：最小方案是给 config/set 走通池条目的编辑表单（字段直连，
  舍弃 schema 驱动）；完整方案是后端补池 CRUD（方案 §一"可选增强"档）。

**验收**：设置面板显示既有模型池/搜索池条目；全局定时任务页显示 src 迁移
过来的全局条目；新增至少走通"字段直连"路径。

## P2 设置的"扩展和工具"页签为空（全局 + Agent 两处）

**现象**：全局设置与 Agent 设置的"扩展和工具"都是空列表。

**初步定位**：
- 【实证】后端数据存在：`tools/list` 返回 **31 个工具目录**、
  `agents/assembly` 的 `tools.catalog` 也是 31（verify-settings-portb 输出）；
  `plugin/loaded` 为 0（正常——无动态插件）。
- 【假设】消费链断了：ExtToolsPane/AgentPane 的数据源是
  `useSettings.loadPluginCatalog()`（getCatalog/getLibrary/getSessionPlugins/
  getPermissions 四请求 allSettled）与 `loadAgent → agents/assembly`。
  Port B 的 `settings/api.ts getCatalog` 已聚合 tools/list，但**形状或加载
  时序**可能不符：注意 getCatalog 里 `plugin/loaded` 空数组 + permissions
  RPC 只要有一个 reject，allSettled 会吞掉但对应 ref 保持 null。
- 【待查】浏览器 console 是否有错误；`pluginCatalog.value` /
  `agentAssembly.value` 实际取值；ExtToolsPane 渲染分支读的字段名
  （PluginCatalog.tools vs assembly.tools.catalog）。

**修复方向**：对照 `settings/components/ExtToolsPane.vue` 的消费字段修
`settings/api.ts` 的聚合形状；确认四 RPC 在真数据上全部 resolve。

**验收**：两处"扩展和工具"列出 31 个工具（含 requires 徽章）；三态开关
写回 updateAssembly 生效。

## P3 思维链不渲染；event 消息渲染成气泡

**现象**：会话界面看不到思维链（thinking 折叠栏）；定时/事件触发的消息
被渲染成普通气泡（应为 event 分隔符）。

**初步定位**：
- 【实证】**直播流式思维链是通的**——portb-e2e 断言 '先想想' reasoning
  落进 store。问题在**历史回放**：preview `SessionRecord` 是对话级
  （`role/content/message_id/timestamp/name` 五字段，无 reasoning_content/
  tool_calls/source——阶段一已文档化的"文本级保真"边界）。
- event 气泡同根：src 的 event 消息靠 `source: MessageSource` 渲染分隔符；
  preview 会话文件里 timer/归档触发落成 `role:'user'` 无 source →
  `toHistoryMessages` 只能映射成 user 气泡（README 已记录的降级）。
- 用户现在把它列为问题 = 该降级不再可接受，需后端补齐。

**修复方向**（后端，属方案 §一"后端补最小推导"档的升级）：
1. ac-session 持久化增强：assistant 落账时带 `reasoning_content`（reply-
   completed 已有 LoopRunResult.steps 可取末步 reasoning）；工具对
   （tool_calls + tool 行）可选。
2. 事件消息：入账时 `router/message-received` 的 sender='event' 消息落
   `role:'event'` + `source`（或最小版：event 角色即可，UI 端
   `toHistoryMessages` 已把非 user/assistant/tool 映射为 event 分隔符）。
3. UI 侧 `api/runs.ts toHistoryMessages` 透传新字段（reasoning_content→
   thinking；role:'event' → event 行）。

**验收**：刷新后历史保留思维链折叠栏；timer 触发消息显示为 event 分隔符。

## P4 名册无"最后一条消息"摘要、不按时间倒序

**现象**：Agent 清单不显示最后一条消息文本；Agent 与群不按最近活动排序。

**初步定位**：
- 【实证】Port B `api/roster.ts toAgentList` **不合成** `lastActivity`/
  `lastMessage`（阶段一记录的已知容忍：前端 `?? 0`，排序静态）。原适配器
  也从未提供——src 靠 WS agent.list.response 的这两个字段驱动列表预览。
- 数据源可得性：【实证】`runs/snapshot.conversations[]` 含全部会话的
  `updatedAt`（14 个 1v1 + 群 + singles）——足够合成 lastActivity 排序。
  lastMessage 文本需要 per-conversation 尾部记录（`session/history
  limit:1` per agent，N+1 但名册规模 ~15 可接受；或后端在
  runs/snapshot 附带每会话最后一条消息摘要——更优）。

**修复方向**：
1. 最小：`fetchAgents` 再聚合 `runs/snapshot`，`lastActivity ←
   conversations[agentId].updatedAt`；groups 同理（g 条目 updatedAt）。
2. lastMessage：评估在 ac-web-api `runs/snapshot`（或新轻量 RPC）附带
   每会话尾部摘要 `{text, role, ts}`；UI 侧填 `lastMessage`。
3. 会话中实时 bump 已有（bumpAgentById），刷新后靠上述持久值恢复。

**验收**：名册按最近活动倒序；每项显示最后消息摘要（与 src 一致）。

## P5 Agent 会话 Header 的"预览 system prompt"内容为空

**现象**：ChatView 头部的 System Prompt 预览弹窗内容为空。

**初步定位**：
- 【假设】`agents/system-prompt`（ac-agent-admin systemPromptPreview =
  before-run waterfall 干跑）对无 hooks 配置的真数据 Agent 返回的装配
  内容为空或极薄：ac-system-prompt 的 framework 块默认存在，但对话信息
  块按信封门控（dry-run 无信封）、术语/指引块按 request.tools 门控——
  若 dry-run 请求构造缺 tools/信封，输出可能只剩零星块。
- 【待查】先用脚本对真数据调 `agents/system-prompt`（如 abap_coding_agent）
  看实际返回；再决定是 admin 干跑构造补全（带 tools + 信封）还是 UI 侧
  展示问题。portb-e2e 未覆盖此 RPC（只测了 tool-defs/system-prompt 的
  通道在 mock 档案上）——补一个真链路断言。

**修复方向**：admin 的 systemPromptPreview 干跑请求补 tools（生效集）与
最小信封，使 framework/指引块装配；UI 无需改。

**验收**：预览弹窗显示完整分块 system prompt（framework/系统环境/指引）。

## P6 设置面板的 Agent 清单不显示 tag

**现象**：全局设置 → Agent 清单（AgentListPane）没有能力标签（base/dev/
admin/conductor 徽章）。

**初步定位**：
- 【实证·根因】preview `AgentConfig` **没有 tags 字段**（字段白名单
  id/model/provider/virtual/system/tools/llmParams/maxSteps/description/
  hooks/apiKey）——src 迁移时 tags 被丢弃；roster/AgentPane 的
  `raw.tags` 恒 undefined。
- 属后端字段缺口：要么 AgentConfig 增 tags（框架改动：ac-agents 契约 +
  agent-store 落盘 + admin 白名单 + 迁移脚本补搬），要么 UI 侧从别的
  信号近似（无好的近似源——不建议）。

**修复方向**：ac-agents `AgentConfig.tags?: string[]` + admin sanitize
白名单 + migrate-workspace 补迁移 src 的 tags 字段 + roster 合成透传。

**验收**：AgentListPane 显示 tag 徽章；（若做了迁移）真数据 15 Agent 的
标签与 src 一致。

## P7 用量弦图不渲染；运行总览矩阵内容为空

**现象**：Token 用量的协作弦图空白；运行总览的 N² 矩阵视图没数据。

**初步定位**：
- **弦图**【较确信·语义错配】：src TokenUsage 的弦图默认
  `includeUserSelf=false`（"聚焦 Agent 间协作"，UI 内注释）——它把
  a/b 含 'user' 的 pair 过滤掉。而 preview 的 byConversation 只有
  user↔agent 弦（无 agent⇄agent 用量行，`api/usage.ts toUsageSummary`
  的 by_pair 全部是 `a:'user'`）→ 默认视图恒空。开关打开（包含 user）
  应该就能看到弦——可先让用户确认。
- **矩阵**【待查】：数据面【实证】存在（verify-runs-portb：23 会话 →
  14 pair + 1 群）。`stores/runs.ts` 3s 轮询以
  `document.visibilityState==='visible'` 为门，浏览器正常可见；怀疑
  点：① `fetchRuns` 双 RPC 之一在浏览器侧 reject（脚本 WS 通，但 UI 走
  同一 wire——应同通）；② RunTracking 消费字段与 `RunsSnapshot` 类型
  面有出入（如 `windows` 全零导致格子透明化？src 密度色阶用 messageCount
  而非 windows，待核）；③ console 有未捕获错误。开工第一步：开浏览器
  console + 断点 `stores/runs.ts refresh()`。

**修复方向**：
1. 弦图：默认 `includeUserSelf=true`（preview 语义下 user↔agent 就是
   全部协作流量）；或 by_pair 合成时保留并在 UI 文案说明。
2. 矩阵：按 console 实证修（消费字段/轮询门/错误处理）。

**验收**：弦图渲染 user↔agent 弦（可开关）；矩阵显示 14 个 1v1 格子 +
群对角格，密度/运行光环正确。

---

## 开工建议顺序

1. **先查证类**（P2 扩展工具、P5 prompt 预览、P7 矩阵）——console +
   verify 脚本即可定位，可能是小修。
2. **迁移补齐**（P1 config 域 + P6 tags 一并进 migrate-workspace）。
3. **Port B 合成补齐**（P4 lastActivity/lastMessage）。
4. **后端持久化增强**（P3 思维链/event 角色——动 ac-session，最重，
   放最后；顺手把 portb-e2e 补 system-prompt 断言）。

每项修完跑：`pnpm --filter ac-webui-app typecheck && pnpm preview:test &&
pnpm --filter ac-webui-app build`；涉及后端的加 `pnpm preview:smoke`。

## 相关文件索引

- UI 数据面：`preview/webui/src/api/`（roster/usage/runs/settings 域在
  `settings/api.ts`/groups/singles/files/system/wire/chat-ops）
- 后端：`preview/ac-web-api/src/index.ts`（runs/snapshot·config 白名单）、
  `preview/ac-agent-admin/src/`（system-prompt 干跑·AgentConfig 白名单）、
  `preview/ac-session/src/index.ts`（SessionRecord）、
  `preview/ac-agents/src/service.ts`（AgentConfig）
- 迁移：`preview/scripts/migrate-workspace.ts`（幂等，可增量补域）
- 验证脚本：`preview/scripts/verify-*-portb.mjs`（5 个，按面分）

# M17 开工简报：src/ui/webui 功能对账与原生面补齐路线

> 生成于 2026-08-23（M16 收官当日）。M16 原生重写按"无面即无视图"原则
> 落地，功能面相对 src/ui/webui（旧轨完整前端）收窄——本文盘点 src
> UI 全功能，逐项标注原生面状态与后端依赖，作为下一 session 的开工地图。
> 事实源：`docs/m16-recon/`（stores/views/extensions 三份旧壳规格）+
> `docs/m17-recon/`（backend-faces/settings-spec/src-extras 三份补充侦察）+
> `preview/README.md`（各域服务现状）。
>
> **对账原则**：① 先判"preview 是否有对应后端面"——有则纯前端恢复，
> 无则按缺口大小分"RPC 封装已有服务 / 新开能力域"两档；② src 独有
> 概念（singles/预设/模型池编辑）不盲搬——先按规约 2（conversationId
> 直用）判其在 preview 的对应形态，无对应即显式缩水并记录。
>
> **✅ M17 收官（2026-08-23）**：全序列 M17-A→F 落地完成（README 里程碑
> 条目为权威摘要）。下表状态列 = 收官后状态；关键收敛决策与缩水记录见
> 各行备注与 §五 之后新增的"收官勘误"。验收：preview tsc + webui
> vue-tsc + 576 测试 + smoke + boot 真连探测（WS RPC + HTTP 面）+ 生产构建。
>
> ## 收官勘误（相对原计划的收敛记录）
>
> 1. **byPair 弦图 → 按会话排行条**：preview 无 from/to 双端点（规约 2 单键），
>    usage 流水有 conversationId——byPair 收敛为 byConversation（ac-usage 新增），
>    UsagePanel 以排行条呈现（d3-chord 不建，依赖保留）。
> 2. **模型列表代理不建**：AgentPane 模型页 provider/model 直选 + llm/providers
>    stats（provider meta 自带 models 清单）取代 /api/agents/models 直连代理。
> 3. **browse 原生对话框不建**：前端 `<input type=file>` / 手工路径 + workspace/
>    file 读取取代（浏览器安全限制下原生选择器为更优解，plan 原判"前端能力"）。
> 4. **全局定时走 timer RPC**（非 config 键面直写）：ac-timer 增 config inject，
>    全局条目持久化 config 'timer.tasks'，row chime 条目 source:'builtin' 保护；
>    设置面板经 timer/entries·save 读写（默认 owner=__global__）。
> 5. **插件库四页签 → 三页签**：市场（market/source.ts 未平移）与开发目录扫描
>    不建；会话级页签承担 dev 注册表单（dir/grants/watch → plugin/load sessionOnly）。
> 6. **pool-default 两测试不搬**（条件性）：preview 无 config 内联池表（模型路由
>    住 yml），$ref 折叠/设为默认同步语义无对应面——若未来引入内联池则同搬。
> 7. **assembly 无 presets**：预览装配视图 = plugins 目录 + hooks[具名] +
>    tools include/exclude（ADR-4：per-Agent 插件启停显式缩水）。
> 8. **运行跟踪收敛**：runs/snapshot = 会话文件扫描 + running + groups +
>    usageTotals（纯读）；矩阵视图 3s 轮询 + 只读历史展开（pair 视角语义收编）。
> 9. **Token 仪表近似**：lastContextPrompt（usage 覆盖轨）+ session stats
>    messageCount；四档 status 阈值 10k/30k/60k（无 maxContextTokens 配置面）。
> 10. **版本面显式缩水**：system/version 只读根包版本；changelog/自更新/npm
>     检查不建（更新走 supervisor 进程层）。

## 一、功能域总表（状态：✅ 已有 / ◐ 部分 / ❌ 缺失 / — 显式缩水）

| 功能域 | src 具备 | M16 原生面 | preview 后端资产 | 状态 |
|---|---|---|---|---|
| 1v1 聊天流（历史/流式/思考折叠/工具卡） | ✅ | ✅ | conversation/session/loop/llm/tools 事件面 + RPC | ✅ |
| 会话 Token 仪表（1v1 会话头） | ✅ | ❌ | session/tokens RPC（usage lastContextPrompt 近似 + messageCount） | ✅ |
| ask_questions 应答 | ✅ | ✅ | durable-interaction + interaction RPC | ✅ |
| 群聊（成员/发言/历史/重命名） | ✅ | ✅ | group RPC 全套 + 事件面 | ✅ |
| Agent 管理（CRUD/凭据/文档/system-prompt 预览） | ✅ | ✅ | ac-agent-admin RPC | ✅ |
| 用量统计（云图/byAgent/byModel/byDay/范围） | ✅ | ◐ 简化 | usage/tokens 五维（+byConversation）；byPair 弦图→排行条收敛 | ◐ |
| UI 扩展宿主（slots/isolated） | ✅ | ✅ | ac-webui + ac-webui-extensions | ✅ |
| 消息操作（行内编辑/重新生成/删除/继续生成） | ✅ | ◐ 仅删除/重生成 | session/truncate（truncateAfter 语义）+ delete-message | ✅ |
| 附件上传（chat.send files） | ✅ | ❌ | POST /api/upload（multipart；agentId 定向 _tmp/） | ✅ |
| 时间分隔符 / 相对时间 | ✅ | ❌ | 纯前端（insertTimeSeparators + 测试） | ✅ |
| 头像星色系统（StarAvatar 列表/消息） | ✅ | ◐ 令牌在组件未用 | 纯前端（starColor + StarAvatar 列表/消息启用） | ✅ |
| 上次会话上下文恢复（lastContext） | ✅ | ❌ | 纯前端 localStorage | ✅ |
| 列表交互细节（指针冻结/宽度拖拽/未读浮顶排序） | ✅ | ◐ 未读有 | 纯前端（摘要+浮顶+冻结+拖拽） | ✅ |
| 移动端适配（抽屉/responsive） | ✅ | ❌ | 纯前端（ui.isMobile/sidebarVisible；≤768px 抽屉） | ✅ |
| 运行跟踪（矩阵大画布 + 运行树面板 + 软中断） | ✅ | ❌ | runs/snapshot（纯读推导）+ runs/interrupt；RunTrackingView 收敛实现 | ✅ |
| Agent↔Agent 只读视角（pair） | ✅ | ❌ | 任意 conversationId 只读历史展开（pair 语义收编） | ✅ |
| 独立会话 singles | ✅ | — | preview 无此概念（conversationId 即会话键） | — 缩水 |
| 工作区（登记/树/分屏/文件预览） | ✅ | ❌ | workspace 文件面（tree/file/raw/upload/workspaces）+ FilePreviewModal；browse 简化=原生 input | ✅ |
| 设置面板全件（模型池/搜索引擎/扩展工具/定时任务/插件库/权限/全局配置） | ✅ | ◐ 仅 Agent 管理 | RPC 全套（M17-A）+ settings 域九组件；市场/开发扫描/模型列表代理缩水 | ✅ |
| 版本检查/更新（含 changelog/自更新） | ✅ | ❌ | system/version（只读）；changelog/自更新显式缩水 | ◐ |
| 数据备份（立即备份 + 更多菜单） | ✅ | ❌ | backup/run·list + SystemPanel | ✅ |
| 插件打包入口（src/index.ts+plugin.ts 插件行形态） | ✅ | ✅ 对应形态已有 | preview 对应 = cordis.yml 行 + ac-webui 静态托管（M13 已定：不做发布期构建），src 式插件行无需恢复 | ✅ |
| 前端测试面（10 个测试文件） | ✅ | ◐ 部分已搬 | backlog-flush 三不变量 + loadHistory 竞态 + csp-audit 已搬；pool-default 条件性不搬；性能基准弃 | ✅ |

## 二、后端缺口清单（preview 需新开/封装的面）

### A 档：服务已有，只缺 RPC 封装（薄编排，半天级）

| 面 | 现有服务 | 读面 | 封装落点 |
|---|---|---|---|
| 定时任务管理 | ctx.timers | list()/entries()/save()/triggerNow() | ac-web-api 加 timer/list·save·trigger |
| 备份 | ctx.backup | run({force})/list() | ac-web-api 加 backup/run·list |
| 后台任务 | ctx.jobs | start/list/get | ac-web-api 加 jobs/list·get·kill |
| 全局配置 | ctx.config | all()/set()/merge()/delete()/reload() | ac-web-api 加 config/get·set（白名单键；sanitize 前端平移 schema.ts 规则） |
| 模型池查看 | ctx.llm | providers()/stats() | ac-web-api 加 llm/providers（池编辑=config 键面，非 src 式池 CRUD——见 C 档） |
| 插件库全流程 | ctx.pluginRegistry + ac-plugin-core | stage/listStaging/listStagingFiles/readStagingFile/rejectStaging/approve(id,grants)/uninstall/listInstalled/listLoaded/loadInstalled/load/reload/unload | ac-web-api 加 plugin/stage·staging-list·staging-file·approve·reject·installed·loaded·unload |
| 会话插件面 | 同上 | load(spec sessionOnly)/reload/unload | 同上（session 参数直通；src 的 watch 目录监听不在首期） |
| 权限词汇表 | ac-plugin-gates + ac-plugin-core | HOST_CONTRACTS_VERSION/权限定义 | ac-web-api 加 plugin/permissions（视图出口） |
| 装配视图 | ac-agents resolveToolNames + agent-admin | — | ⚠️ 半新：AssemblyView 形状（presets/tools/hooks + enabled 烘焙）需在 ac-web-api 或 ac-agent-admin 组装 GET/PUT——preview 无 src 式装配后端，属 A/B 之间（见契约语义差） |
| 版本 | （根 package.json） | — | ac-web-api 加 system/version（读包版本，零业务） |
| 重启触发 | ac-restart（system_restart 工具 + exit 42 + supervisor 重拉） | — | ac-web-api 加 system/restart（直调 interrupt 通道；UI 触发面） |

### B 档：需要新开能力域（按 src 面形状设计，工作日级）

| 面 | src 形态 | preview 落点建议 | 备注 |
|---|---|---|---|
| 运行历史矩阵 | /api/runs（会话文件扫描） | 新 RPC runs/snapshot：扫描 ac-session 会话文件 + usage 流水推导成员/区间消息量/运行条目 | 纯读推导面；数据源=session 文件（规约：只读扫描不写） |
| 文件上传 | multipart → files/<agent>/ | ac-web-server 加 HTTP 上传路由 + ac-workspace 树读取路由 | M7 起延后；src FilePreviewModal/ToolResult 预览依赖 |
| 头像 | POST/DELETE /api/agents/:id/avatar | 复用 B-文件面（agent 头像存 agentStore 目录） | 与文件面同批 |
| 文件浏览对话框 | POST /api/browse/file | 原生 <input> 选择即返回路径，可不经后端（前端能力） | src 用后端对话框因浏览器安全限制；preview 可用原生选择器简化 |
| 工作区树 | /api/workspaces + browse | 复用上传面 + workspace 目录路由 | 依赖 B-文件面 |
| 弦图协作流量 | /api/usage 的 pair 维度 | ac-usage 增 byPair（流水行已有 conversationId 数据基础，README 已注） | 数据面小改 |
| 模型列表代理 | GET /api/agents/models | ac-web-api 加 agents/models（经 llm provider 直连 /models；凭证注入） | 后端代理防浏览器跨域 |
| schema 元数据 | GET /api/plugins/llm-schemas·search-schemas·schemas | ⚠️ 选形：preview 无 schema 目录概念——恢复时改**字段直连表单**（AgentConfig 已知字段 + tools/tool-defs 白名单），不建 schema 驱动层（src 的 schema 目录来自插件元数据，preview 插件域无此元数据形态） | 简化决策，非缩水 |
| 市场发现层 | GET/POST /api/plugins/market/* | ❌ src market/source.ts 未平移；首期不做（离线缓存页可跳过） | 移到 C 档缩水 |

### C 档：显式缩水（src 概念在 preview 无对应，不恢复）

- **singles/独立会话**：preview conversationId 直用（规约 2），"独立会话"= 多 Agent 1v1 会话，已被现有模型吸收；src 的 session 换 Agent/模型/工作区绑定无对应。
- **预设 agentPresets**：preview 无预设目录概念（agents-dir 数据驱动 + hooks 装配）；src 预设=内置 prompt 包，preview 对应=普通 Agent 档案。
- **模型池编辑（PoolManager）**：preview 模型路由表住 yml/适配器行（出厂态），运行期池编辑=配置热刷新（ctx.config + reload），不建 src 式池 CRUD。
- **chat.subscribe resume 快照**：M16 已定——幂等重建取代（README 已记）。
- **插件市场发现层**（/api/plugins/market/*）：src market/source.ts 未平移；首期不做——恢复插件库时跳过市场页签（离线缓存页零网络，可保留占位）。

## 三、纯前端恢复清单（无后端依赖，按交互价值排序）

1. **消息操作补全**：行内编辑（truncateAfter 语义=删除其后消息再重发）、继续生成（投递"（请继续）"）、删除（已有限历史记录级）——M16 已留 regenerate 按钮降级。
2. **时间分隔符**：utils/format 补 insertTimeSeparators（原生 Turn 带 startedAt，无 DisplayItem 概念）。
3. **头像星色**：列表/消息头像启用 StarAvatar + utils/starColor（已搬未用）。
4. **lastContext 恢复**：localStorage 记住最后选中会话，刷新恢复（store 小件）。
5. **列表交互**：指针冻结（流式重排防点错行）、列表宽度拖拽、lastMessage 摘要+lastActivity 浮顶（摘要源=各会话历史尾条，会话开面时本地缓存）。
6. **移动端适配**：≤768px 抽屉（ui store 已有 listVisible，补 sidebarVisible 语义）。
7. **Agent↔Agent 视角**：session/history 按任意 conversationId 可读——pair 视角纯前端（选中两个 Agent 只读展示其会话）。
8. **测试面搬运**（src 10 个测试的取舍，见 `docs/m17-recon/src-extras.md` §2）：
   - 已覆盖不重复：并行工具按 toolCallId 配对（原生 reducer 已有等价测试）、p5.5-policy（随扩展宿主已搬）。
   - 值得搬：`ws-backlog-flush` 四条不变量（积压 flush/毒消息隔离/CLOSING 补发/身份守卫——wire/connection 现有测试只覆盖部分，补全）；`feed-rapid-switch` 的过期响应丢弃与分区零污染（原生对应 = loadHistory 竞态守卫，补测）；`csp-audit`（构建产物 CSP 审计，零运行时依赖，防 CSP 漂移）。
   - 无对应面不搬：`feed-resume-merge`（resume 快照——幂等重建取代）；`search/llm-pool-default`（仅在恢复池默认同步时随 schema.ts 同搬）。
   - 性能基准（2 个）可弃：测量对象（mergeHistoryPage/buildTurnsIncremental）已换实现，数字不可比。

## 四、设置面板补齐（src settings 域 → 原生面）

> 字段级明细见 `docs/m17-recon/settings-spec.md`（导航树/五页签字段/池 CRUD/插件库四页签/
> useSettings 状态模型与竞态守卫）。恢复要点与选形决策：

**导航树**（src 七类节点 → 原生对应）：
`agents`（Agent 列表 + 编辑器）、`llmPools`（模型池管理）、`searchPools`（搜索池）、
`extTools`（扩展与工具目录）、`pluginLibrary`（插件库四页签）、`sys.timer`（全局定时）
+ 动态 `ui-tab:*`（插件 settings-tab:global slot——extensions/slots.ts 已备渲染口）。

**AgentPane 五页签**：基本信息（头像❌/昵称/能力标签/双文档）· 模型（池选择+生效摘要
四级来源推导+分组字段+模型列表代理❌）· 定时任务（TimerPane 5 模式）· 安全（allowedPaths）
· 扩展与工具（ExtToolsPane agent 模式 + legacy 迁移横幅——preview 无 legacy 契约，可省）。

**选形决策**（src 契约语义差 → preview 收敛）：
1. **schema 驱动 → 字段直连**：src 的 llm/search/ns schemas 来自插件元数据（preview 无此
   形态）——原生 AgentPane 直接以 AgentConfig 已知字段 + agents/tool-defs 建表单，
   不搬 schema 归一化层（toFields/filterFields/SettingField 七控件按需精选）。
2. **effective 双视图 → 单视图**：src raw（编辑）/effective（展示合并）双轨——preview
   agents/get-config 单视图（store 优先回退注册表），dirty 判定退化为"表单 vs 拉取值"比对。
3. **双文档合并保存 → 双端点**：src config 端点带 sysContent/agentContent——preview 已拆
   save-doc/read-doc（空=删）+ system-prompt dry-run 预览，语义等价不需改后端。
4. **池 CRUD → 查看 + 配置键**：PoolManager 编辑走 config RPC（池内联在全局配置）；首条
   自动默认/ratio 清理/设为默认同步（applyLlmPoolDefault/applySearchPoolDefault 纯函数
   + 两个测试）随 config 面恢复时同搬。

**恢复顺序**：AgentPane 扩展（信息/安全/定时 tab）→ TimerPane（timer RPC）→
插件库四页签 + StagingReviewModal（plugin RPC + staging 文件树）→
PoolManager 查看态 + ExtToolsPane（llm/providers RPC + config RPC）→
全局定时（sys.timer + builtin 保护）→ 插件 settings-tab 渲染口收尾。

## 五、工作分解（下一 session 建议序）

- **M17-A 后端 RPC 补齐**（§二 A 档：timer/backup/jobs/config/llm-providers/
  plugin 全套/permissions/version/restart + ac-web-api 测试）——设置面板/备份/
  插件库/版本的前置。装配视图（AssemblyView GET/PUT）与模型列表代理按需随批。
- **M17-B 设置面板全件**（§四恢复顺序）：AgentPane 扩展 + TimerPane + 插件库
  （列表/人审/staging 文件树）+ 池查看 + ExtToolsPane + 全局定时 + config 编辑
  + schema.ts 池同步纯函数（随两测试同搬）。
- **M17-C 聊天面细节**（§三 1-6）：消息编辑/继续生成/时间分隔/头像星色/
  lastContext/列表交互/移动端。
- **M17-D 运行跟踪**：runs/snapshot 面（§二 B 档）+ 矩阵/运行树两视图 +
  pair 视角（纯前端，§三.7）+ 会话 Token 仪表（近似实现）。
- **M17-E 文件与工作区**：上传/头像/文件读取路由 + FilePreviewModal +
  WorkspaceTree + 附件 chips + browse 简化（原生 input 选路径）。
- **M17-F 收尾**：版本弹窗（version RPC）/备份面板（backup RPC）/
  弦图 byPair（usage 小改）/测试面搬运（§三.8）/文档对账。

每步验收：`pnpm --filter ac-webui-app typecheck` + `pnpm exec vitest run preview/webui/tests` +
`pnpm preview:test`（后端改动时）+ boot 真连手测该步功能。

## 六、事实源索引

| 内容 | 文件 |
|---|---|
| 旧壳 stores/交互语义规格 | `docs/m16-recon/stores-spec.md` |
| 旧壳视图组件规格 | `docs/m16-recon/views-spec.md` |
| 扩展宿主/注册表搬迁清单 | `docs/m16-recon/extensions-spec.md` |
| src UI 后端端点面全表（70 HTTP + 13 出站 + 42 入站） | `docs/m17-recon/backend-faces.md` |
| src settings 域字段级规格（导航树/五页签/池/插件库/useSettings） | `docs/m17-recon/settings-spec.md` |
| src 独有件（插件行形态/10 测试取舍/m16 报告 17 条补遗） | `docs/m17-recon/src-extras.md` |
| src 前端本体（旧轨，冻结只修 bug） | `src/ui/webui/` |
| preview 原生面（M16 现状） | `preview/webui/` + `preview/README.md` |

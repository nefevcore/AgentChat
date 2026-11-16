# 工具源统一（tool-source-unification）

> 性质：实施计划——host-face 与 MCP 统一为「工具源」处理模式：批 1 修正确性（timer 代理工具三面失明事故），批 2 立契约与发现缓存。
> 状态：批 1+批 2 均已收口（2026-11-15，cr-1114）——承接 cr-886 / cr-1007 / cr-1028 语义链。批 1 改动 1 的 core 常量（HOST_FACE_*）已随 cr-1121 真动态化退役（宿主契约 = 注册面聚合，壳 boot 静态面换源宿主写契约缓存——见 host-face-dynamic-contract.md）。
> 读者：实施本计划的新会话（本文档自包含，实施前无需回读原分析会话）；收口时参与验收的评审者。

## 一、背景与根因（为什么做）

事故实况（2026-11-15 会话活体探针取证）：宿主能力面代理工具 timer / update_agent_profile 在壳注册面**在册**（tools-catalog 20 个工具含二者），但模型三面全失明——

| 失明面 | 证据 | 直接机制 |
|---|---|---|
| LLM schema 面 | tool-defs 16 个，无二者 | 白名单行 token 经 rowTools 展开，host-face-client 无键 |
| SDK 投影（tc-programmatic） | 会话快照 PTC_SDK 段 HAS_TIMER=False | 快照物化先于懒装配，正文冻结旧投影 |
| 远程段 | 快照段集无 GUIDELINES_TIMER | 同上 |

全数据根 17 个 Agent 历史消息零 timer 调用记录——长期状态，非单会话回归。

根因两条（均非注册时机本身）：

1. **rowTools 相位错位**：cr-1028 的归属反查是 boot 一次性回填；cr-886 的懒装配注册发生在首 run 的 prepare 缝（cr-944 P2b）。相位差 = 白名单词汇（行 id，静态）追不上懒注册（动态）。cr-1007 判定「已知行 id 而 rowTools 无键 = 无工具面行，滤除」把整行工具滤掉。
2. **前缀快照相位错位**：conversation 的 syncPrefixSnapshot（ac-shell-conversation/src/service.ts:605 附近）在 agentLoop.run() 之前执行，而懒装配 prepare 在 run() 入口内——首 run 物化的快照正文永远不含懒注册工具。后续 run 走 frozenSections 跳过注册面；指纹 diff 虽能看见 ptcSdk/sectionTexts 漂移，但 cr-888 ④ 语义只通知不重写正文。

统一认知：host-face 与 MCP 同构——**schema 不能（或不宜）在 boot 同步期静态枚举的工具提供方**。共同注入五个消费点：ctx.tools 注册面 / LLM face（request.tools）/ rowTools 白名单展开 / 段与 SDK 投影文本 / 前缀快照指纹。统一心智模型一句话：**boot 期承诺「名与形」，run 期兑现「连与果」，变更走对账**。

业界参照（已调研 2026-11-15）：Gemini CLI 启动 eager；Codex 启动连接 + 1s 共享宽限内未就绪者缺席首 turn 目录（显式盲窗，mcp_optional_startup_grace_ms 可配）；Claude Code discovery cache（上会话缓存装载、connects on first use、首消息即全量）+ ToolSearch（业界唯一 mid-session deferred registration）；OpenCode 原生启动装载，社区懒装载插件用恒定入口工具。无一家做壳内 mid-run 面放宽。本计划取 Claude Code 谱系（承诺面 + 发现缓存），叠加 AgentChat 自有的消费者相位修复（业界参考里没有，必须自己修的地基）。

## 二、批 1：正确性修复（零新基建）

### 2.1 host-face boot 静态承诺面

| 项 | 内容 |
|---|---|
| 改动 1 | HOST_FACE_TOOLS 工具 spec（现住 packages/ac-host-face/src/tools.ts）下沉 packages/ac-host-face-core/src（壳不再依赖宿主行包）；宿主行转引，单一事实源 |
| 改动 2 | packages/ac-host-face-client/src/index.ts：apply 同步段（行自身 fiber 域）注册**静态承诺面**代理工具——spec 直取下沉常量，execute 内惰性连接（client.connect 按需 + 既有重连退避），零 I/O。不碰 cr-886 fiber 挂死教训：那次挂死是异步 then 回调脱域，boot 同步注册无此问题 |
| 改动 3 | prepare 缝（registerSectionPrepare）保留，职责收窄为「对账重建」：discover 契约与在册面 diff——schema 变更 / invalidate 后重建段与 spec；发现集与承诺面恒等时零操作 |
| 改动 4 | 远程段（GUIDELINES_TIMER 等）从「discover 后懒注册」改为「boot 同步注册静态文本 + 契约对账后更新」——段内容是静态常量，与工具 spec 同批下沉 |

### 2.2 rowTools 活查询化（白名单展开第六代）

演进脉络：行声明（cr-590 前）→ boot 反查快照（cr-1028）→ **use-time 现算（本批）**——「注册即归属」本就是 cordis fiber 原生事实，boot 反查表是多余缓存。

| 项 | 内容 |
|---|---|
| 改动 5 | toolFaceOf 行 token 展开改活查询：listWithOwner() 现算（owner = fiber 名 = 行名），工具名 token 照旧透传；缓存面收窄为 config.rows 键级（键变即失效，语义不变） |
| 改动 6 | apps/shell/boot.ts 的 rowTools 一次性回填退役为 boot-graph 审计快照专用（审计面照旧落盘，承重路径不再消费它） |
| 改动 7 | 同款消费方排查（grep 实况）：packages/ac-shell-rows/src/shims.ts（AgentsService 垫片 :74 展开与 :80 过滤）、packages/ac-host-webui/src/face-shell.ts（宿主侧估算，读 tool-catalog rows 段 + mtime 缓存）。垫片与 conversation 同步换活查询源；face-shell 侧数据源不变（宿主无壳内注册面，维持 catalog 投影 + 批 2 缓存对账刷新） |

### 2.3 前缀快照漂移升级 ③ 重算

| 项 | 内容 |
|---|---|
| 改动 8 | syncPrefixSnapshot（ac-shell-conversation）对账分支：ptcSdk / tools / sectionTexts 指纹漂移从 ④（通知不重写）升 **③ 重算**（与 model/provider 同通道——SDK 投影字节变 = KV cache 前缀必死，保留旧正文省不了缓存，重算白纸无代价）；sectionSet（增删段）维持 ④ 通知——正文不含新段 system 不变缓存不死，语义已正确 |

### 2.4 批 1 验收

测试标准（过程门，按改动面走验证阶梯）：

- pnpm typecheck && pnpm test:unit && pnpm check:deps + 定向 lint（改动文件）。
- 定向：npx vitest run packages/ac-host-face packages/ac-host-face-core packages/ac-host-face-client packages/ac-shell-conversation packages/ac-shell-rows；动了装配链 → pnpm test 全量（apps/shell e2e 在列）。
- 新增用例：① 白名单 Agent（rows 点名 host-face-client）在 tc-base 会话 toolDefs 含 timer；② 同 Agent singles tc-programmatic 会话快照 PTC_SDK 含 timer 声明与 GUIDELINES_TIMER 段（首 run 物化即含——非 run 2 收敛）；③ 代理工具 execute 走惰性连接（宿主缺席时调用报可读错误，boot 不被阻塞）；④ 快照 ptcSdk 漂移触发重算（指纹更新 + 正文重写 + 后续 run frozenSections 为新值）。

验证目标（目的态断言，全达才收口）：

- ☑ 带白名单的 Agent 三面（schema / SDK 投影 / 远程段）首 run 即见 timer 与 update_agent_profile，无需重启或二次 run。
  （实证：apps/shell/tests/cr1114-faces.test.ts 两端到端用例 + 活体三面探针）
- ☑ 壳 boot 耗时与 host-face ipc 可达性解耦（宿主缺席 = 代理工具在册、调用时报错——软降级语义不变但可见性不丢）。
- ☑ rowTools boot 反查不再被任何承重路径消费（grep 实证：仅 boot-graph 审计落盘引用）。

## 三、批 2：ToolSource 契约 + MCP 发现缓存

### 3.1 契约与事件

| 项 | 内容 |
|---|---|
| 改动 9 | ToolSource 契约进 packages/ac-tools/src/contract.ts：bootFace()（boot 同步期可承诺的名 + schema）/ discover()（活发现，与注册面对账）/ execute（惰性连接）。归位：契约住 owning 包；发现结果对账后 emit tools/source-changed（emit 事件——观察通知，事件目录进 ac-tools/src/events.ts） |
| 改动 10 | host-face-client 与 ac-mcp 均实现该契约（host-face 在批 1 已就位，此处只是声明面收口）；listWithOwner 的 owner 词汇与行 id 的对齐约定写入契约注释 |

### 3.2 MCP 发现缓存

| 项 | 内容 |
|---|---|
| 改动 11 | 缓存落点 <dataRoot>/meta/mcp-discovery/<def-hash>.json（meta/ 为数据根分层契约合法层——同批在 docs/design/assembly/data-root-layers.md 登记 + doctor 对账面加白）；def-hash = 服务器定义指纹（command/url/args/env 规范化序列化哈希——定义变 = 新键，旧键自然成孤儿由对账清理） |
| 改动 12 | ac-mcp boot 阶段：有缓存 → 按缓存注册承诺面（连接照懒）；无缓存 → 现 prepareRun 懒发现路径不变（冷启动首 turn 盲窗 = 显式取舍，Codex 同款，记入裁决簿 docs/design/assembly/host-shell-decisions.md） |
| 改动 13 | 发现完成（建连 tools/list 或 listChanged 通知）→ 与在册面对账（增 / 删 / schema 变）→ 更新缓存 + emit tools/source-changed；对账语义与 host-face invalidate 复用同一契约面——两传输从此是同一模式的两实例 |

### 3.3 批 2 验收

测试标准：

- 同批 1 阶梯 + pnpm test 全量 + pnpm test:integration（动了子进程建连链路）。
- 新增用例：① 冷启动后首 run 触发建连发现 → 缓存落盘；② 第二次 boot（缓存命中）首 run 即全量工具面；③ 服务器定义变更（def-hash 变）→ 旧缓存不命中、新键生效；④ listChanged → 对账增删工具 + 缓存更新 + 事件发出；⑤ MCP 工具 schema 变 → 下次 boot 承诺面用新 schema（对账修正前旧值调用由 validateInvoke 兜底报错，可读）。

验证目标：

- ☑ 有缓存时 MCP 工具首 run 全量可见（含白名单 Agent 与 tc-programmatic SDK 投影两路径）。
  （实证：ac-mcp 用例②——boot 后未跑 run 即 has，connectCount=0）
- ☑ 壳 boot 不因 MCP 服务器进程可达性阻塞（npx 慢服务器不拖启动——懒建连不变）。
- ☑ host-face invalidate 与 MCP listChanged 在 tools/source-changed 事件面同构（消费方无 per-source 分支）。
  （MCP 侧重发现入口 = McpService.redetect()，listChanged 通知将来的接线点）

## 四、显式取舍与风险边界

| 项 | 裁决 | 依据 |
|---|---|---|
| MCP 冷启动首 turn 盲窗 | 接受（显式） | Codex 同款取舍；缓解 = 批 2 缓存使命中即全量；根除 = face 相位后移（request.tools 改 resolver）或恒定入口工具，均列 backlog 不入本批 |
| 缓存陈旧 schema | boot 面暂用旧值，对账修正后下一 run 收敛；执行期 validateInvoke 对旧 schema 调用报可读错误 | Claude Code discovery cache 同语义 |
| 承诺面外新发现工具 | 经对账进注册面（run 边界生效）；行级授权语义不变（装载 = 授权 A7），denials 照常生效 | 授权轴与发现轴正交，本计划不动授权 |
| O3 恒定入口工具 / O5 face 相位后移 | 不入本批 | O3 粒度退化与 rows 白名单词汇冲突；O5 收益仅剩冷启动盲窗，不值得改 run 契约 |

## 五、实施注意（给新会话）

- **时序红线**：批 1 改动 2 的 boot 同步注册发生在行 apply 内——确认 inject 声明含 tools（host-face-client 现声明已含），注册即 fiber 归属，卸载自动回收。
- **快照重算通道**：改动 8 走既有 ③ 分支（materializeSections 重物化 + writePrefixSnapshot），不新开重算路径；重算后 fingerprint 用 nextFp 整体替换。
- **批 1 先行收口再启批 2**：批 2 的契约收口（改动 10）依赖批 1 的 host-face 形态落定；两批可不同会话实施，CR 复用 cr-1114（同变更面，批间续写 cr/logs/cr-1114.md）。
- **装载行源码生效**：批 1 涉及壳侧装载行（shell.yml 点名的 ac-host-face-client / ac-shell-rows / ac-shell-conversation）——验证时 restart_shell；ac-host-face（宿主侧）改动 restart_host。测试全绿不等于运行时已生效。
- 装配终检 / fail-loud 语义全量保持：boot 同步注册失败 = 行装配失败（fail-loud），不留半激活面。

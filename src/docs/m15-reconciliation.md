# M15 对账报告：src 能力全景 ↔ preview 逐项功能对照

> 生成于 2026-08-22（M15 收官）。六轴并行对账（工具清单 / 事件面 / 配置面 /
> 会话记录粒度 / usage 持久聚合回读 / 群会话归档与持久化）+ M14 缩水件评估，
> 每轴逐文件核对两侧源码后合成。本文是切换策略的决策依据：
> **哪些补了、哪些显式缩水、为什么**。

## 一、对账总览

| 轴 | 结论 |
|---|---|
| 工具清单 | src 29 个静态工具：17 高质量对齐（多处良性增强）；本轮补 timer 工具面 + 参数/门禁/目标校验五处修正；剩余差异 = 两轨数据模型投影（见 §3） |
| 事件面 | preview 38 事件是 src 总线（20 具名 + 1 回调）的**严格超集**，新增 8 个 waterfall 拦截面；真实缺口集中在传输接线层（WS RPC 业务方法零注册等，归 M7 可视化） |
| 配置面 | per-Agent hooks[具名] 8 行形状平移完整（capabilities/override 为新增强）；缺口集中在全局层（config.json 消费者 / LLM 池 / ${VAR}），本轮收编 tools 对象形态 + llmParams 采样面 |
| 会话记录粒度 | preview = 对话级事实源（有意决策）；src 1v1 = 全量轨迹（含思考/工具对）。**显式接受缩水**（理由见 §4.1） |
| usage 回读 | src 读写闭环 vs preview 只写不读 → **本轮补齐**（boot 回读 jsonl 重建聚合 + byDay + conversationId 入账） |
| 群会话归档/持久化 | src 双轨（本体+周归档）+ 轮转 vs preview 纯内存 → **本轮补齐**（ac-group 文件后端 + 本体轮转 + historyFor 视角回放 + send 传 history 种子） |

## 二、本轮实施清单（全部已落地，495/495 测试绿）

| # | 项 | 形态 | 关键点 |
|---|---|---|---|
| 1 | **usage 持久聚合回读** | ac-usage 增强 | 构造期回读全部 usage-*.jsonl 重建 byAgent/byModel/byDay（损坏行宽容跳过）；流水行新增 conversationId（byPair 维度数据基础）；不引入 src 式快照缓存（SNAPSHOT_VERSION 演进成本 > 单机全量回读收益） |
| 2 | **timer 工具面** | 新行 ac-timer-tools | src 单一 timer 工具 + action 三分（set/list/disable）原样平移；owner = 执行身份 call.agentId；服务链路（5 模式/持久化/触发）M12 已备，补的是 LLM 入口 |
| 3 | **job 完成唤醒 owner** | 新行 ac-job-wakeup | src boot 插件 onJobDone 双通道之② 的 preview 形态：job/settled → conversation.deliver(sender:'event') 通知 owner（串行化门/链跑/MAX_AUTO_WAKES 全由会话状态机承担）；与 ws-bridge（前端通道）同事件两订阅方 |
| 4 | **群持久化** | ac-group 文件后端 | 行配置 root 给定即启用：<root>/groups/<gid>/group.json（成员表原子写）+ messages.jsonl（本体 append）+ archive/（轮转分段 history_N.jsonl + 机械摘要 summary_N.md——src maybeArchiveBody 语义原样，阈值 500k/保留 30k）；boot 全量回内存（GroupFeed 零改动）；**historyFor(gid, viewer)** 视角回放（peer <msg>/own 原文/相邻 peer 合并/尾部 30k 截断/摘要头注入）+ send 投递传 history 种子（重启后首跑恢复群上下文；运行中会话有内存视图则零开销） |
| 5 | **待投持久化** | ac-conversation 增强 | src pending-resume 最小闭环：next-turn 入队即落盘 pending-<handle>.jsonl（先记账后受理）；消费重写；boot 回放恢复（崩溃/42 重启待投不丢）。进行中 run 的消息归 ac-session 账（职责分离） |
| 6 | **tools include/exclude** | ac-agents 契约收编 | AgentConfig.tools 支持 `{include?, exclude?}`（exclude = 增量停用；同给 = include 减 exclude）；`resolveToolNames` 统一解析（router 信封构建 + list_tools 生效集展示 + ac-archive 整理 run 共用）；loop 契约不变（信封仍 string[]） |
| 7 | **llmParams 采样面** | ac-agents + loop + router | src LLMConfig 的 per-Agent 调参收编：AgentConfig.llmParams（白名单键 temperature/max_tokens/top_p/response_format/stop/reasoning_effort/thinking/logprobs/top_logprobs/tool_choice——`filterLlmParams` 过滤，不可覆盖 model/messages/tools 保留键）→ LoopRunRequest.llmParams → 每步 llm.chat 透传 |
| 8 | **归档写记忆联动** | ac-memory + ac-archive | src"整理 run 重写 memory.md"的 preview 形态：memory_append 工具（append 累积写不做全量重写——误改写不至清空；ctx.inject(['tools']) 可选注册）；整理 run 提示词联动（tools 生效集含 memory_append 才给指令） |
| 9 | **agents.reassign** | ac-agents API | 数据驱动覆盖注册（不挂 fiber effect）——修 M15 勘误：update_agent_profile 用 register 覆盖会把注册归属到 collab-tools 行 fiber，行卸载连原始注册一并删除 |
| 10 | **system_restart 宿主半边** | ac-restart | 修 M15 勘误（中断链断在宿主半边）：订阅 loop/after-run 消费 toolInterrupt → root fiber dispose（优雅关闭）→ exit(42)（supervisor 主动重拉） |
| 11 | **插件工具门禁修正** | ac-plugin-registry | register_plugin/unregister_plugin requires 'dev'→'admin'（动态 import 任意代码进进程 = admin 边界，src CAPABILITY_ADMIN 语义；'dev' 属门禁降级） |
| 12 | **send_agent 目标校验** | ac-collab-tools | virtual Agent 目标拒绝（src 拒绝预设 Agent 的防幽灵会话语义）。（M18 修订：virtual 目标改为放行 + 引导——投递进发送方 1v1 桶、明示"无自动回复"；预设 Agent 目标仍拒绝） |
| 13 | **杂项参数收敛** | web-tools / dev-tools | web_search schema 收敛回 src 2026-08-20 正典（仅 query+description；execute 层仍兼容全参数）；reload_modules 兼容 src 参数名（files[]/reason） |

组合根双表已同步（timer-tools/job-wakeup 两行）；根 package.json 与 ac-app 依赖已显式声明新包。

## 三、显式接受的缩水（长期语义差，非待办）

| 项 | 现状 | 理由 |
|---|---|---|
| 会话记录粒度 | 对话级（user/assistant 正文 + 群 name 标注 + 概要头） | 有意决策（与 ac-conversation 上下文视图一致）；工具对入账需配套回放协议（孤立 tool 行会被 LLM API 拒绝——须完整 assistant.tool_calls + tool 对）与预算控制，膨胀/噪音代价大于复盘收益。ac-archive-core 的 safeSplitIdx 工具对保护已标注为前向防御（粒度升级零改动生效）。审计需求由 ac-dev-tools 日志环缓冲覆盖 |
| per-target 印象 | 记忆键 = conversationId（1v1 缺省 agentId、群 = 组 id），agent⇄agent 会话落目标 1v1 桶 | 键模型级差异：src chatDialogKey(self,target) 成对键与规约 2（conversationId 寻址不变量）冲突；引入成对键会波及 session/memory/conversation 三域。协作回路靠 send_agent(wait=true) 的即时回复补偿 |
| 群记忆单桶 | 群桶记忆全成员共享注入 | 同上键模型决策；src 每成员独立记忆与"群 = 共享会话流"的单通道 v3 设计不兼容 |
| read_agent_info 无 name/tags 字段 | preview AgentConfig 无这些字段（description 承担展示） | 无 UI 消费面；tags 能力语义已由 hooks['security'].capabilities 承担（更严格——AND 门禁执行） |
| boot 五层组合栈 | 单层 cordis.yml + 运行时 include patches | preview 形态决策（yml = 唯一出厂数据；安装态归 registry.json 永不写回）。用户层/机器层覆盖如有需求由 include patches 生态承担 |
| 全局 config.json | ac-config 服务在、暂无消费行 | M10 预留的订阅刷新基础设施（config/changed 事件）；有全局配置需求时各消费行接入即可，不预先造配置面 |
| LLM 池（llmProviders/$ref） | AgentConfig.provider/model 直连 | 池抽象（共享池条目/default 语义）延迟到有多模型管理的实际需求；采样参数已收编（#7） |
| ${VAR} 展开（LLM 配置） | llm 薄行 env 兜底（OPENAI/GLM/DEEPSEEK_API_KEY） | env 兜底覆盖主场景；ac-mcp-core 已有 ${VAR} 展开纯函数可复用 |
| ac-plugin-market | 未做 | staging 人审管（哈希/只读代理/权限快照）已平移信任边界；手动 stage 可跑生产，市场拉取（github/tarball 源）按需再做 |
| ac-agent-admin | 未做（管理面 HTTP CRUD） | 会话内修改面 update_agent_profile 已覆盖（reassign 修正后落盘+内存一致）；HTTP 管理面归 M7 可视化一并 |
| WS RPC 业务方法 | 传输设施完备（rpc/call 显式注册 + requestId 幂等）、零业务注册 | 前端未接入（M7）；届时按消费者注册（chat.send/agent.list/history 等），避免预先注册无消费者的面 |
| 工具流式增量事件 | bash onProgress 回调挂 call（谁提供谁消费） | 事件化（chat.tool_execution.update 对应物）归 M7 UI 接入时定形态 |
| reload 中断的宿主半边 | dev-tools reload 上报 interrupt、无消费行 | reload 语义 = include.refresh 热重组合，宿主在 boot 路径（hmr 行启用场景联调，M13 已挂账） |

## 四、preview 相对 src 的净增强（反向差异）

1. **事件目录超集**：38 事件 + 8 waterfall 拦截面（src 回调钩子全部事件化，可 veto/可变换）
2. **1v1 概要头注入**：ac-session history() 回放自动注入 summary.md（src 群有、1v1 无）
3. **注册即归属**：全部注册中心 fiber 归属（src PluginHost owner 手工回收删除）
4. **requestId 幂等去重**：传输层内置 deduped（src #53/#91 重连 flush 重复持久化教训原样继承）
5. **usage 双轨进契约**：覆盖/累加口径类型化（src accumulateUsage 隐式约定）
6. **write-ahead 交互**：ask_questions 落盘时序 + late-reply sender:'event' 唤醒
7. **会话键不变量**：conversationId 寻址全链一致（src 三次串台 bug 的架构性消灭；chat~lo~hi 排序魔法删除）
8. **MCP 撞名前缀**：`server__tool` 命名空间消歧（src 原名注入多 server 重名互覆盖）
9. **群持久化的 viewer 回放**：historyFor 与 readSince/hint 共用 wrapGroupMsg 唯一构造点（src 四次消息重复事故教训的结构化继承）

## 五、切换策略结论

preview 已具备替代 src 跑生产的**功能完备性基线**：核心运行时（L1-L3）、工具面
（28 工具 + MCP 动态桥）、持久化基座（会话/Agent/凭据/配置/usage/群/待投）、
服务编排（归档/定时/备份/工作区）、宿主传输（HTTP/WS/RPC/插件域/supervisor）
全部落地且互相咬合。剩余缩水项均有显式理由与补偿路径（§三）。

**建议切换路径**：新工作区直接用 preview 起步（数据根全新）；存量 src 工作区
迁移按需写一次性导入脚本（会话 jsonl 行格式兼容——SessionRecord 是 src
toPersisted 的结构子集；Agent config 差异字段在 §三 有映射）。切换的最后一公里
是 M7 可视化（WS RPC 业务方法注册 + 前端），那是接入工程而非能力缺口。

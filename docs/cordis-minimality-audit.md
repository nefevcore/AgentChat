# AgentChat preview 拆分粒度验证：插件是否已是最小模块

> 日期：2026-08-14 · 状态：验证结论（基于代码实测）
>
> 方法：对 18 个 `@agentchat/*` 包逐一检查——① 内部职责聚合度（是否单一职责）；② 是否有清晰可拆子域 + 独立复用点；③ 包间依赖是否单向无环。判定等级：**原子**（不可再拆）/ **可拆（收益待评估）** / **可收敛**。

---

## 0. TL;DR

- **14 个包为原子模块**（不可再拆或拆分无收益）：util / protocol / llm / agent-loop / agents / router / boot / timer / subagent / archive / backup / hello（+ plugins 收敛后 / server 服务化后）。
- **2 个包存在清晰可拆子域**（是否拆取决于复用需求）：**tools**（edit 引擎 13 文件 1510 行独立子域 + web-search 5 provider）、**ext**（8 个 hooks 分属 4 个扩展域）。
- **2 个包可收敛**：**plugins**（PluginRegistry 彻底移除后仅剩元数据）、**server**（传输层与门面可拆，但门面已 ctx 服务化，拆分非必需）。
- **关键结论**：**插件级拆分已全部达成**——28 个工具、12 个钩子、5 个服务全部以 cordis 插件/服务独立注册（独立生命周期、可独立装卸）；包级聚合是"发布单元"的选择，非"运行单元"。"最小模块"问题应分两层看：**运行层已最小，发布层仅 tools/ext 有可选拆分空间**。

---

## 1. 包间依赖图（单向分层验证）

```
依赖根：util（零依赖）、protocol（零依赖）
  ↑
llm（→ util）
  ↑
agent-loop（→ llm, util）
  ↑
agents（→ agent-loop, llm, util）   router（→ agent-loop, agents, llm, util）
  ↑                                 ↑
tools（→ agent-loop, agents, llm, router, util）
  ↑
ext（→ agent-loop, agents, llm, tools, util）   timer（→ agents, router, tools）   subagent（→ agents, llm, tools）
  ↑
archive（→ agents, ext, llm, protocol, tools）   backup（→ tools）
  ↑
server（聚合 11 包）   plugins（元数据聚合）   boot（装配根，聚合 12 包）
```

✅ **单向无环**；每个包的依赖都是其职责所需的最小集（如 timer 依赖 router 仅为类型 `AgentRouter`）。

---

## 2. 逐包判定

### 2.1 原子包（14 个）

| 包 | 规模 | 职责 | 判定依据 |
|---|---|---|---|
| `util` | 3 文件 166 行 | logger + supervisor（横切） | 两个极小横切工具；拆包徒增依赖管理，无收益 |
| `protocol` | 1 文件 87 行 | 跨端类型契约 | 纯类型，单一职责 |
| `llm` | 7 文件 1054 行 | LLM 契约 + 流式抽象 + openai/deepseek 适配器 | deepseek 继承 openai（强内聚）；适配器拆包需接口包+实现包间接层，收益低。*文件级*：openai.ts 526 行可再分（非包粒度） |
| `agent-loop` | 6 文件 877 行 | ReAct 引擎（loop/context/interrupt/hash） | 引擎原子，无外部独立复用点 |
| `agents` | 7 文件 682 行 | AgentConfig 契约 + 合并 + 注册表 + 凭据 + paths | 全部属"Agent 配置域"；凭据加密虽为 infra 但小（无独立发布需求） |
| `router` | 4 文件 987 行 | 消息路由 + 群组 + 虚拟 Agent | 调度域强内聚；router.ts 723 行为*文件级*问题 |
| `boot` | 8 文件 1494 行 | 装配（bootstrap/loader/plugin/register-core/shutdown/supervisor/llm-schemas） | 装配层各文件单一职责，聚合是设计（DSH 同款 app-boot） |
| `timer` | 7 文件 1117 行 | TimerManager（915 行）+ timer 工具 | 单一服务强内聚；大文件为*文件级* |
| `subagent` | 6 文件 449 行 | SubAgentManager + subagent 工具 | 单一服务 |
| `archive` | 1 文件 876 行 | ArchiveService + 消息预算函数 | 单一职责；876 行单文件为*文件级*可拆 |
| `backup` | 1 文件 119 行 | createBackup | 单一职责 |
| `hello` | 1 文件 21 行 | 链路验证插件 | 示例 |

### 2.2 可拆包（2 个，收益待评估）

| 包 | 规模 | 可拆子域 | 拆法 | 收益 vs 成本 |
|---|---|---|---|---|
| `tools` | 31 文件 4227 行 | ① **edit 引擎**（13 文件 1510 行：apply/diff/executor/hashline-*/fuzzy-match 等）② **web-search**（5 文件 357 行：brave/duckduckgo/serpapi/tavily）③ 4 工具族（files/web/session/app） | `tools-edit`（引擎独立包）→ `tools-web-search`（provider 独立包）→ `tools-core`（工具族+shared/define-tool/schema） | **收益**：edit 引擎可独立复用（未来 IDE/浏览器集成）；web-search 加 provider 不动主包；工具族独立开关。**成本**：+2~3 包、依赖调整、register 链调整。**当前状态**：目录边界已明确（`edit/`、`web-search/` 子目录）——"先单目录边界、后升包"护栏下可延后 |
| `ext` | 15 文件 2366 行 | 8 hooks 分属 4 扩展域：agent-prompt / agent-session / agent-memory / agent-mcp（+ security/redact/skills 归口） | `agent-prompt` / `agent-session` / `agent-memory` / `agent-mcp` 四包 | **收益**：独立发布/独立开关（粒度分析 §4.2 原案）。**成本**：hooks 内部耦合（run→prompt/session、skills→prompt）需处理。**当前状态**：**插件级已独立**——12 个 builtin.* 钩子全部以独立名称注册进 `ctx.hooks`（独立生命周期），包级聚合仅影响发布粒度 |

### 2.3 可收敛包（2 个）

| 包 | 现状 | 收敛方向 |
|---|---|---|
| `plugins` | 6 文件 523 行：PluginRegistry（已退场为 /api/plugins 元数据）+ builtin/math 组合 | PluginRegistry 类彻底移除后（/api/plugins 元数据改从 ctx 插件注册取），仅剩 builtin/math 的 configs 元数据——可并入 boot 或 tools/ext |
| `server` | 25 文件 4994 行：传输层（webui-server/api/ws）+ 8 门面 | 门面已 ctx 服务化（ctx.agentService 等）✓；若未来有非 HTTP 消费者（TUI/CLI），可拆 `server-transport` / `server-facades`——当前服务化已满足功能需求 |

---

## 3. 关键结论：插件级 vs 包级

| 层级 | 状态 | 说明 |
|---|---|---|
| **插件级**（cordis 运行单元） | ✅ **已最小** | 28 工具（ctx.tools 独立注册）、12 钩子（ctx.hooks 独立注册）、5 服务（ctx.* 独立 Service）——每个独立生命周期、可独立装卸/热重载 |
| **包级**（发布单元） | 🔶 14/18 已最小；tools/ext 有可选拆分空间；plugins/server 可收敛 | 包级拆分是"发布/复用"决策，非"运行"必需 |

**判定标准说明**：按粒度分析 §3.1"包就绪标准"（可插拔实现 / 独立第三方依赖 / 独立生命周期 / 独立测试域 / 跨端契约 / 对外复用），18 包中：
- 满足"独立生命周期"的（timer/subagent/server/archive/backup）✅ 已独立；
- 满足"可插拔实现"的（llm 的 openai/deepseek、web-search 的 4 provider）✅ 同包内已插拔（工厂选择），拆包仅当需要"第三方独立依赖"时（当前无）；
- 满足"独立第三方依赖"的（timer→chinese-lunar、backup→adm-zip、ext→MCP SDK）✅ 已在包内隔离（依赖不泄漏到其他包）。

---

## 4. 建议（下一步，按收益排序）

1. **不拆 tools/ext**（除非出现真实复用需求）——目录边界已明确、插件级已独立；YAGNI。
2. **plugins 收敛**：PluginRegistry 彻底移除（/api/plugins 元数据改从 `ctx.tools`/`ctx.hooks` 注册目录 + 各包导出的 configs Schema 收集），plugins 包缩为"builtin/math 元数据"或并入 boot。
3. **文件级拆分**（可选、非包粒度）：tools 的 edit/tool.ts、server 的 api/usage.ts、timer 的 timer.ts、archive 单文件——按职责继续分文件，降低单文件认知负担。
4. **server transport/facades 拆分**：仅在出现 TUI/CLI/桌面端独立消费门面（不经 HTTP）时执行。

---

## 5. 附：包间依赖明细（验证数据）

| 包 | 依赖 |
|---|---|
| util / protocol / hello | 无 |
| llm | util |
| agent-loop | llm, util |
| agents | agent-loop, llm, util |
| router | agent-loop, agents, llm, util |
| tools | agent-loop, agents, llm, router, util |
| ext | agent-loop, agents, llm, tools, util |
| timer | agent-loop, agents, router, tools, util |
| subagent | agent-loop, agents, llm, tools, util |
| archive | agent-loop, agents, ext, llm, protocol, tools, util |
| backup | tools, util |
| plugins | agent-loop, agents, ext, llm, router, subagent, timer, tools |
| server | 11 包（聚合门面+传输） |
| boot | 12 包（装配根） |

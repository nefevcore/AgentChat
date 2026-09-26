# 插件轨道：行型 / 门控 / 动态插件 / 测试

> 读条件：写任何出厂插件行或动态插件时。
> 行是插头不是 orchestrator：inject 声明依赖 → apply 里贡献（工具 / provider / Agent）或接线（订阅 / 拦截）→ 结束。没有 dispose 代码，没有启动顺序假设。

## 包脚手架与挂载

所有行型均为 `src/ac-<name>/` 包，脚手架照抄 `ac-hello`：

- `type: module`；`exports` 指向 `src`。
- `@agentchat/cordis` 进 dependencies；所 inject 的服务包、所监听事件的 owning 包进 devDependencies。
- 仓库根 `pnpm install`。

**挂载两处缺一不可**：`cordis.yml`（带 id）+ `ac-app` TREE 同 id 行。

## 六种行型

| 行型 | inject | 核心调用 |
|---|---|---|
| 工具行 | tools | `ctx.tools.register({ name, description, parameters, requiredTags, execute })` |
| provider 行 | llm | 新协议：`ctx.llm.register(name, factory, opts)`；OpenAI 兼容平台零代码（见下） |
| 拦截 / 策略行 | 通常零 | `ctx.on('tool/before-execute', (exec, next) => { ...; return next(); })` |
| 订阅者行 | 零 | `ctx.on('router/message-received', ...)` / `router/reply-completed` |
| 预设 Agent 行 | agents | `ctx.agents.register({ id, model: 'provider@model', system, tools, tags, settings })` |
| 前端行 | webui | 宿主半边 `ctx.webui.declareClient({ name, entry, platform, phase })`；client 半边 `clientPlugin` + `ctx.slots.register(席位)` |

### 工具行

注册参数四轴：

- **requiredTags（能力轴）**：多标签 AND 语义；缺标签 = 工具对该 Agent 不可见，非执行期 veto。出厂工具必须声明；词表查 RESERVED；档位词永不进。
- **needPermission（权限轴）**：文件写 / 命令执行 / 非 LLM 出口 = true；与能力轴正交。
- **injection 'mode'（模式合成入口）**：必须不挂 tags。
- **requiresInteraction（挂起等应答）**：self 无人值守自动排除。

其他：ToolResult 抛错自动收敛；进度上报 `call.onProgress`。字段全清单见 `ac-tools/src/contract.ts`。

### provider 行

- OpenAI 兼容平台**不写代码**：`config.json` 的 llmProviders 域加连接，引用 name@model。
- 新协议才 `ctx.llm.register(name, factory, opts)`：协议实现住纯库（换 baseUrl 复用）；工厂懒实例化，卸载自动 close。

### 拦截 / 策略行

- 改写 = 变异载体；只观察必须 return next()（忘调 = 静默吞掉下游默认行为）。
- 顺序无关：waterfall 序 = 注册序、不可配 → 注入式拦截须自证任意顺序收敛。
- `ctx.on(ev, fn, { description })` 自述进治理 UI。
- 常用落点：`router/before-deliver`（信封改写 / veto）、`llm/before-chat`（改 `call.input.model` 换 provider）、`loop/transform-run`（事后变换）。

### 订阅者行

- 适用形态：历史 / 审计 / 指标 / 广播。
- 投递：`ctx.conversation.deliver(agentId, inbound, { sender, source, conversationId, lane, placement })`。
- 回放：`ctx.session.records(conversationId)`。
- 累积结果要暴露 → 升级只读服务（ctx.<key> + 消费方 inject）。
- 参照：`ac-session` 是该形态的完整演进（订阅积累 + writer 队列 + journal/settlement 持久化，1200+ 行重服务包）——看形态学结构，勿整体照抄。

### 预设 Agent 行

- **tags = 钥匙圈、include = 围栏**：tools 条目支持 `tag:<x>` 反向展开——点名不解锁，能力面仍由 tags 裁决。
- 含档位词时，tags 兼作档位单源。
- settings[具名] 键 = 行入口 extension.name（≠ 行名）。
- AgentConfig 全字段见 `ac-agents/src/service.ts`。

### 前端行

- 独立包 `ac-client-ui-<name>`（包名即身份），与后端行双向可摘除。
- 只经 `ctx.rpc` 契约面耦合，不 import webui 内部。
- 贡献面 = slot 席位：卸载即消失，RPC 失败静默空态。
- 类型身份不 augment 服务端 Context（防撞型）。
- 用基建 `ac-client-slots` / `ac-client-runtime`，别自造装载通道。

## 可配置行三层

1. **Schemastery Config**：loader 先校验填默认；非法 = 行 FAILED；普通对象无效。
2. **入口自述**：`export const extension: ExtensionMeta`（ac-extension-core），字段 `{ name, label, description, automatic?, fields?, listeners? }`——name 是 settings 键锚点。
3. **全局配置**：`settings.<域>.<键>`；订阅 `config/changed` 热更，非法值 warn 并保持现状。

## per-Agent 配置与门控

- 读配置一律 `ctx.agents.settingsOf(id, '<名>')`：全局默认层 ∪ 差异层——对象递归合并、数组整体替换、差异层优先。直读差异层只用于写侧 / 展示。
- enabled 是约定键，插件须自查；未声明 respectsEnabled 即按未自查处理。
- 门控用 `agentGate(..., { facet })`（ac-gate-core + owning 包读取器，如 agentOfRunRequest）：停用自动 return next() / 跳过；无身份 fail-open；只对 run 域事件存在。
- facet 是行为切面不是事件名：一个插件多事件细分启停用 facet；事件名键只住进程级停用集 `events.disabled`。
- ac-event-policy 可按 owner::event 进程级停用（注册期吞掉、boot 末清扫、热更只影响后续注册）——别假设监听器恒在。

## 动态插件（Agent 自开发）

生命周期四步：

1. 开发：数据根 `files/<agentId>/<name>/` 放 manifest + 入口；模板在 `src/templates/`。
2. 试跑：`register_plugin`（会话级，重启即失）。
3. 定型：`install_plugin`（免审 stage → 批准 → 装载，重启恢复）。
4. 回滚：`unregister_plugin`（代码回滚进备份，副作用不回滚）。

manifest 纪律：

- 必填 name / version；命名 `<agentId>-<名>`；保留字表见 ac-plugin-core。
- 内容变必 bump version（同 name + version 且内容一致时幂等）。
- **无热重载**。

护栏层次：

- **机械护栏只有保留字**。
- 「不 provide 新服务、不自授 tags、不注册他人 Agent、不 emit loop/*」（越权会 usage 双记账）是**自律规约**。

工具与分发：

- 工具默认私有：requiredTags 注入 `agent:<ownerId>`；共享 = 在他人 tags 中加该标签。
- 共享输出强制 tool-output 包裹；description 禁指令式措辞。
- 宿主防线：审计日志、连续失败熔断、hash 复验、安全模式跳装载；第三方分发走人审。

## 测试模式（照 `ac-llm/tests`）

- mock 就地造行 `{ name, inject, apply }`。
- boot：`new Context()` → 逐行 `ctx.plugin(row)` → **await fiber**（inject 未满足会挂起）。
- afterEach 逐 fiber `dispose()`（uid !== null 判已卸载）；回收断言用卸载后探测。
- 测试内相对导入不带 .ts（vitest 解析）。
- 资源敏感用例的超时按 **CI 慢机口径**定——本地快机过 ≠ CI 并发挤压下过。

## 精简判例（插件行常见违规形态）

- **单实现抽象**：为「将来第二个 provider / 策略」预留的工厂或接口层——没有第二调用方就内联；薄行只留 inject + register 胶水（纯库归纯库，胶水归胶水）。
- **解说式膨胀**：注释每轮重述同一设计（「本函数调用 xx，xx 会 yy」）——设计沿革归 `src/docs/`；代码注释只记不读代码看不出来的 why 与红线背景。
- **死代码求证后删**：判死须全仓 grep（含 tests/——测试引用的导出是活口）；删后跑定向测试。
- **重复实现并源**：两处相似逻辑 → 抽到 owning 包（服务方法 / 纯库），消费方 type-import——并源归位本身就是插槽-插头纪律，别在消费方各存一份。
- **包装层回收**：一行转发的 wrapper 函数、只做改名 re-export 的中间模块——内联或直连。

## 插件反模式

- 出厂工具不声明 requiredTags；新标签词不查 RESERVED 词表（防漂移）。
- 为 OpenAI 兼容平台手写 provider 薄行（配 llmProviders 即可）。
- per-Agent 配置直读差异层散落；用事件名做配置键。
- 用 waterfall 做纯广播，或在 emit 上期望返回值。
- 动态插件撞保留字；不改 version 重装；手改已装目录。

---
name: agentchat-plugin-dev
description: 开发 AgentChat 插件（src/ 轨道的 ac-* 出厂薄行与 Agent 自开发动态插件）：工具行、LLM provider 行、策略/拦截行、订阅者行、预设 Agent 行——inject 已有服务、注册贡献、订阅或拦截事件。
whenToUse: 在 src/ 下新建或修改一个消费已有能力域的出厂插件行，或为 Agent 编写运行时自安装的动态插件（manifest + 入口）时使用。若要新增能力域服务、修改事件目录或注册中心本身，改用 agentchat-framework-dev 技能。
---

# AgentChat 插件开发

## 心法：薄行思维

插件行（row）是**插头，不是 orchestrator**。它做且只做三类事：

1. `inject` 声明依赖的服务 → 拿到就绪保证；
2. 在 `apply` 里向注册中心**贡献**（工具/provider/Agent）或**接线**（订阅/拦截）；
3. 结束。没有 dispose 代码、没有清理逻辑、没有启动顺序假设。

生命周期全部由 cordis 承担：**注册即归属、订阅即归属**——行被卸载（配置
变更/热重载/服务消失）时，你的注册和监听自动回收。你写不出内存泄漏，
前提是你不绕过注册中心 API 自己保存全局状态。

## 动笔前先读（事实源）

| 要读 | 文件 |
|---|---|
| 全域能力地图（契约归属总表 + 端到端链路 + 装载态） | `src/README.md` |
| 事件目录（能订阅/拦截什么，`@mode`/`@scope` 与姿势；谁 emit 谁声明，住在 owning 包） | `src/ac-llm/src/events.ts`、`src/ac-tools/src/events.ts`、`src/ac-agent-loop/src/events.ts`、`src/ac-router/src/events.ts`（另有 conversation/group/config/jobs/archive/plugin 等 10+ 域，全量见 README 总表） |
| 域类型（参数/载体/结果形状） | `src/ac-llm/src/contract.ts`、`src/ac-tools/src/contract.ts`、`src/ac-agent-loop/src/contract.ts`、`src/ac-agents/src/service.ts`（AgentConfig） |
| 工具行最小范例 | `src/ac-hello/src/index.ts` |
| 拦截/注入行范例（before-run waterfall） | `src/ac-persona/src/index.ts`、`src/ac-memory/src/index.ts` |
| 事件订阅服务范例（emit 积累 + 回放） | `src/ac-session/src/index.ts` |
| 测试范例（脚本化 row + boot/dispose 脚手架） | `src/ac-llm/tests/router.test.ts` |
| 动态插件模板（工具/provider/事件三骨架 + 规约） | `src/templates/{tool-row,provider-row,event-row}/` |

## 两个开发面

- **出厂行**：`src/ac-<name>/` 包，进 `cordis.yml` + TREE，随宿主 boot 装载
  ——本文主体讲它。
- **动态插件**：Agent 运行时自开发/自安装（manifest + 入口，不走包脚手架）
  ——见「Agent 自开发动态插件」专节，骨架照 `src/templates/` 抄。

## 五种行型（出厂行）

### 1. 工具行（inject `tools`，注册工具）

```ts
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-tools';   // ctx.tools 服务 + tool/* 事件目录类型增强（type-only）

export const name = 'ac-my-tools';
export const inject = ['tools'];      // ctx.tools 就绪保证

export function apply(ctx: Context) {
  ctx.tools.register({
    name: 'my-tool',
    description: '一句话说明（进入模型可见的 schema）',
    parameters: {                      // JSON Schema
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    execute: (args) => ({ ok: true, output: `echo: ${String(args.message ?? '')}` }),
  });
}
```

- `ToolResult = { ok, output?, error?, interrupt? }`；工具体抛错会被 ac-tools
  收敛为 `{ ok: false, error }`，不必自己 try/catch。
- `interrupt` 是语义化中断通道（宿主级行为如 reload/restart/插件装卸经它
  上报，loop 收束后宿主执行）。
- `requiredTags: string[]` 声明能力门禁（AND 语义，对照调用方有效能力集
  `{'base', 'agent:<id>'} ∪ tags ∪ settings.security.capabilities`）——缺
  标签的工具对调用方**不可见**（不只执行时 veto）。
- 重名注册直接抛错——别想着覆盖。
- 工具需要流式进度时用 `call.onProgress(chunk)`（服务端转 emit
  `tool/progress`，不必自己发事件）。

### 2. LLM provider 接入

**OpenAI 兼容平台不写代码**：在 config.json 的 `llmProviders` 域加一条
Provider 连接（ac-llm-pool 配置驱动注册，base_url + defaultModel；模型清单
经 `/models` 发现缓存），引用语法 `name@model`（如 `deepseek@deepseek-v4-pro`）。
连接池是唯一事实源——未配置即不注册。

手写注册面（动态插件 provider-row 模板 / 新协议接入）：

```ts
export const inject = ['llm'];

export function apply(ctx: Context) {
  ctx.llm.register('myprov', () => new OpenAICompletions({ /* … */ }), {
    models: ['my-model-1'],            // model 路由清单：精确 > 前缀
    description: '…',
  });
}
```

协议实现住纯库（如 `ac-openai-completions`），薄行只留工厂注册 + Config
胶水——OpenAI 兼容的新平台复用纯库换 baseUrl，**不要新写协议**。懒实例化：
工厂首次 stream/chat 才被调用；行卸载时已实例化的 provider 自动 `close?.()`。
非 OpenAI 兼容协议（Anthropic/Gemini/Ollama 原生）尚未接入——协议扩展面
备忘见 `src/docs/llm-protocol-extensibility.md`。

### 3. 策略/拦截行（waterfall 监听，通常零 inject）

拦截不需要 inject 服务——事件挂在 ctx 上，无人分发时监听器自然静默。
本 cordis 的 `next()` **不带参数**，改写输入 = 变异载体后 `return next()`：

```ts
export function apply(ctx: Context) {
  // veto：不调 next()，自返回结果——工具体不会执行
  ctx.on('tool/before-execute', (execution, next) => {
    if (blockedNames.includes(execution.call.name)) {
      return { ok: false, error: 'blocked by policy' };
    }
    // 改写参数：变异载体再委托（保留执行身份 agentId/conversationId/toolCallId
    // ——沙箱与定向 checkpoint 依赖它们）
    execution.call = { ...execution.call, args: sanitize(execution.call.args) };
    return next();
  });

  // 改写模型路由：路由发生在拦截之后，改 input.model 即换 provider
  ctx.on('llm/before-chat', (call, next) => {
    call.input = { ...call.input, model: 'glm-5.3' };
    return next();
  });

  // 事后变换（安全审查/脱敏）：步记录与轮结果的 transform-* waterfall
  ctx.on('loop/transform-run', (payload, next) => {
    payload.result = { ...payload.result, text: redact(payload.result.text) };
    return next();
  });
}
```

事件族模式：`before-*`（决策/改写）→ 主体 → `transform-*`（塑造记录；
tool 域有 transform-result，loop 域有 transform-step/transform-run）→
`after-*`（emit 纯通知，收到的是变换后终值）。安全审查类插件落
transform-*，观察/持久化类插件落 after-*。

**顺序无关收敛规约**（waterfall 执行序 = 监听器注册序，不可配置）：向
`request.system` 注入内容的插件必须声明自己的位置语义并独立成立——"前置"
（如 persona 的 `<persona>` 块）或"追加"（记忆块/日期行），任意注册顺序都
收敛到同一结构。禁止依赖"我会先于/后于另一插件执行"。

**铁律：只观察/标注的监听器必须 `return next()`**。忘了调 = 静默吞掉下游
全部默认行为（工具不执行、模型不调用）。veto 是有意为之的设计动作。
包裹观察姿势：`const result = await next(); …; return result`。

监听器可带注册自述（事件目录/治理 UI 的展示面）：
`ctx.on('tool/after-execute', fn, { description: '…' })`。

### 4. 订阅者行（emit 监听，零 inject，零注册）

历史/审计/指标/WS 广播的形态。与产生方的**唯一**联系是事件：

```ts
export function apply(ctx: Context) {
  ctx.on('router/message-received', (agentId, message, conversationId, sender, source) => { /* … */ });
  ctx.on('router/reply-completed', (agentId, text, result, conversationId) => { /* … */ });
}
```

会话拓扑：一切双端会话都是对桶 `conversationId = pairKey(a, b)`（自会话 =
`a~a`；群 = 组 id）；`sender` = 发送方端点 id，`source` = `'user'|'agent'|'event'`
拓扑词。投递入口走 `ctx.conversation.deliver(agentId, msg, { sender, source,
conversationId, … })`（会话状态机：忙时 steer/排队/链跑）；router 是纯转发
零会话状态。会话积累/回放用 ac-session 的 `ctx.session`（按 conversationId
分桶）。要暴露累积结果给他人时，升级为只读服务（提供 ctx.<key> 查询方法）。

### 5. 预设 Agent 行（inject `agents`，注册数据）

Agent 是**数据**不是插件，一行可注册多个：

```ts
export const inject = ['agents'];
export function apply(ctx: Context) {
  ctx.agents.register({
    id: 'helper', model: 'deepseek@deepseek-v4-pro',   // name@model 引用（也可裸名+provider）
    system: '系统提示词', tools: ['hello'], maxSteps: 8,
    tags: ['fs_minimal'],                // 能力标签（工具 requiredTags 判定词表）
    settings: { persona: '你是海盗' },    // settings[具名]：已装扩展插件在本 Agent 的配置
  });
}
```

`AgentConfig` 字段见 `ac-agents/src/service.ts`（owning 包）：`model`（name@model
引用或裸名+provider；未声明时回落全局默认连接）、`tools`（白名单或
`{include?, exclude?}`）、`llmParams`（采样参数白名单透传）、`maxSteps`、
`tags`、`settings` 等。**settings[具名]**：键 = 稳定单元名（行名 / 动态插件
manifest.name），值 = 插件自定配置——行组合决定装哪些插件，settings 决定
已装插件在该 Agent 上的行为，核心配置不为扩展插件设专属字段。运行期动态
注册时留存返回的 disposer 手动撤；插件行内注册则永远不用碰它。

## per-Agent 配置与门控（现状 API）

- **读配置一律 `ctx.agents.settingsOf(id, '<名>')`**：自动合成全局默认层
  （config.json `settings` 域）∪ Agent 差异层（对象递归、数组整体替换、
  差异层键优先）；preset/未知 id 回落全局层。直读差异层（写侧/展示）用
  `ctx.agents.get(id)?.settings`。
- **`enabled` 是约定键、插件须自查**：全局层 `enabled:false` 软停用，Agent
  差异层可覆盖回 true。不自查 enabled 的行，目录声明将标
  `respectsEnabled:false`（UI 注明"停用未必生效"）。
- **per-Agent 门控 = `agentGate`**（ac-gate-core 纯库）：

  ```ts
  import { agentGate } from 'ac-gate-core';
  import { agentOfRunRequest } from 'ac-agent-loop';   // 身份读取器住 owning 包

  ctx.on('loop/before-run', agentGate(ctx, 'my-plugin', agentOfRunRequest, (call, next) => {
    const cfg = call.request.agent ? ctx.agents.settingsOf(call.request.agent, 'my-plugin') : {};
    // …按 cfg 注入 system…
    return next();
  }));
  ```

  waterfall 停用自动 `return next()`、emit 停用自动跳过；读取器返回
  undefined（无身份场景）→ fail-open 恒放行。**门控只对 run 域事件存在**
  （判定式 = "这次分发发生在谁的执行里"；载荷带 agentId ≠ run 域——
  agents/updated/job/settled/config/changed/plugin/* 是 host 域，没有
  per-Agent 门控，设计时别假设有）。
- **一插件多 run 域事件、要细分启停 → facet 切面**：`agentGate(…, { facet:
  'redact' })` 读 `settings[名]['redact'].enabled ?? settings[名].enabled`
  （子键覆盖、回落行为级）。facet = 作者命名的稳定行为切面，**非事件名**。
  **不用事件名做 per-Agent 配置键**（事件名键只住进程级治理面
  `events.disabled`）。
- **宿主可进程级停用你的 (插件 × 事件) 监听器**（ac-event-policy：吞注册，
  监听器从未进链；吞注册 ≠ veto，其余监听器照常）。插件不得假设"我的监听器
  恒在"；承重单事件被关是宿主治理决定，不在插件侧补偿。

## Agent 自开发动态插件

出厂行之外，Agent 可在运行时自开发自安装**动态插件**——不走包脚手架，
走安装闭环。骨架照 `src/templates/{tool-row,provider-row,event-row}/` 抄：

```
① 开发   <数据根>/files/<agentId>/<name>/（manifest.json + 入口）
② 试跑   register_plugin（会话级，重启即失；授权面 = manifest 全集）
③ 定型   install_plugin（免审：stage → 自动批准 → 立即装载；
          安装态 = plugins/registry.json，重启自动恢复）
④ 回滚   uninstall_plugin removeFromLibrary:true（代码回滚——目录进
          .backup；运行时副作用不随之回滚；回执列出消费方）
```

- **回执与回触**：install/register 的结果以回执落账当前会话，随后
  `source:'event'` 回触你的自会话——直接开始测试，闭环无人值守。每轮回执/
  错误文案含下一步动作（失败 → 修复后 bump version 重装）。一轮 run 只处理
  首个装载类中断。
- **迭代语义**：同 name+version 且内容一致 → 幂等返回已装状态，不重试装载；
  有任何改动必须先 bump manifest `version`。**无热重载**（Agent 侧迭代 =
  改 → 重装）。
- **manifest 必填项**：`contracts`（宿主契约门禁）、`permissions`（免审
  快照 = 声明全集）、`provides`（对象形状
  `{tools?, llmProviders?, events?, ui?, agents?}`——装载后对账 + 保留字
  护栏）。保留字常量表 `ac-plugin-core/src/reserved.ts`（内置工具/provider/
  Agent 名撞名 = 装载可诊断拒绝）；命名规约 `<agentId>-<name>`。
- **供给面**：可注册 tools/llmProviders/Agent、可声明 manifest.ui（免审缺省
  isolated 挂载）；**不可 provide 新服务**（撞名 fail-closed）。规约：不自授
  tags、不注册他人 Agent（违反经对账进审计事件）。
- **工具默认私有**：模板 `agentTool()` helper 注入
  `requiredTags: ['agent:<ownerId>']`。共享 = 他人显式在自己的 `tags` 添加
  该标签（`settings.security.capabilities` 是追加覆盖层，只加不减）。
- **共享输出框定（模板强制）**：工具 output 一律
  `<tool-output plugin="<owner>">…</tool-output>` 包裹；description 禁指令式
  措辞（共享后 description 是他人模型可见的常驻 prompt surface）。
- **事件行铁律**：per-Agent 门控用 `agentGate` + owning 包的 agentOf* 读取器；
  不 provide agentLoop、不 emit `loop/*`（防 usage 双记账/session 错账）。
- **生命周期**：owner Agent 删除后其已装插件成无主常驻（装载着、无人能
  调用）；卸载/回滚文案统一"代码回滚"。
- **无人值守补偿控制**：全部安装/卸载/拒绝/装载入 `plugins/audit.jsonl`
  审计流水；连续装载失败 3 次熔断（boot 不再重试，复位 = bump version 重装 /
  卸载）；hash 复验（已装目录被改动 → 拒载）；安全模式
  `AGENTCHAT_SAFE_MODE=1` 或 `.safe-mode` 标记 → 跳过全部动态插件装载
  （yml 行照常）。

**第三方分发走人审**（与 Agent 自开发免审流分立）：npm/github 搜索 +
暂存人审安装流（权限快照/内容哈希/来源锚定 repo·ref·commit）。发布可被
发现 = 自标发现标记：npm 包 keywords 加 `"agentchat-plugin"`、github 仓库
挂 topic `agentchat-plugin`（opt-in 门槛——不标则市场搜不到；keyword/topic
只管发现不承载信任）。

## 新建包脚手架（出厂行）

1. 目录 `src/ac-<name>/`：`package.json` + `src/index.ts`（+ `tests/`）。
2. `package.json` 照抄同型行（如 `ac-hello`）：
   - `"type": "module"`，`exports` 指 `"./src/index.ts"`（源码直出，无构建）；
   - 运行时依赖进 `dependencies`（`@agentchat/cordis` 必带；纯库按需）；
   - 所 inject 的服务包 / 所监听事件的 owning 包进 `devDependencies`
     （type-only：`import type {} from '<pkg>'` 即拿到服务类型 + 域类型 +
     事件目录增强，没有独立的契约包）；
   - 行包声明 `"agentchat": { "plugin": true }` + `"keywords": ["agentchat"]`
     （插件目录内置组判据 + npm 发现面；纯库不加——fail-closed）。
3. 仓库根跑 `pnpm install` 建立 workspace 链接（裸包名可解析的前提）。
4. 挂载两处，缺一不可：
   - `src/cordis.yml` 加行：`- id: <稳定id>  name: 'ac-<name>'`
     （**必须带 id**：无 id 的行在 yml 每次编辑时被整体重挂）；
   - `src/ac-app/src/index.ts` 的 TREE 加同 id 行，两表行集保持一致。
5. 可配置行两件事：
   - 导出 Schemastery schema（loader 在 apply 前校验并填默认值，非法配置 =
     行 FAILED、boot 拒绝；导出普通对象无效）：

     ```ts
     import z from '@agentchat/schemastery';
     export interface Config { apiKey?: string; baseUrl?: string }
     export const Config: z<Config> = z.object({
       apiKey: z.string(), baseUrl: z.string(),
     }) as z<Config>;
     export function apply(ctx: Context, config: Config = {}) { /* … */ }
     ```

   - 入口模块自述扩展元数据（插件目录「⚙ 可配置」与事件视图的数据源）：

     ```ts
     import type { ExtensionMeta } from 'ac-extension-core';
     export const extension: ExtensionMeta = {
       name: 'ac-my-tools',           // settings 键锚点（= 行名）
       label: '我的工具', description: '…',
       fields: [{ name: 'apiKey', description: '…' }],
       listeners: [{ event: 'tool/after-execute', role: 'observer', description: '…' }],
     };
     ```
6. 验证：`pnpm typecheck && pnpm test`；端到端冒烟 `pnpm smoke` / `pnpm dev`。

## 测试模式（照 ac-llm/tests/router.test.ts）

- mock 就地造行对象（不必建包）：`{ name, inject, apply }` 字面量；
  LLM mock 用脚本化工厂（按调用序吐 chunk）。
- boot 脚手架：`new Context()` → 逐行 `ctx.plugin(row)` → **`await fiber`**
  （等待 ACTIVE，inject 未满足时会挂起——测试里要 mock 出被依赖服务）。
- 收尾 `afterEach` 逐 fiber `dispose()`（`uid !== null` 判断已卸载）。
- 断言"回收"用卸载后探测：dispose 工具行后 `ctx.tools.has('x') === false`。

## 兼容红线（Node 原生 TS strip-only 加载器）

- 包内相对导入写显式 `.ts` 扩展（`from './service.ts'`）。
- 类字段不用参数属性；`verbatimModuleSyntax` 下纯类型导入用 `import type`，
  声明合并增强用 `import type {} from '<owning 包>'`（如 'ac-tools'）——
  没有独立的契约包。
- 行序无激活语义：依赖只靠 `inject` 声明，永远不要假设"它先加载"。

## 反模式（发现即改）

- 手写清理：dispose 回调、removeListener、全局 Map 删条目——注册中心已代管。
- 跨行 import：import 另一行的实现或实例——改走服务方法或事件。
- 观察/标注型 waterfall 监听器不调 `next()`（= 静默 veto）。
- 在 emit 事件上期望返回值；用 waterfall 做纯广播。
- 探测式可选依赖写 `if (ctx.xxx)` 再注册副作用——可选能力运行时
  `ctx.get('xxx')` 探测；部分功能依赖拆成独立子行。
- 硬编码行序假设；cordis.yml 行不带 id；TREE 与 yml 行集漂移。
- per-Agent 配置直读差异层散落多处——读取一律收拢 `settingsOf`（直读
  `get(id)?.settings` 只用于写侧/展示）。
- 用事件名做 per-Agent 配置键（配置键到行为/facet 为止，事件名键只住
  治理面 events.disabled）。
- 为 OpenAI 兼容平台手写协议/provider 薄行——配置 `llmProviders` 连接即可。
- 动态插件撞保留字（内置注册名常量表）、不改 version 反复重装、自授 tags
  或注册他人 Agent。

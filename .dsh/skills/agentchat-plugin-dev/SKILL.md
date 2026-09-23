---
name: agentchat-plugin-dev
description: 开发 AgentChat 插件：src/ 出厂薄行 ac-*（工具行 / LLM provider 行 / 拦截行 / 订阅者行 / 预设 Agent 行 / 前端行 ac-client-ui-*）与 Agent 自开发动态插件——inject 服务、注册贡献、订阅或拦截事件。新增能力域、改事件目录或注册中心本身时改用 agentchat-framework-dev。
---

# AgentChat 插件开发

> 核对日 2026-09-23，只记现状；与源码冲突以源码为准。

## 心法：薄行思维

行是**插头不是 orchestrator**：`inject` 声明依赖 → 在 `apply` 里**贡献**（工具/provider/Agent）或**接线**（订阅/拦截）→ 结束。没有 dispose 代码、没有启动顺序假设——**注册即归属、订阅即归属**，行卸载时注册与监听由 cordis 自动回收。

## 事实源

| 要读 | 文件 |
|---|---|
| 全景（契约归属总表 / 端到端链路 / 装载态） | `src/README.md` |
| 事件目录（谁 emit 谁声明，住 owning 包） | `src/ac-<domain>/src/events.ts`（19 域，README 列全路径） |
| 域类型 | `src/ac-<domain>/src/contract.ts`，无则 `src/service.ts`（AgentConfig 在 ac-agents） |
| 标签词表机器源（RESERVED）与机制守则 | `src/ac-tag-registry/src/service.ts` · `src/docs/tag-system-report.md` |
| 范例 | `ac-hello`（工具行）· `ac-persona`（拦截）· `ac-session`（订阅）· `ac-client-ui-todo/`（前端行）· `ac-llm/tests/router.test.ts`（测试） |
| 动态插件模板与规约 | `src/templates/{tool-row,provider-row,event-row}/` + `src/templates/README.md` |

## 六种行型（出厂行）

均为 `src/ac-<name>/` 包，进 `cordis.yml` + TREE 随宿主 boot。

### 1. 工具行（inject `tools`）

```ts
export const inject = ['tools'];
export function apply(ctx: Context) {
  ctx.tools.register({
    name: 'my-tool', description: '…', parameters: { /* JSON Schema */ },
    requiredTags: ['infra'],                 // 出厂具名工具必须声明
    execute: (args, call) => ({ ok: true, output: '…' }),
  });
}
```

字段全清单（事实源 `ac-tools/src/contract.ts`）：`name` / `description?` / `parameters?` / `requiredTags?` / `needPermission?` / `injection?` / `requiresInteraction?` / `execute(args, call)`。`ToolResult = {ok, output?, error?, interrupt?}`：抛错自动收敛为 `{ok:false,error}`；`interrupt` = 宿主级动作意图（loop 收束后执行）。重名注册抛错；进度用 `call.onProgress(chunk)`。

- **requiredTags 能力轴**（AND；能力集 capabilitySetOf = `{base} ∪ {agent:<id>} ∪ AgentConfig.tags`）：缺标签则工具对调用方**不可见**（非执行期 veto）；不声明 ≡ `['base']` 门禁，出厂工具必须声明。词表：fs / fs_minimal / shell / web（+observe、manipulate、inject 动作分层）/ collab / history / infra / delegation / dev / admin / sap-adt；档位词 base-access / full-access / sandbox-access 永不进 requiredTags。
- **needPermission 权限轴**（与能力轴正交）：文件写 / 命令执行 / 非 LLM 出口通道（web_search、browser）声明 `true`；base 档有人桶可询问提权（仅本次 = 按 full 执行一次；本轮全部 = `scope:'run'` 内免问），无人桶拒绝，full 档跳过。
- **injection 注入轴**：缺省 `'capability'`；`'mode'` = 工具调用模式合成入口（不进常规工具面、**必须不挂 requiredTags**，tc-programmatic 档经 narrowToolsByMode 收窄）。先例 `run_code`。
- **requiresInteraction 交互轴**：`true` = 执行中挂起等用户应答（ask_questions / 审批类），self 自会话（`a~a` 无人值守）自动排除；判定单源 formDeniedBy / conversationFormOf。原 `excludeForms` 轴与 `'single'` 词已于 2026-12 撤销。
- **抉择组**三组：`access-tier` / `tool-mode`（tc-none、tc-base、tc-programmatic）/ `browser-tier`——挂 `exclusive` 元数据、UI 下拉单选，`exclusiveNone` 词落词不写；判定面不消费。行声明时由**行包入口**导出 `tagDeclarations`（不是 register 字段）。
- tool 域事件：`tool/before-execute`(W) / `started`(E) / `transform-result`(W) / `after-execute`(E) / `progress`(E) / `registered`(E) / `unregistered`(E)。

### 2. LLM provider 行

**OpenAI 兼容平台不写代码**：config.json 的 `llmProviders` 域加连接（base_url + defaultModel + `/models` 缓存 + 线格式 completions|responses + visionModels + 凭据 `pool:<provider>`），引用 `name@model`；连接池是唯一事实源。新协议才手写：`ctx.llm.register(name, factory, { models, description?, baseUrl?, modelMeta?, visionModels? })`——`models` 路由精确 > 前缀；工厂懒实例化（首次 stream/chat）、行卸载自动 `close?.()`。协议实现住纯库（换 baseUrl 复用）；非 OpenAI 兼容未接入（`docs/llm-protocol-extensibility.md`）。

### 3. 拦截/策略行（waterfall，通常零 inject）

```ts
ctx.on('tool/before-execute', (execution, next) => {
  if (blocked.includes(execution.call.name)) return { ok: false, error: 'blocked' }; // veto
  execution.call = { ...execution.call, args: sanitize(execution.call.args) };       // 改写 = 变异载体
  return next();                                                                     // 保留执行身份
});
```

- `next()` **不带参数**；改写输入的唯一方式是变异载体后 `return next()`。**只观察的监听器必须 `return next()`**——忘调 = 静默吞掉下游全部默认行为。
- 族：`before-*`（决策/改写）→ 主体 → `transform-*`（塑造记录：tool/transform-result、loop/transform-step、transform-run）→ `after-*`（emit 终值）；观察/持久化落 after，安全审查落 transform。
- 其他落点：`router/before-deliver`（信封可变异/veto）· `llm/before-chat`（改 `call.input.model` 即换 provider）· `loop/transform-run`（`payload.result` 事后变换）。
- **顺序无关**：waterfall 序 = 注册序不可配置——向 `request.system` 注入须自证"前置/追加"语义且任意顺序收敛。
- 自述：`ctx.on(ev, fn, { description: '…' })` 进事件目录 / 治理 UI。

### 4. 订阅者行（emit，零 inject 零注册）

`ctx.on('router/message-received', (agentId, message, conversationId, sender, source, meta) => …)`、`'router/reply-completed'`（多 text/result）——历史 / 审计 / 指标 / 广播的形态。拓扑：conversationId = `pairKey(a,b)`（自会话 `a~a`、群 = gid、独立会话 = sid）；`source = 'user' | 'agent' | 'event'`。投递：`ctx.conversation.deliver(agentId, inbound, options)`，options 含 `sender` / `source` / `conversationId`（缺省 pairKey）/ `lane`（next-step | next-turn）/ `placement`（steer | next-run）。回放：`ctx.session.records(conversationId, { subcalls? })`。要把累积结果暴露给他人 → 升级只读服务（`ctx.<key>` + 消费方 inject）。

### 5. 预设 Agent 行（inject `agents`，注册数据）

```ts
export const inject = ['agents'];
export function apply(ctx: Context) {
  ctx.agents.register({
    id: 'helper', model: 'deepseek@deepseek-v4-pro', system: '…', tools: ['hello'], maxSteps: 8,
    tags: ['fs_minimal'],                 // 含档位词时兼作档位单源
    settings: { persona: '你是海盗' },     // settings[具名] = 已装插件在本 Agent 的配置
  });
}
```

`AgentConfig` 全字段见 `ac-agents/src/service.ts`。`tools` = 白名单或 `{include?, exclude?}`，条目支持 `'tag:<x>'`（反向展开为工具名——**点名不解锁**，能力面仍由 `tags` 裁决；空展开经 router warn）。心智：**tags = 钥匙圈**、**include = 围栏**（唯一收窄手段）；`tags` 兼作档位单源与 tc-* 模式词宿主（缺省 tc-base）。`settings[具名]` 键 = **行包入口的 `extension.name`**（不是行名：`ac-persona` ↔ `persona`）/ 动态插件 manifest.name。运行期注册留存返回的 disposer 手动撤。

### 6. 前端行（inject `webui`，宿主 + client 双半边同包）

前端插件一律 `src/ac-client-ui-<name>/` 独立包（包名即身份），与后端行**双向可独立摘除**，只经 `ctx.rpc` 契约面耦合，不 import webui 内部模块。

```ts
// 宿主半边 src/index.ts：只声明 boot graph
export const inject = ['webui'];
export function apply(ctx: Context) {
  const off = ctx.webui.declareClient({ name: 'ui-todo', entry: '…/client/index.ts', platform: 'web', phase: 'domain' });
  ctx.effect(() => off);                                  // 注册即归属：卸载级联回收
}
// client/index.ts：浏览器半边（按 boot graph 装载）
export default clientPlugin({ name: 'ac-client-ui-todo.client', inject: ['rpc', 'slots'],
  apply(ctx) { ctx.slots.register('conversation:dock-widget', { id: 'todo', component: Card, order: 40 }); } });
```

- 贡献面 = slot 席位（`tool-card:result-view` 工具结果卡、`conversation:dock-widget` dock 卡等）；行卸载即贡献消失，RPC 失败走静默空态。
- `package.json` 加 `exports` 的 `./client` 两条 + `agentchat.client { platform, entry, phase }`；client 面依赖 vue + ac-client-runtime；`cordis.yml` / TREE 照常各一行带 id。
- 基建 `ac-client-slots`（SlotCore 纯核）/ `ac-client-runtime`（ClientContext / slots / rpc / sessions）——别自造装载通道。

## per-Agent 配置与门控

- 读配置一律 `ctx.agents.settingsOf(id, '<名>')`（全局默认层 ∪ 差异层：对象递归、数组整体替换、差异层优先；preset/未知 id 回落全局）；直读差异层只用于写侧/展示。`enabled` 是约定键、插件须自查；**未声明 `respectsEnabled` 即按未自查处理**（缺省 false）。
- 门控 = `agentGate`（ac-gate-core + owning 包 agentOf* 读取器，如 `agentOfRunRequest`）：停用自动 `return next()` / 跳过，无身份 fail-open；**只对 run 域事件存在**（agents/updated、job/settled、config/changed、plugin/* 是 host 域）。
- 一插件多事件要细分启停 → facet：`agentGate(…, { facet: 'redact' })` 读 `settings[名]['redact'].enabled ?? settings[名].enabled`；facet 是行为切面**不是事件名**，事件名键只住 `events.disabled`。
- ac-event-policy 可按 `owner::event` 进程级停用（注册期吞掉、boot 末清扫、`config/changed` 热更只影响后续注册）——别假设监听器恒在。

## Agent 自开发动态插件

```
① 开发  <数据根>/files/<agentId>/<name>/（manifest.json + 入口）
② 试跑  register_plugin（会话级，重启即失；授权面 = manifest 全集）
③ 定型  install_plugin（免审 stage → 批准 → 装载；安装态 plugins/registry.json，重启恢复）
④ 回滚  unregister_plugin removeFromLibrary:true（代码回滚——目录进 .backup；副作用不回滚）
```

- 开发目录是模板约定（工具只约定基准 `files/<agentId>/`，显式 `settings.security.workdir` 最优先）；回执落账当前会话并 `source:'event'` 回触自会话。迭代：内容变必 bump `version`，同 name + version 内容一致幂等；**无热重载**。
- manifest **必填 = `name` / `version`**（`entry` 缺省 `index.ts`）；`contracts`（仅不兼容 range 拒载）/ `permissions`（免审快照 = 声明全集）/ `provides`（`{tools?, llmProviders?, events?, ui?, agents?}`，events 可为 `Array<string | {name, description?}>`）建议声明。保留字表 `ac-plugin-core/src/reserved.ts`；命名 `<agentId>-<name>`。
- **机械护栏只有保留字**（内置工具/provider/Agent 名）；"不 provide 新服务、不自授 tags、不注册他人 Agent、不 emit `loop/*`"是**自律规约**（loop 越权会 usage 双记账）。对账现状：`reconcileProvides` 只比对 tools / llmProviders 且仅 warn。
- 工具默认私有：模板 `agentTool()` 注入 `requiredTags: ['agent:<ownerId>']`，共享 = 他人自己 `tags` 加该标签；共享输出强制 `<tool-output plugin="…">…</tool-output>` 包裹，description 禁指令式措辞。
- 宿主防线：`plugins/audit.jsonl` 审计、连续失败 ≥3 熔断（`.load-health.json`，成功 / install / uninstall 清零）、hash 复验、`AGENTCHAT_SAFE_MODE=1` 或 `<root>/.safe-mode` 跳过装载、owner 删除后无主常驻；第三方分发走人审（npm/github，锚 repo·ref·commit），被发现靠自标 keywords/topic `agentchat-plugin`。

## 新建包脚手架（出厂行）

1. `src/ac-<name>/`：`package.json` + `src/index.ts`（+ `tests/`），照抄 ac-hello——`type: module`；`exports` = `{ ".": "./src/index.ts", "./src/*": "./src/*" }`（前端行另加 `./client`）；`@agentchat/cordis` 进 dependencies，所 inject 服务包 / 所监听事件 owning 包进 devDependencies（`import type {} from '<pkg>'` 拿到服务类型 + 域类型 + 事件目录增强，没有独立契约包）；`agentchat.plugin: true` + `keywords: ["agentchat"]`（纯库不加）。仓库根 `pnpm install`。
2. 挂载两处缺一不可：`cordis.yml` 的 `- id: <稳定id>  name: 'ac-<name>'`（**必须带 id**）+ `src/ac-app/src/index.ts` 的 TREE 同 id 行（行集一致有测试锁定）。
3. 可配置行：① Schemastery `Config`（loader 先校验填默认，非法 = 行 FAILED；普通对象无效）；② 入口自述 `export const extension: ExtensionMeta`（ac-extension-core）：`{name, label, description, automatic?, fields?, listeners?}`——`name` = settings 键锚点；`fields` 项 `{name, description?, type?, enum?, min?, max?, step?, default?}`（type ∈ string | text | number | boolean | list | json | file）；`listeners` 项 `{event, role?, description?, facet?, respectsEnabled?}`。三层配置先例 = 行 config → 全局 `settings.<域>.<键>`（订阅 `config/changed` 热更，非法值 warn 保持现状）。
4. 验证：`pnpm typecheck && pnpm lint && pnpm test:unit`（快循环；集成件 `*.integration.test.ts` 走 `pnpm test` / `test:integration`）+ `check:deps`；冒烟 `pnpm smoke` / `pnpm dev`。

## 测试模式（照 ac-llm/tests/router.test.ts）

mock 就地造行 `{ name, inject, apply }`；boot：`new Context()` → 逐行 `ctx.plugin(row)` → **`await fiber`**（inject 未满足会挂起）；`afterEach` 逐 fiber `dispose()`（`uid !== null` 判已卸载）；回收断言用卸载后探测（`ctx.tools.has('x') === false`）。测试内相对导入不带 `.ts`（vitest 解析）。

## 兼容红线（Node 原生 TS strip-only 加载器）

`src/` 实现面相对导入写显式 `.ts`（`from './service.ts'`），`tests/` 面无扩展名惯例；不用类参数属性；纯类型导入 `import type`、声明合并增强 `import type {} from '<owning 包>'`；行序无激活语义——依赖只靠 `inject`。

## 反模式（发现即改）

- 手写清理（dispose 回调 / removeListener / 全局 Map）——注册中心已代管。
- 跨行 import 另一行的实现或实例——走服务方法 / 事件（前端半边走 `ctx.rpc` 与 slot）。
- 观察型 waterfall 监听器不调 `next()`（= 静默 veto）；在 emit 事件上期望返回值；用 waterfall 做纯广播。
- `if (ctx.xxx)` 探测后再注册副作用——运行时 `ctx.get()` 探测，或拆独立子行。
- 硬编码行序；yml 行不带 id；TREE 与 yml 行集漂移。
- per-Agent 配置直读差异层散落；用事件名做 per-Agent 配置键。
- 为 OpenAI 兼容平台手写 provider 薄行——配置 `llmProviders` 即可。
- 出厂工具不声明 requiredTags；新词不查 RESERVED 表 / tag-system-report 防漂移章。
- 动态插件：撞保留字、不改 version 重装、手改已装目录（机械拦截）；自授 tags、注册他人 Agent（自律项）。

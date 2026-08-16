# 本地 vendor 生态

> `src/vendor` · 8 个本地化 cordis 全家桶包 · 文档对应 v0.6.2（2026-08-15）

## 概述
cordis 全家桶已完全本地化到 `src/vendor/*`，原 `@deepseek-ai/*` / cordisjs 包统一改挂 `@agentchat/*` 别名，并纳入 pnpm workspace（`pnpm-workspace.yaml` 含 `vendor/*`）。所有 vendor 包均标记 `private`，不参与发布；AgentChat 只作为普通 workspace 依赖使用这些包，不重实现上游功能。如需修补，直接编辑 `vendor/<pkg>/src/*`（TS 源码）或 `lib/*`（产物）；升级时临时安装原上游包，重跑 vendor 同步脚本并核对本地修改后全量验证。各包自带 `README.md` 与 `LICENSE`。

## 目录（关键源文件 + 一句话）
| 目录 | 说明 |
|---|---|
| `cordis/` | cordis 核心（Context/Service/Fiber/plugin/effect/inject/logger/events/registry） |
| `cosmokit/` | 通用工具集（array/string/misc/time/types） |
| `schemastery/` | Type-driven Schema 校验器 |
| `loader/` | cordis 运行时插件加载器（cordis.yml 条目树） |
| `logger/` | cordis 控制台日志 exporter |
| `timer/` | cordis 定时器服务（disposal-aware） |
| `hmr/` | cordis 插件热更新 |
| `include/` | cordis.yml / JSON 文件型加载树 |
| `README.md` | vendor 整体状态、别名映射、启动方式、升级/魔改说明 |

## 插件行（8 包概览）
| 包名（本地别名） | 版本 | main | 用途 |
|---|---|---|---|
| `@agentchat/cordis` | 4.0.1 | `lib/index.js` | 核心框架：Context、Service、Fiber、plugin 注册、事件、logger、registry |
| `@agentchat/cosmokit` | 1.8.2 | `lib/index.js` | 通用工具：数组集合运算、字符串/路径、对象工具、时间、二进制/深比较 |
| `@agentchat/schemastery` | 3.18.1 | `lib/index.cjs` / `lib/index.mjs` | Type-driven schema 校验器（插件 Config 校验） |
| `@agentchat/cordis-loader` | 1.0.2 | `lib/index.js` | 运行时插件树：cordis.yml 条目 create/update/remove/resolve |
| `@agentchat/cordis-logger` | 1.0.1 | `lib/index.js`（浏览器 `lib/browser.js`） | 内置 logger 的控制台 exporter |
| `@agentchat/cordis-timer` | 1.1.3 | `lib/index.js` | `ctx.timer`：timeout/interval/throttle/debounce，随 fiber 自动清理 |
| `@agentchat/cordis-hmr` | 1.0.16 | `lib/index.js` | loader 管理插件的模块热替换（watch + 依赖追踪 + 局部重载） |
| `@agentchat/cordis-include` | 1.0.6 | `lib/index.js` | 文件型加载树：读 YAML/JSON 转 loader 条目，可写时回写 |

原始上游映射见 `src/vendor/README.md`：`cordis@4.0.1`、`cordis-plugin-loader@1.0.2`、`cordis-plugin-include@1.0.6`、`cordis-plugin-hmr@1.0.16`、`cordis-plugin-timer@1.1.3`、`cordis-plugin-logger-console@1.0.1`、`cosmokit@1.8.2`、`schemastery@3.18.1`。

## 提供的能力
### @agentchat/cordis（核心）
| 能力 | 说明 |
|---|---|
| `new Context()` / `ctx.plugin()` | 根依赖容器；启动插件并返回 `Fiber` |
| `inject` | 声明插件所需服务，Loader/框架按依赖自动排序激活 |
| `Service` | 服务基类；`super(ctx, 'name')` 注册为 ctx 服务 |
| `Fiber` | 插件生命周期；effect/事件监听/服务随 `fiber.dispose()` 移除 |
| `events` | `ctx.on` / `ctx.emit` 事件总线，支持 `Events` 接口增强 |
| `logger` | `ctx.logger('name')` 门面；可接 console exporter |
| `registry` | 插件注册表 / 依赖注入 / 插件入口类型 |
| `effect` | effect 生命周期管理（随 fiber 清理） |
### @agentchat/cosmokit（工具集）
| 模块 | 关键 API |
|---|---|
| `array` | `contain` `intersection` `difference` `union` `deduplicate` `remove` `makeArray` |
| `string` | `capitalize` `uncapitalize` `camelCase` `paramCase` `snakeCase` `formatProperty` `trimSlash` `sanitize` |
| `misc` | 类型：`Dict` `Get` `MaybeArray` `Awaitable` `Promisify` `Intersect`；函数：`noop` `isNullable` `isNonNullable` `isPlainObject` `filterKeys` `mapValues` `pick` `omit` `defineProperty` |
| `time` | `Time.millisecond/second/minute/hour/day/week` `parseTime` `parseDate` `format` `template` `toDigits` |
| `types` | `is(type[, value])`、`Binary`（base64/hex 互转）、`clone`（深克隆保原型/循环）、`deepEqual` |
### @agentchat/schemastery（Schema 校验）
| 能力 | 说明 |
|---|---|
| 基础类型 | `Schema.any()` `never()` `const()` `number()` `string()` `boolean()` `is(ctor)` |
| 复合类型 | `array(inner)` `dict(inner)` `tuple(list)` `object(dict)` `union(list)` `intersect(list)` `transform(inner, cb)` |
| 实例方法 | `required()` `default(value)` `description(text)` `simplify(value)` |
| 校验选项 | `{ autofix, ignore, path }`；schema 本身可调用：`Config(value)` |
| 简写 | `String`→`string()`、`Number`、`Boolean`、`Date`→`is(Date)`、原始值→`const` |
| 扩展/互操作 | `Schema.extend(type, resolve)`；`Schema.from()` 简写推断；暴露 Standard Schema `~standard` |
### @agentchat/cordis-loader（加载器）
| API | 说明 |
|---|---|
| `loader.create(options, parent?, position?)` | 添加并启动条目 |
| `loader.update(id, options, parent?, position?)` | 更新/移动/重启条目 |
| `loader.remove(id)` | 停止并删除条目 |
| `loader.resolve(id)` | 解析条目（含嵌套 `a:b` id） |
| `loader.resolveGroup(id)` | 解析根/嵌套组 |
| `loader.await()` | 等待 pending import 与 fiber reload |
| `loader.locate(fiber?)` | 返回 fiber 所属 loader 条目 id |

Entry 选项：`id` `name` `config` `group` `disabled` `inject`。文件型树配合 `@agentchat/cordis-include`。
### @agentchat/cordis-logger
| 配置字段 | 说明 |
|---|---|
| `colors` | 颜色支持级别，`false` 禁用颜色 |
| `maxLength` | 单行最大长度（超长截断） |
| `levels` | per-logger 最低级别映射 |
| `showDiff` | 显示距上一条消息的耗时 |
| `showTime` | 时间戳模板 |
| `label` | label 宽度/边距/对齐 |

Node 入口用 `node:util.inspect` 处理 `%o`/`%O`；浏览器入口透传 `console`。
### @agentchat/cordis-timer
| API | 说明 |
|---|---|
| `ctx.timeout(callback, delay)` / `ctx.timeout(delay)` | 一次性执行返回 disposer / 返回 Promise |
| `ctx.interval(callback, delay)` / `ctx.interval(delay)` | 周期执行返回 disposer / 返回 async iterator |
| `ctx.throttle(callback, delay, noTrailing?)` | 节流函数（带 `.dispose()`） |
| `ctx.debounce(callback, delay)` | 防抖函数（带 `.dispose()`） |

定时句柄注册在当前 fiber 上，插件 dispose 时自动清理。`ctx.setTimeout`/`ctx.setInterval` 保留为废弃别名。
### @agentchat/cordis-hmr
| 配置/事件 | 说明 |
|---|---|
| `base` | 可选基础目录（从 `ctx.baseUrl` 解析） |
| `root` | Chokidar 监视根，默认 `['.']` |
| `ignored` | Picomatch 忽略模式（`**/node_modules`、`**/.*` 等） |
| `debounce` | 批量变更后处理前等待毫秒数 |
| `hmr/change` | 未被重载处理的变更文件事件 |
| `hmr/reload` | 一个或多个插件条目重载后事件 |

要求：`@agentchat/cordis-loader` + `@agentchat/cordis-timer`，且运行时暴露 Node 内部模块加载器（`--expose-internals`）。框架级依赖变更会 fallback 到 `loader.exit()` 让宿主进程重启。
### @agentchat/cordis-include
| 配置字段 | 说明 |
|---|---|
| `path` | YAML/JSON 文件路径（从 `ctx.baseUrl` 解析） |
| `initial` | 文件缺失时写入的初始条目列表 |
| `patches` | 读取后应用的运行时 patch（按 id 插入/覆盖字段） |
| `enableLogs` | 开启 loader apply/reload/unload 日志 |

## 关键契约 / API
- 别名契约：源码 import 一律使用 `@agentchat/cordis` 等本地别名，不再出现 `@deepseek-ai/*`。
- 服务命名：`@agentchat/cordis-timer` 服务名是 `ctx.timer`；AgentChat 自身定时任务服务已改名 `ctx.timerManager`（`@agentchat/timer`），两个 TimerService 不冲突。
- cordis 插件三要素：`export const name`、`export const Config`（Schemastery）、`export function apply(ctx, config)`；Loader 按 `inject` 推导激活顺序。
- `@agentchat/cordis-logger` 双入口：`exports["."]` 的 `node`/`default` 分别指向 `lib/index.js` / `lib/browser.js`。
- `@agentchat/schemastery` 双格式：`import` → `lib/index.mjs`、`require` → `lib/index.cjs`。

## 配置
vendor 包本身不提供 AgentChat 级配置；它们在根 `cordis.yml` 中以普通条目出现（如 `@agentchat/cordis-logger` 配 `timestamp: true`、`@agentchat/cordis-timer` 无配置、`@agentchat/cordis-hmr` 正式运行不启用）。各包独立配置见上文各表。

## 与其他插件的关系
- 所有 vendor 包是 `pnpm-workspace.yaml` 中的 workspace 成员，被 AgentChat 各域包以 `workspace:*` 依赖引用。
- `@agentchat/cordis` 是全部插件与运行时的基础框架；`@agentchat/schemastery` 被各插件用于 Config 校验；`@agentchat/cosmokit` 被 cordis/schemastery/loader/timer/hmr/include 复用。
- `@agentchat/cordis-loader` + `@agentchat/cordis-include` 把根 `cordis.yml` 转为运行中插件图；`cordis-hmr` 依赖前两者实现静态行热更新；`cordis-logger` 与 `cordis-timer` 是基础设施行。
- AgentChat 只使用这些包；本地修补直接编辑 vendor 源码，升级按 `src/vendor/README.md` 流程回流上游。

## 测试
- 各 vendor 包上游自带测试（保留在包内，未在 AgentChat 仓库逐包重跑）。
- AgentChat 级验证：`pnpm typecheck && pnpm test && pnpm dev`；修改 vendor 源码后建议同样全量验证。
- 加载链路验证由 `@agentchat/hello`（见 hello.md）在 `cordis.yml` 末尾完成。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)

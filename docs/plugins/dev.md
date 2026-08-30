# @agentchat/dev
> 包路径 `src/dev/dev` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
开发辅助工具包。提供两个 cordis 插件行：`agentchat-dev-tools`（3 个 `dev` 级工具：read_logs / reload / reload_modules）与 `agentchat-plugin-tools`（2 个 `admin` 级工具：register_plugin / unregister_plugin），覆盖日志读取、配置热重载、模块热重载与插件开发调试闭环；发布走 git + 市场发现（publish_plugin 已移除）。领域独立，可脱离 AgentChat 复用。

> code_search 已于 v0.7.1 移除（2026-08-20）：与 `grep`（base）重叠，dev 场景用 grep 定位项目根即可。
> register_tool 已于 2026-08-20 移除：动态能力收敛到 register_plugin 插件路径（代码注入面更小、grants 审批统一）。

## 目录（关键源文件 + 一句话）
| 文件 | 说明 |
| --- | --- |
| plugin.ts | cordis 插件行 `agentchat-dev-tools`，注册 3 个 dev 工具 |
| plugin-admin.ts | cordis 插件行 `agentchat-plugin-tools`，注册 2 个 admin 工具 |
| register.ts | `registerDevTools` / `registerPluginAdminTools` 两个注册入口 |
| tools.ts | read_logs / reload / reload_modules 三工具 + `findChangedPluginSources` |
| plugin-tools.ts | register_plugin / unregister_plugin 插件开发闭环 |

## 插件行
| 模块文件 | 插件 name | inject | 提供/注册内容 |
| --- | --- | --- | --- |
| plugin.ts | agentchat-dev-tools | tools | 经 `registerDevTools` 注册 3 个 dev 工具 |
| plugin-admin.ts | agentchat-plugin-tools | tools | 经 `registerPluginAdminTools` 注册 2 个 admin 工具 |

本包不新增 ctx 服务；`plugin-admin.ts` 经 `getOrCreatePluginHost(ctx)` 复用 `@agentchat/plugins` 的 PluginHost（无该服务时兜底创建）。

## 提供的能力
### 工具表
| 工具 | label | requires | 要点 |
| --- | --- | --- | --- |
| read_logs | 读取日志 | dev | 内存环形缓冲日志（最近 2000 条） |
| reload | 热加载 | dev | 仅重载配置，不重载插件源码 |
| reload_modules | 热重载模块 | dev | 宣告源码修改完成 → 模块热重载（水位线扫描，失败回滚） |
| register_plugin | 注册插件 | admin | session 级动态加载插件，watch 热重载 |
| unregister_plugin | 卸载插件 | admin | 卸载会话级插件并回收 presets 引用 |

## 工具参考
| 工具 | name | label | requires | action 枚举 | 主要参数 | 行为要点 |
| --- | --- | --- | --- | --- | --- | --- |
| read_logs | read_logs | 读取日志 | dev | — | limit（默认 100，最大 500）、level（debug/info/warn/error）、keyword、clear | 从内存环形缓冲读取；`clear=true` 先清空缓冲再收集；level 为最低级别过滤 |
| reload | reload | 热加载 | dev | scope=self/global/all（默认 all） | scope | 抛 `ToolInterrupt({type:'reload-requested', scope})`；global/all 时检测源码 mtime 晚于进程启动/水位线的 .ts/.tsx/.mts/.cts 并提示：仅配置生效，源码改动须用 reload_modules 或 system_restart |
| reload_modules | reload_modules | 热重载模块 | dev | — | files（显式补充，取并集）、reason | 宣告源码修改完成 → 语义化中断 → 装配层模块热重载；失败自动回滚旧模块；框架/内核（externals）拒绝并提示 system_restart |
| register_plugin | register_plugin | 注册插件 | admin | — | name（必填）、dir、grants（fs/network/process/shell/ui） | 默认目录 `<workspace>/plugins/<agentId>/<name>/`；校验 manifest.name；`host.load({sessionOnly:true, watch:true})`；fs/network 默认授予，process/shell 需 grants 显式授予；成功后写 config.presets 并抛 self reload |
| unregister_plugin | unregister_plugin | 卸载插件 | admin | — | name（必填） | 仅允许卸载本 Agent 的 session 级插件；`host.unload` 后移除 config.presets 并抛 self reload |

## 关键契约 / API
```ts
registerDevTools(tools: ToolsService, owner: string, getHmr?): void
registerPluginAdminTools(tools: ToolsService, owner: string, host: PluginHost): void
// 注册工厂：makeDevTools(config, getHmr) + makeRegisterPluginTool / makeUnregisterPluginTool
findChangedPluginSources(rootDir?: string): string[]                       // 检测 src/ 源码变更
updateAgentPresets(configPath, preset, remove): boolean                    // config.json presets 增删
```
- `register_plugin` 动态 import = 插件代码进宿主进程，仅会话级、不落盘为启动扫描记录（重启即失）；`watch:true` 开启源码监听，改动即热重载。
- （publish_plugin 已移除：发布走 git + 市场发现，见 plugin-dev-guide §4） 返回的 id；`grantPermissions(args.grants)` 将 grants 转为权限授予。

## 配置
本包无自有命名空间。读写位置：
- Agent 配置：`<agentsDir>/<agentId>/config.json` 的 `presets` 字段（register_plugin / unregister_plugin 增删）。
- 默认开发插件目录：`<workspace>/plugins/<agentId>/<pluginName>/`。
- 插件 manifest 必含 name/version/entry/inject/permissions；permissions 中 fs/network 默认授予，process/shell 必须在 grants 参数显式授予，否则装载前拒绝。

## 与其他插件的关系
package.json 依赖：`@agentchat/agent-loop`、`@agentchat/toolkit`、`@agentchat/tools`、`@agentchat/util`、`@agentchat/cordis`、`@agentchat/agent-config`、`@agentchat/plugins`。

使用方：`getOrCreatePluginHost(ctx)` 依赖 plugins 服务行的 PluginHost；工具经 `ctx.tools` 注册；reload 依赖 agent-loop 的 `ToolInterrupt` 语义化中断。

## 行为细节
- `read_logs` 依赖 `@agentchat/util` 的 `readLogs / clearLogBuffer`，缓冲上限为最近 2000 条后端日志。
- `reload` 执行体（`reloadAgents` → `interruptHandlers`）由 L5 装配；`scope=self` 重读本 Agent 配置并重新注册，`scope=global` 重读全部 Agent 配置，`scope=all` 两者都做。
- `reload_modules` 是源码热重载正典路径（L1.5，见 restart-design.md §2）：多文件关联修改是一个事务，全部改完再宣告一次；成功后续跑，失败回滚可重试；externals（vendor cordis、boot 内核、组合引擎）拒绝并提示 `system_restart`。
- `register_plugin` 加载成功会更新本 Agent 的 `config.json` presets（若已存在同名则跳过写回）；`host.load` 返回 `{status:'replaced'}` 时通知目录变更。
- 市场安装/人工暂存的目录在 `<workspace>/plugins/.staging`ove 安装后立即在当前进程生效。

## 测试
package.json 仅 `typecheck`（tsc --noEmit），无 test 脚本。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)

# @agentchat/dev
> 包路径 `src/dev/dev` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
开发辅助工具包。提供两个 cordis 插件行：`agentchat-dev-tools`（3 个 `dev` 级工具：code_search / read_logs / reload）与 `agentchat-plugin-tools`（4 个 `admin` 级工具：register_tool / register_plugin / unregister_plugin / publish_plugin），覆盖代码搜索、日志读取、配置热重载、运行时工具注册与插件开发发布闭环。领域独立，可脱离 AgentChat 复用。

## 目录（关键源文件 + 一句话）
| 文件 | 说明 |
| --- | --- |
| plugin.ts | cordis 插件行 `agentchat-dev-tools`，注册 3 个 dev 工具 |
| plugin-admin.ts | cordis 插件行 `agentchat-plugin-tools`，注册 4 个 admin 工具 |
| register.ts | `registerDevTools` / `registerPluginAdminTools` 两个注册入口 |
| tools.ts | code_search / read_logs / reload 三工具 + `findChangedPluginSources` |
| register-tool.ts | register_tool：vm 沙箱编译 execute，运行时注册工具 |
| plugin-tools.ts | register_plugin / unregister_plugin / publish_plugin 插件开发闭环 |

## 插件行
| 模块文件 | 插件 name | inject | 提供/注册内容 |
| --- | --- | --- | --- |
| plugin.ts | agentchat-dev-tools | tools | 经 `registerDevTools` 注册 3 个 dev 工具 |
| plugin-admin.ts | agentchat-plugin-tools | tools | 经 `registerPluginAdminTools` 注册 4 个 admin 工具 |

本包不新增 ctx 服务；`plugin-admin.ts` 经 `getOrCreatePluginHost(ctx)` 复用 `@agentchat/plugins` 的 PluginHost（无该服务时兜底创建）。

## 提供的能力
### 工具表
| 工具 | label | requires | 要点 |
| --- | --- | --- | --- |
| code_search | 代码搜索 | dev | 正则搜索项目源码 |
| read_logs | 读取日志 | dev | 内存环形缓冲日志（最近 2000 条） |
| reload | 热加载 | dev | 仅重载配置，不重载插件源码 |
| register_tool | 注册工具 | admin | 运行时注册工具，owner=`runtime:register-tool:<agent_id>`，always 启用 |
| register_plugin | 注册插件 | admin | session 级动态加载插件，watch 热重载 |
| unregister_plugin | 卸载插件 | admin | 卸载会话级插件并回收 presets 引用 |
| publish_plugin | 发布插件 | admin | action=stage/approve/list + grants 权限授予 |

## 工具参考
| 工具 | name | label | requires | action 枚举 | 主要参数 | 行为要点 |
| --- | --- | --- | --- | --- | --- | --- |
| code_search | code_search | 代码搜索 | dev | — | pattern（必填）、dirs（默认 `["src","scripts"]`）、include（后缀数组）、context（默认 0）、maxResults（默认 40，上限 200）、case_sensitive（默认 false）、count | 项目根 = `workspaceRoot()` 上两级；跳过 node_modules/dist/.git/release/.cache/workspace/sessions/archive/_tmp；返回 `file:line:内容`（含上下文行） |
| read_logs | read_logs | 读取日志 | dev | — | limit（默认 100，最大 500）、level（debug/info/warn/error）、keyword、clear | 从内存环形缓冲读取；`clear=true` 先清空缓冲再收集；level 为最低级别过滤 |
| reload | reload | 热加载 | dev | scope=self/global/all（默认 all） | scope | 抛 `ToolInterrupt({type:'reload-requested', scope})`；global/all 时检测 `src/plugins` 下 mtime 晚于进程启动的 .ts/.tsx/.mts/.cts 并提示：仅配置生效，源码改动须用 system_restart |
| register_tool | register_tool | 注册工具 | admin | — | name（必填）、label、description（必填）、parameters（必填）、execute（必填）、requires | execute 经 `vm.runInContext` 编译（超时 2000ms）；沙箱白名单：JSON/Math/Number/String/Boolean/Array/Object/Promise/Infinity/NaN/parseInt/parseFloat/isNaN/isFinite/Date/受限 console；requires 仅受控词汇表 base/dev/admin/conductor，缺省 base；注册 `{always:true, replace:true}`，全局可见 |
| register_plugin | register_plugin | 注册插件 | admin | — | name（必填）、dir、grants（fs/network/process/shell/ui） | 默认目录 `<workspace>/plugins/<agentId>/<name>/`；校验 manifest.name；`host.load({sessionOnly:true, watch:true})`；fs/network 默认授予，process/shell 需 grants 显式授予；成功后写 config.presets 并抛 self reload |
| unregister_plugin | unregister_plugin | 卸载插件 | admin | — | name（必填） | 仅允许卸载本 Agent 的 session 级插件；`host.unload` 后移除 config.presets 并抛 self reload |
| publish_plugin | publish_plugin | 发布插件 | admin | stage / approve / list | action（必填）、name、dir、id、grants | stage：校验 manifest、复制 .staging、返回 id/hash；approve：`approveStaging(ws,id,grants)` 后立即装载（sessionOnly=false），重启后由插件库扫描恢复；list：列出待审暂存；同名同版本拒绝，旧版入 .backup；发布 ≠ 启用，需 config.presets 引用 |

## 关键契约 / API
```ts
registerDevTools(tools: ToolsService, owner: string, host: PluginHost): void
// 注册工厂：makeDevTools(config) + makeRegisterTool(tools, `runtime:register-tool:${config.agent_id}`)
//          + makeRegisterPluginTool / makeUnregisterPluginTool / makePublishPluginTool
makeRegisterTool(toolsService: ToolsService, runtimeOwner: string): Tool   // always + replace
findChangedPluginSources(rootDir?: string): string[]                       // 检测 src/plugins 源码变更
updateAgentPresets(configPath, preset, remove): boolean                    // config.json presets 增删
```
- `register_tool` 的 owner 固定为 `runtime:register-tool:<agent_id>`，`always=true` 不参与 presets 过滤；requires 仅受控词汇表 `base/dev/admin/conductor`，缺省 `base`；同名重复注册执行 replace 语义，卸载 owner 后工厂工具恢复。
- `register_tool` 注册后：下一步 ReAct 立即可调用（createAgentContext 每次投递重新 resolveTools）；`/api/plugins` 工具目录自动可见；全局共享、跨 Agent 生效。
- `register_plugin` 动态 import = 插件代码进宿主进程，仅会话级、不落盘为启动扫描记录（重启即失）；`watch:true` 开启源码监听，改动即热重载。
- `publish_plugin` 权限授予快照写入 registry；approve 需要人工回传 stage 返回的 id；`grantPermissions(args.grants)` 将 grants 转为权限授予。

## 配置
本包无自有命名空间。读写位置：
- Agent 配置：`<agentsDir>/<agentId>/config.json` 的 `presets` 字段（register_plugin / unregister_plugin 增删）。
- 默认开发插件目录：`<workspace>/plugins/<agentId>/<pluginName>/`。
- 插件 manifest 必含 name/version/entry/inject/permissions；permissions 中 fs/network 默认授予，process/shell 必须在 grants 参数显式授予，否则装载前拒绝。

## 与其他插件的关系
package.json 依赖：`@agentchat/agent-loop`、`@agentchat/toolkit`、`@agentchat/tools`、`@agentchat/util`、`@agentchat/cordis`、`@agentchat/agent-config`、`@agentchat/plugins`。

使用方：`getOrCreatePluginHost(ctx)` 依赖 plugins 服务行的 PluginHost；工具经 `ctx.tools` 注册；reload 依赖 agent-loop 的 `ToolInterrupt` 语义化中断；register_tool 直接闭包注入 `ctx.tools`。

## 行为细节
- `code_search` 结果路径为相对项目根的 `/` 分隔路径；`count=true` 时返回 `{count, files:[[file,count],...]}`，不返回匹配行。
- `read_logs` 依赖 `@agentchat/util` 的 `readLogs / clearLogBuffer`，缓冲上限为最近 2000 条后端日志。
- `reload` 执行体（`reloadAgents` → `interruptHandlers`）由 L5 装配；`scope=self` 重读本 Agent 配置并重新注册，`scope=global` 重读全部 Agent 配置，`scope=all` 两者都做。
- `register_plugin` 加载成功会更新本 Agent 的 `config.json` presets（若已存在同名则跳过写回）；`host.load` 返回 `{status:'replaced'}` 时通知目录变更。
- `publish_plugin stage` 复制的暂存目录在 `<workspace>/plugins/.staging`，approve 安装后立即在当前进程生效。

## 测试
package.json 仅 `typecheck`（tsc --noEmit），无 test 脚本。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)

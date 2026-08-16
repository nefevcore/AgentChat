# 第 8 步：动态插件与插件库

> 目标：理解 PluginHost 的生命周期、权限模型与「发布 ≠ 启用」。

## 8.1 两种插件来源

| 来源 | 加载方式 | 生命周期 |
|------|----------|----------|
| 内置插件行 | `cordis.yml` 声明 | 随进程，挂/摘行生效 |
| 工作区插件 | `workspace/default/plugins/<name>/` + `registry.json` | 启动扫描加载，可运行时 reload/unload |
| 会话级插件 | `register_plugin(name=..., dir=...)` | 仅本进程，重启即失；自动 watch + 自动追加 presets |

三者共用同一个 `ctx.pluginHost`（PluginHost）。

## 8.2 插件库目录

```
workspace/default/plugins/
├── registry.json          # 安装记录：manifest 快照 / owner / 权限 / SHA-256 / 安装时间
├── my-plugin/             # 已安装插件（manifest.json + 入口 + 源码/产物）
├── .staging/<id>/         # publish_plugin stage 的暂存副本
└── .backup/<name>-<ver>/  # 被替换/卸载的旧版本
```

## 8.3 发布闭环（人审）

```
publish_plugin(action=stage, name=..., dir=...)
  → manifest 校验 → 复制 .staging →（有 ui 时 esbuild 打包）→ SHA-256 → 返回 id
  ↓ WebUI「插件库 → 暂存审查」逐文件查看（只读代理，路径守卫，1 MiB 上限）
publish_plugin(action=approve, id=..., grants=["fs","network"])
  → 哈希一致性校验 → 安装到 plugins/<name>/ → 写 registry → 旧版本进 .backup
```

规则：

- 同版本重复发布拒绝；`name` 与 `version` 是唯一性依据。
- **发布 ≠ 启用**：安装只让插件进入插件库并在启动时加载；Agent 必须在 `config.presets` 引用 `manifest.name`。
- 卸载：`uninstall_plugin`（admin 工具或 `/api/plugins/library/:name/uninstall`）把目录移 `.backup`，不修改任何 Agent 的 presets（未注册名自动跳过）。

## 8.4 权限模型

| 权限 | 默认 | 授予点 |
|------|------|--------|
| fs / network | ✅ 默认授予 | — |
| process / shell / ui | ❌ | `approve` 的 `grants` / `register_plugin` 的 `grants` |

`PluginHost.load()` 在 **import 之前** 做权限 gate——未授权插件代码不进进程；授予快照写入 registry，重启恢复。

## 8.5 PluginHost 生命周期细节

1. `load(spec)`：manifest 校验 → 权限 gate → inject 依赖预检（缺失直接报错，不停在 PENDING 挂死）→ 动态 import（cache-busting）→ `ctx.plugin(module)` 激活为 Fiber；
2. 同名重载：旧 fiber 先 dispose → `tools.unregister(owner)` / `hooks.unregister(owner)` → 新模块激活；失败则**回滚旧实例**；
3. `register_plugin` 自动开启 watch：只对**该插件目录**做 750ms 哈希轮询，只重载该插件实例（其他插件行不受影响、进程不重启）；重载失败保留旧版本。它和 `cordis.yml` 中默认注释掉的 `@agentchat/cordis-hmr`（面向整个 `src` 的静态 HMR，可能整进程 `loader.exit()`）不是一回事。
4. `unload`：回收 owner 注册 → dispose fiber → 停 watcher → 通知目录变化；
5. 事件（PluginEventBus → WS 广播）：`plugin.catalog.changed`、`plugin.reload`、`agent.assembly.changed`、`plugin.ui.extensions.changed`。

## 8.6 练习

1. 用 `publish_plugin(action=list)` 查看暂存记录。
2. 发布第 7 步的 hello-plugin，读 `workspace/default/plugins/registry.json`，对照 manifest 与哈希。
3. 给两个 Agent 一个启用、一个不启用 preset，`list_tools` 对比。
4. `unregister_plugin` 卸载会话插件后，观察 `list_tools` 里 hello 消失。

## 下一步

[第 9 步：WebUI 与事件流](09-webui-and-events.md)

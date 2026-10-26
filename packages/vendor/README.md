# AgentChat preview —— cordis 本地 vendor 说明

## 状态（2026-08-15）

cordis 全家桶已完全本地化到 `preview/vendor/*`，并改挂 `@agentchat` 别名：

| 原包（@deepseek-ai） | 本地别名 | 目录 | 版本 |
|---|---|---|---|
| `cordis` | `@agentchat/cordis` | `vendor/cordis` | 4.0.1 |
| `cordis-plugin-loader` | `@agentchat/cordis-loader` | `vendor/loader` | 1.0.2 |
| `cordis-plugin-include` | `@agentchat/cordis-include` | `vendor/include` | 1.0.6 |
| `cordis-plugin-hmr` | `@agentchat/cordis-hmr` | `vendor/hmr` | 1.0.16 |
| `cordis-plugin-timer` | `@agentchat/cordis-timer` | `vendor/timer` | 1.1.3 |
| `cordis-plugin-logger-console` | `@agentchat/cordis-logger` | `vendor/logger` | 1.0.1 |
| `cosmokit` | `@agentchat/cosmokit` | `vendor/cosmokit` | 1.8.2 |
| `schemastery` | `@agentchat/schemastery` | `vendor/schemastery` | 3.18.1 |

- `pnpm-workspace.yaml` 已把 `vendor/*` 纳入 workspace。
- 所有 `@deepseek-ai/*` 依赖已从 package.json / cordis.yml / 源码 import 中移除。
- 魔改方式：直接编辑 `preview/vendor/<pkg>/src/*`（TS 源码）或 `lib/*`（产物）。
- 升级方式：临时安装原 `@deepseek-ai/*`，重跑 `node preview/scripts/vendor-deepseek.mjs`，核对本地修改后全量验证。

## 启动方式

```sh
cd preview
pnpm install
pnpm dev        # node --expose-internals --import tsx node_modules/@agentchat/cordis/bin.js
```

bin.js 创建一个根 Context、挂载 Loader 插件，并加载当前目录的 cordis.yml。
`--expose-internals` 供 `@agentchat/cordis-loader` 的 `ModuleLoader.fromInternal()`
读取 Node 内部 ESM loadCache（静态行 HMR 依赖；块 C）。

## 注意

- vendor 包均标记 private，不参与发布。
- `@agentchat/cordis-timer` 的服务名是 `ctx.timer`；AgentChat 自身定时任务服务已改名为
  `ctx.timerManager`（`@agentchat/timer`），两个 TimerService 不再冲突。
- 修改 vendor 源码后建议跑 pnpm typecheck && pnpm test && pnpm dev 验证。

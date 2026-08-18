# AgentChat 插件体系（一切皆插件）

> 版本：v0.6.2（2026-08-15）。AgentChat 运行在本地化的 **cordis 4** 之上：仓库内每个能力都是 `cordis.yml` 中的一个插件行，也可以被动态加载为工作区插件。

---

## 1. 插件的最小形状

一个 cordis 插件模块只需要导出两个东西：

```typescript
import type { Context } from '@agentchat/cordis';

export const name = 'agentchat-my-plugin';        // 全局唯一名（= preset id / owner）
export const inject = ['tools'];                   // 依赖的 ctx 服务（激活排序依据，可选）

export function apply(ctx: Context, config = {}) {
  // 在这里注册工具/钩子/服务/路由
  ctx.logger('my-plugin').info('已激活');
  // 可返回 dispose 函数（卸载时执行）
}
```

三种形态：

| 形态 | 例子 | 说明 |
|------|------|------|
| 服务行 | `tools/src/plugin` → `new ToolsService(ctx)` | 提供新的 `ctx.<service>`（cordis Service） |
| 能力行 | `fs/src/plugin` → `registerFsTools(ctx.tools, name)` | 消费已有服务，注册工具/钩子/路由 |
| 装配行 | `boot/src/plugin` → `new AgentsService(...)` | 聚合已有服务，构造共享实例 |

---

## 2. cordis.yml：唯一装配入口

```yaml
# 每行 = 一个插件；行序无激活语义，Loader 按 inject 自动排序
- name: '@agentchat/tools/src/plugin'      # 提供 ctx.tools
- name: '@agentchat/fs/src/plugin'         # inject: ['tools'] → 自动排在 tools 之后
- name: '@agentchat/boot/src/plugin'       # inject: agentLoop/llm/tools/hooks
```

规则：

- `name` 是模块说明符（相对路径或 npm 包名）。
- 插件导出的 `inject` 声明服务依赖；Loader 保证依赖先激活。
- 行可带 `id` 与 `config`，供上层 patch 覆盖。
- 删除某一行：依赖该服务的插件停在 PENDING，不崩进程；`boot/src/plugin-diagnostics` 5 秒后列出缺失服务。
- 静态 HMR 行 `@agentchat/cordis-hmr` **默认注释**：正式运行不做整个 `src` 的热更新；开发期热重载走 `register_plugin` 的 per-plugin watcher（见 §5.4）。

无 Loader 的兜底路径是 `boot/src/register-core.ts`（测试/嵌入式场景），与 cordis.yml 同构。

## 3. ctx 服务契约（v0.6.2 全量清单）

| ctx 服务 | 提供行 | 类型 | 说明 |
|----------|--------|------|------|
| `agentLoop` | agent-loop/src/plugin | AgentLoopService | ReAct 引擎入口 |
| `llm` | llm/src/plugin | LLMService | LLM 适配器工厂 |
| `tools` | tools/src/plugin | ToolsService | 工具注册中心 |
| `hooks` | hooks/src/plugin | HooksService | 钩子注册中心 |
| `pluginHost` | plugins/src/plugin | PluginHost | 动态插件装载器 |
| `http` | server/src/http-plugin | HttpRouteRegistry | HTTP 路由注册口 |
| `bootstrap` | boot/src/plugin | BootstrapCoreService | 装配核心（Assembly/Router/Registry/Loader） |
| `agents` | boot/src/plugin | AgentsService | registry + router 包装 |
| `workspace` | workspace/src/plugin | WorkspaceService | 工作区初始化结果 |
| `archive` | archive/src/plugin | ArchiveHostService | 归档编排 Manager |
| `timerManager` | timer/src/service-plugin | TimerService | TimerManager 宿主 |
| `subagent` | subagent/src/service-plugin | SubAgentService | SubAgentManager 宿主 |
| `l4` | server/src/service-plugin | ServerServicesHost | L4 门面聚合 |
| `webServerHost` | boot/src/plugin-finalize | WebServerHostService | WebUI 宿主契约 |
| `webui`（可选读取） | plugins 的 WebUIService / webui 行 | — | UI 扩展注册服务 |

## 4. 注册中心与 owner 语义

- `ctx.tools.register(owner, tools, { always, replace })` / `registerFactory(owner, factory)`
- `ctx.hooks.register(kind, name, factory, owner)`
- `owner` = 插件 `name` = Agent `presets` 中的 id：
  - Agent 声明 `presets` 时，只烘焙这些 owner 的注册；
  - `presets` 缺省 = 旧契约兼容（不过滤）；
  - 无主注册始终参与（兼容通道）。
- 动态插件卸载（PluginHost）时按 owner 精确回收。

## 5. 工作区插件（动态加载）

静态行之外，第三方插件以目录形式安装在 `workspace/default/plugins/`：

```
workspace/default/plugins/
├── registry.json          # 安装记录（manifest 快照 / 权限 / 哈希 / owner）
├── my-plugin/
│   ├── manifest.json
│   ├── index.ts
│   └── ui/                # 可选 UI 扩展
├── .staging/<id>/         # 待审查暂存
└── .backup/               # 被替换/卸载的旧版本
```

### 5.1 manifest.json

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "entry": "index.ts",
  "inject": ["tools"],
  "config": {},
  "permissions": ["fs", "network"],
  "provides": { "tools": ["hello"], "hooks": [] },
  "ui": { "entry": "ui/dist/index.js", "slots": ["tool-result"] },
  "description": "示例插件",
  "author": "me"
}
```

字段与校验规则详见 [plugins/core-agent-config.md](plugins/core-agent-config.md#pluginmanifest)。

### 5.2 权限模型

| 权限 | 默认 | 说明 |
|------|------|------|
| `fs` | 默认授予 | 读写文件 |
| `network` | 默认授予 | 网络访问 |
| `process` | 宿主显式授予 | 进程控制 |
| `shell` | 宿主显式授予 | 执行命令 |
| `ui` | 宿主显式授予 | UI 扩展（manifest.ui 必须带 ui 权限） |

`PluginHost.load()` 在 **import 之前** 校验权限——未授予的插件代码不进进程。授予快照写入 registry，重启恢复。

### 5.3 发布流程（发布 ≠ 启用）

```
publish_plugin(action=stage, name=..., dir=...)
  → 校验 manifest → 复制到 .staging →（有 ui 时 esbuild 打包）→ 计算 SHA-256 → 待审
publish_plugin(action=approve, id=..., grants=[...])
  → 哈希一致性校验 → 安装到 plugins/<name>/ → 写 registry.json（同名旧版进 .backup）
```

安装后插件在启动扫描时加载；**Agent 必须在 `config.presets` 里引用 `manifest.name` 才会真正启用**。

### 5.4 生命周期与热重载

- 同名重载：先回收旧 fiber 与 owner 的 tools/hooks 注册 → 激活新版本；失败自动回滚旧版本。
- `register_plugin` 加载的开发插件自动 watch：**只轮询该插件目录**（750ms 目录哈希），只重载该插件入口与 Fiber——不重载其他插件行、不重启进程；重载沿用首次授予的权限，不重新审批。入口 URL 带时间戳 cache-bust，插件内其它模块仍受 Node 模块缓存影响。
- 会话级插件（`register_plugin`）重启即失，且不允许覆盖同名已安装插件。
- 与静态 HMR 的区别：`@agentchat/cordis-hmr` 面向整个 `src`（当前默认注释），改动共享模块可能重载多个插件行，命中 externals（CLI 入口依赖树）时直接 `loader.exit()` 整进程重载。

### 5.5 插件市场与宿主契约

市场安装 = GitHub `topic:agentchat` 发现 → commit 钉定 → 安全解包 → **同一条 staging 审查管**；manifest 可声明 `"contracts": "^1"`，与宿主契约（`HOST_CONTRACTS_VERSION`）不兼容的插件在 import 之前被拒。入口三件：`agentchat plugin add …` CLI、`/api/plugins/market/*` HTTP、WebUI 插件库「市场」tab——同一信任边界，CLI 不开后门。详见 [plugins/market.md](plugins/market.md)。

## 6. 插件开发全景

| 想做什么 | 看哪里 |
|----------|--------|
| 注册一个新工具 | [tool-dev-guide.md](tool-dev-guide.md) + [plugins/tools.md](plugins/tools.md) |
| 注册一个新钩子 | [plugins/core-hooks.md](plugins/core-hooks.md) + 任一 agent-* 域的 register.ts |
| 完整目录/发布/UI 扩展 | [plugin-dev-guide.md](plugin-dev-guide.md) |
| 最小示例 | [plugins/hello.md](plugins/hello.md) |
| 每个内置包的能力清单 | [plugins/README.md](plugins/README.md) |

## 7. 与旧架构的对应关系（快速迁移视角）

| 旧（v0.5.x） | 新（v0.6.2） |
|--------------|--------------|
| `src/plugins/builtin` 单块 | 拆为 fs/shell/web/dev/session-tools/restart/interaction/timer/subagent/math + agent-* 扩展域，每域一行 |
| 手工 `ctx.plugin()` 嵌套 + `new Service` | cordis.yml 行 + inject 自动排序（registerCoreServices 兜底同构） |
| `src/services/*` 门面 | `server/src/service-plugin` 持有 ctx.l4 |
| `src/app/index.ts` bootstrap | `boot/src/plugin` + workspace/finalize/diagnostics 四行 |
| 旧 `plugins:[{name:"builtin",...}]` 配置 | 新 `presets/tools/hooks`；旧名经别名归一化兼容 |
| preview 双轨 | 已整体切换 src（v0.6.2），历史见 [archive/block-e-migration.md](archive/block-e-migration.md) |

# AgentChat 插件开发指南

> 版本：v0.6.2。本文走完「写一个插件 → 会话级加载调试 → 发布进插件库 → Agent 启用」的完整闭环。
> 前置阅读：[plugin-system.md](plugin-system.md)；纯工具开发可先看 [tool-dev-guide.md](tool-dev-guide.md)。

---

## 1. 目录骨架

```
workspace/default/plugins-dev/hello-plugin/      # 开发目录（任意位置均可）
├── manifest.json
├── index.ts                                    # 后端插件入口
└── ui/
    └── index.ts                                # 可选：UI 扩展入口
```

`manifest.json`：

```json
{
  "name": "hello-plugin",
  "version": "1.0.0",
  "entry": "index.ts",
  "inject": ["tools", "hooks"],
  "permissions": ["fs"],
  "provides": { "tools": ["hello"], "hooks": ["hello-plugin.on-start"] },
  "description": "打招呼示例插件",
  "author": "me"
}
```

约束（`validatePluginManifest` 强制）：
- `name`：小写字母/数字/连字符，字母数字开头；
- `version`：semver；
- `entry`：插件目录内相对路径（默认 `index.ts`）；
- `permissions` 只接受 `fs / network / process / shell / ui`；声明 `ui` 时 permissions 必须含 `ui`。

## 2. 插件入口（index.ts）

```typescript
// index.ts —— 最小插件三要素：name / inject / apply
import type { Context } from '@agentchat/cordis';
import type { ToolsService } from '@agentchat/tools';
import type { HooksService } from '@agentchat/hooks';

export const name = 'hello-plugin';
export const inject = ['tools', 'hooks'];

export function apply(ctx: Context) {
  // 1. 注册一个共享工具（owner = 本插件名 = preset id）
  ctx.tools.register(name, [{
    name: 'hello',
    label: '打招呼',
    requires: ['base'],
    description: '返回一句问候。参数 name 表示向谁问好。',
    definition: {
      type: 'function',
      function: {
        name: 'hello',
        description: '返回一句问候',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '向谁问好' },
          },
          required: ['name'],
        },
      },
    },
    async execute(args) {
      return JSON.stringify({ status: 'ok', data: { greeting: `你好，${args.name}！` } });
    },
    extractLabel: (args) => `hello ${args.name}`,
  }]);

  // 2. 注册一个 runStart 钩子（顺序表由 Agent config.hooks 决定）
  ctx.hooks.register('runStart', 'hello-plugin.on-start', () => async (runCtx) => {
    ctx.logger('hello-plugin').info(`run 开始：${runCtx.agentId}`);
  }, name);

  ctx.logger('hello-plugin').info('已激活');
}
```

要点：
- `ctx.tools.register(owner, tools, { always, replace })`：共享工具；需要 per-Agent 配置（沙箱/身份/服务引用）时改用 `ctx.tools.registerFactory(owner, (config, services) => [...])`。
- `ctx.hooks.register(kind, hookName, factory, owner)`：工厂签名 `(config, services) => hook`，由 `config.hooks` 顺序表驱动执行。
- `apply` 可返回 dispose 函数，卸载时执行（Service 注册通常自带清理）。

## 3. 会话级加载与热调试

对 Agent 说（或调用工具）：

```
register_plugin(name="hello-plugin", dir="workspace/default/plugins-dev/hello-plugin")
```

- 需要 `admin` 标签（`register_plugin` requires: ['admin']）。
- `dir` 可省略：缺省为 `<workspace>/plugins/<本AgentId>/hello-plugin/`。
- 加载后**自动开启源码 watch**（目录哈希 750ms 轮询，改动即热重载，失败保留旧版本），并**自动把 `manifest.name` 追加进本 Agent 的 `config.presets`** + 触发 self reload——工具立即可用；钩子仍需在 `config.hooks` 顺序表中引用才会执行。
- **watch 作用域**：只轮询该插件目录（排除 `node_modules/.git/.staging/.backup`），只重新 import 该插件入口并替换它自己的 Fiber 与 owner 注册——**不会重载其他插件行、不会重启进程**。这与根 `cordis.yml` 里默认注释掉的 `@agentchat/cordis-hmr`（面向整个 `src` 的静态 HMR，可能触发整进程 `loader.exit()`）是两套机制。
- **热重载的缓存边界**：入口 URL 会带时间戳 cache-bust；插件目录内其它模块被入口相对 import 时仍走 Node 模块缓存，非入口文件的改动不一定立即生效，稳妥做法是改动落在入口文件，或重新 `register_plugin`。
- **安全边界**：watch 重载**沿用首次授予的权限、不需要再次审批**。后端插件代码在宿主进程内执行，`manifest.permissions` 只是 import 前的声明门，不是运行时沙箱——所以 `register_plugin` 只应用于「自己正在开发的、可信目录」，不要加载来路不明的插件。
- 会话级插件重启即失；同名已安装插件时拒绝会话级覆盖。
- `grants` 参数显式授予 process/shell/ui（fs/network 默认授予）。

手动验证：

1. `register_plugin` 已自动把 `"hello-plugin"` 追加进本 Agent presets（WebUI 插件装配页可看到）；
2. `list_tools` 应看到 `hello`；
3. 对话中说「用 hello 跟小明打个招呼」，工具执行成功即闭环。

> TS 插件在 tsx/vitest 运行态加载；发布前保证入口可被 Node ESM 解析（入口是 `.ts` 时开发模式可用，发布产物建议提供可执行 JS 或依赖宿主 tsx）。

## 4. 发布进插件库（发布 ≠ 启用）

使用 `publish_plugin` 工具（requires: admin）：

| action | 参数 | 说明 |
|--------|------|------|
| `stage` | `name`、`dir?` | 校验 manifest → 复制 `.staging/<id>/` → 计算 SHA-256 → 返回审查 id；`dir` 缺省 `<ws>/plugins/<本AgentId>/<name>/` |
| `approve` | `id`、`grants?` | 人审通过后安装 `plugins/<name>/` + 写 `registry.json`；`grants` 显式授予 process/shell/ui |
| `list` | — | 列出待审暂存 |

- 审批前可在 WebUI「插件库 → 暂存审查」逐文件查看（HTTP 只读代理 + 路径守卫 + 1 MiB 上限）。
- 同版本重复发布会被拒绝；新版本安装时旧版本移入 `.backup`。
- 安装后**立即在当前进程加载**，重启后由启动扫描自动加载；Agent 必须把 `manifest.name` 写进自己的 `presets` 才启用。

## 5. UI 扩展（可选）

`manifest.json` 增加：

```json
"permissions": ["fs", "ui"],
"ui": {
  "entry": "ui/dist/index.js",
  "slots": ["tool-result", "perspective", "settings-tab:global"]
}
```

- 可用 slot（宿主白名单）：`perspective`、`tool-result`、`message-view`、`ws-event`、`settings-tab:global`、`settings-tab:agent`、`sidebar-action`、`global-style`。
- `stage` 时若没有预构建产物，宿主用 esbuild 把 `ui/index.ts` 打成 `ui/dist/index.js`（bundle: esm，platform: browser，external: vue）。
- `"isolated": true` 时 UI 在 iframe 隔离容器中运行，只能经受限桥接访问宿主（P5.5）。
- UI 扩展契约见 [plugins/protocol.md](plugins/protocol.md) 与 [plugins/webui.md](plugins/webui.md)。

## 6. 权限模型

| 权限 | 默认 | 授予方式 |
|------|------|----------|
| fs / network | ✅ 默认授予 | 无需显式 |
| process / shell / ui | ❌ | `publish_plugin approve` 的 `grants`，或 `register_plugin` 的 `permissions` |

`PluginHost.load()` 在 import 前校验；授予快照写入 registry，重启恢复。

## 7. 测试建议

```typescript
// tests 里用 cordis Context 手搭最小环境（不依赖完整 boot）
import { Context } from '@agentchat/cordis';
import * as toolsPlugin from '@agentchat/tools/src/plugin';
import * as hooksPlugin from '@agentchat/hooks/src/plugin';
import * as myPlugin from '../src/index';

const ctx = new Context();
await ctx.plugin(toolsPlugin);
await ctx.plugin(hooksPlugin);
await ctx.plugin(myPlugin);

const cfg = { agent_id: 't', name: 'T', presets: ['hello-plugin'], tags: ['base'] };
const tools = ctx.tools.resolveTools(undefined, cfg, {});
// expect(tools.has('hello')).toBe(true)
```

> `ctx.plugin()` 必须传**模块对象**（namespace import）而不是裸 `apply` 函数，否则 cordis 读不到 `inject` 声明。

## 8. 检查清单

- [ ] manifest name/version/entry 合法，provides 与实际注册一致
- [ ] `inject` 声明完整（缺服务时 PluginHost 会在装载前报错）
- [ ] owner 全部使用插件 `name`（否则动态卸载无法回收）
- [ ] 权限声明最小化；高危权限走 approve grants
- [ ] 会话级 watch 调试通过后，发布 → Agent presets 启用 → `list_tools` 验证
- [ ] UI 扩展有 `ui` 权限，slot 在白名单内

## 9. 参考实现

- 最小示例：[plugins/hello.md](plugins/hello.md)（`src/examples/hello`）
- 工具插件：`src/fs/fs`、`src/math/math`、`src/agent-tools/agent-tools`
- 钩子插件：`src/agent-prompt/agent-prompt`、`src/agent-memory/agent-memory`
- 服务插件：`src/tools/tools`、`src/hooks`、`src/plugins/plugins`
- 动态插件系统实现：`src/plugins/plugins/src/{host,registry,permissions}.ts`

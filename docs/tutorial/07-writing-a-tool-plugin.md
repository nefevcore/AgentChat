# 第 7 步：开发第一个工具插件

> 目标：动手写一个带工具 + 钩子的插件，用 watch 热调试，再发布进插件库。
> 完整版指南：[plugin-dev-guide.md](../plugin-dev-guide.md)。

## 7.1 建目录

```
workspace/default/plugins-dev/hello-plugin/
├── manifest.json
└── index.ts
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

## 7.2 写插件

`index.ts`：

```typescript
import type { Context } from '@agentchat/cordis';

export const name = 'hello-plugin';
export const inject = ['tools', 'hooks'];

export function apply(ctx: Context) {
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
          properties: { name: { type: 'string', description: '向谁问好' } },
          required: ['name'],
        },
      },
    },
    async execute(args) {
      return JSON.stringify({ status: 'ok', data: { greeting: `你好，${args.name}！` } });
    },
    extractLabel: (args) => `hello ${args.name}`,
  }]);

  ctx.hooks.register('runStart', 'hello-plugin.on-start', () => async (runCtx) => {
    ctx.logger('hello-plugin').info(`run 开始：${runCtx.agentId}`);
  }, name);

  ctx.logger('hello-plugin').info('已激活');
}
```

## 7.3 会话级加载 + 热调试

对 admin 标签的 Agent 说：

```
register_plugin(name="hello-plugin", dir="workspace/default/plugins-dev/hello-plugin")
```

- `dir` 可省略（缺省 `<ws>/plugins/<本AgentId>/hello-plugin/`）；`grants` 用于显式授予 process/shell/ui。
- 加载后**自动开启 watch**：只监听**本插件目录**（750ms 哈希轮询），只重载本插件实例——不会热重载整个项目，也不会重启进程；重载失败保留旧版本。
- 注意：watch 重载**沿用首次授予的权限、不再审批**，且插件代码在宿主进程内执行（manifest.permissions 只是 import 前的声明门，不是运行时沙箱）——只加载自己正在开发的代码。
- 加载后**自动把 `hello-plugin` 追加进本 Agent 的 `config.presets`** 并触发 self reload，新工具立即可用；
- 会话级插件重启即失。

## 7.4 验证

`register_plugin` 已自动把 `hello-plugin` 追加进 presets 并触发 self reload，直接验证：

1. `list_tools` 出现 `hello`；
2. 对话：「用 hello 跟小明打个招呼」→ 工具返回 `你好，小明！`；
3. 钩子是顺序表驱动的：`register_plugin` 只追加 presets、不追加 hooks。要让第 3 步的日志出现，需在本 Agent `config.hooks.runStart` 加 `"hello-plugin.on-start"` 后 reload。

（发布到插件库后，其他 Agent 需要手动在自己的 `config.presets` 加 `"hello-plugin"`，再 `reload(scope=global)`。）

## 7.5 发布进插件库

对 admin Agent：

```
publish_plugin(action="stage", name="hello-plugin", dir="workspace/default/plugins-dev/hello-plugin")
# → 返回 staging id
publish_plugin(action="approve", id="<id>", grants=["fs"])
```

或在 WebUI「插件库」页面完成暂存审查与批准。发布后：

- 插件安装到 `workspace/default/plugins/hello-plugin/`，写入 `registry.json`（含 SHA-256 与权限快照），**立即在当前进程加载**；
- 重启后由启动扫描自动加载，但其他 Agent 仍要 `presets` 引用才启用——发布 ≠ 启用（approve 不会回写 presets）。

## 7.6 练习

1. 给 hello 工具加一个 `times` 参数（重复次数），保存后看 watch 自动重载。
2. 故意写坏 index.ts（语法错误），观察自动重载失败但旧版本仍在。
3. 把插件发布后 `unregister_plugin`，观察 owner 回收（`list_tools` 里 hello 消失）。

## 下一步

[第 8 步：动态插件与插件库](08-dynamic-plugins-and-library.md)

# @agentchat/hello

> `src/examples/hello` · `@agentchat/hello` 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述

最小 cordis 4 插件示例，用于验证 monorepo 链路：`@agentchat/cordis-loader` 从根 `cordis.yml` 加载条目 → 注入 `@agentchat/cordis` Context → `@agentchat/schemastery` 校验 config → 输出日志。完整演示 cordis 4 插件三要素：`name` + `Config` Schema + `apply(ctx, config)`（函数形态，无需 class）。

## 目录

| 文件 | 说明 |
|---|---|
| `src/index.ts` | 唯一源文件（25 行）：`name`、`Config` 接口与 Schema、`apply` |
| `package.json` | 依赖 `@agentchat/cordis` 与 `@agentchat/schemastery`（均为 workspace） |

## 插件行

| 模块文件 | 插件 name | inject | 提供/注册内容 |
|---|---|---|---|
| `src/index.ts` | `hello` | 无（不依赖任何服务） | 对每个 `config.targets` 打印 `${greeting}, ${target}!`：`console.log` + `ctx.logger('hello').info` 双通道输出；不注册 ctx 服务、不返回 disposer |

## 提供的能力

无业务能力；仅提供链路验证输出。加载成功后应在 stdout 与控制台日志中看到 greeting 行：

```
Hello, preview!
Hello, cordis-4!
Hello, monorepo!
```

## 关键契约 / API

| 项 | 说明 |
|---|---|
| `export const name = 'hello'` | 插件唯一标识（Loader 据此注册与定位） |
| `export interface Config` | 配置类型：`greeting: string`、`targets: string[]` |
| `export const Config: Schema<Config>` | Schemastery 校验：`Schema.object({ greeting: Schema.string().default('Hello'), targets: Schema.array(String).default(['agentchat']) })` |
| `export function apply(ctx: Context, config: Config)` | 插件入口；`ctx.logger('hello')` 获取命名 logger；无返回值（无 disposer） |

源码形态（`src/examples/hello/src/index.ts`）：

```ts
import type { Context } from '@agentchat/cordis';
import Schema from '@agentchat/schemastery';

export const name = 'hello';

export interface Config {
  greeting: string;
  targets: string[];
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  targets: Schema.array(String).default(['agentchat']),
});

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('hello');
  for (const target of config.targets) {
    const line = `${config.greeting}, ${target}!`;
    console.log(line);
    logger.info(line);
  }
}
```

要点：

- `Config` 类型与 `Config` 值同名是合法且推荐写法：类型供 `apply` 参数推断，值供 Loader 做运行时校验。
- `Schema.array(String)` 是 `Schema.array(Schema.string())` 的简写（schemastery 简写语法）。
- `default()` 在 config 缺省或字段为 null 时自动填充默认值；因此不写 `config.targets` 也会打印默认的 `agentchat`。
- `apply` 不返回函数即无 cleanup；如需清理，返回 disposer 即可（本示例无需）。

## 配置

根 `cordis.yml` 中的链路验证行（位于文件末尾）：

```yaml
- name: '@agentchat/hello'
  config:
    targets: ['preview', 'cordis-4', 'monorepo']
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `greeting` | `'Hello'` | 问候语前缀 |
| `targets` | `['agentchat']` | 逐一打印的目标名列表 |

## 与其他插件的关系

- 依赖：`@agentchat/cordis`（Context 类型与运行时）、`@agentchat/schemastery`（配置校验）。
- 由 `@agentchat/cordis-loader` 从 `cordis.yml` 加载；排在文件末尾，作为所有基建/能力/业务行之后的上电自检。
- 不 inject 任何服务，因此 Loader 可把它排在任意位置（无依赖约束，不阻塞其他行）。
- 与 `@agentchat/cordis-logger` 间接协作：`ctx.logger('hello')` 的输出由控制台 logger exporter 呈现。

## 测试

无独立测试。验证方式：`pnpm dev` 启动后观察控制台/日志中 `Hello, preview!` `Hello, cordis-4!` `Hello, monorepo!` 三行输出，即证明 Loader → cordis → Schemastery → logger 链路正常。

## 相关文档

固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)

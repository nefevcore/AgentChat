# @agentchat/math
> 包路径 `src/math/math` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
数学工具包。单个通用 `math` 工具：接收表达式字符串，用 `node:vm` 沙箱求值。零 npm 依赖（不用 mathjs），仅 Node 内置 `vm` + Math 白名单，timeout 兜底防死循环。领域独立，可脱离 AgentChat 复用。

## 目录（关键源文件 + 一句话）
| 文件 | 说明 |
| --- | --- |
| plugin.ts | cordis 插件行，注册 math 工具 |
| register.ts | `registerMathTools(tools, owner)` 直接注册（非工厂） |
| tools.ts | `mathTools` 数组 + `evaluateExpression` vm 沙箱求值 |

## 插件行
| 模块文件 | 插件 name | inject | 提供/注册内容 |
| --- | --- | --- | --- |
| plugin.ts | agentchat-math | tools | `tools.register(owner, mathTools)` 注册 1 个共享工具（math） |

与其余工具包不同：math 是无 per-Agent 烘焙的共享工具，直接 `tools.register` 而非 `registerFactory`。

## 提供的能力
### 工具表
| 工具 | label | requires | 要点 |
| --- | --- | --- | --- |
| math | 数学 | base | node:vm 沙箱、超时 2000ms、全局白名单 |

## 工具参考
| 工具 | name | label | requires | 主要参数 | 行为要点 |
| --- | --- | --- | --- | --- | --- |
| math | math | 数学 | base | expression（必填） | 支持 `+ - * / % ** ( )` 与常用函数；`vm.runInContext(expression, ctx, {timeout: 2000})`；数字结果 `toPrecision(15)` 归一化（0.1+0.2 → 0.3，`<1e-12` 归 0）；bigint 转字符串；无返回值/语句结尾报错 |

## 关键契约 / API
```ts
export const mathTools: Tool[] = [defineTool({ name:'math', ... })]
function evaluateExpression(expression: string): { ok: true; value: string } | { ok: false; message: string }  // 文件内函数
function makeSandbox(): Record<string, unknown>  // 沙箱白名单
```
- 沙箱白名单全局：`Math`、`JSON`、`Number`、`BigInt`、`Infinity`、`NaN`、`parseFloat`、`parseInt`、`isNaN`、`PI`（`Math.PI`）、`E`（`Math.E`）。
- 常用 Math 函数全局化（无需 `Math.` 前缀）：`sqrt`、`pow`、`abs`、`floor`、`ceil`、`round`、`min`、`max`、`sin`、`cos`、`tan`、`log`、`log2`、`log10`、`exp`、`trunc`、`sign`、`cbrt`、`hypot`、`random`。
- 返回规则：number → 精度归一化字符串；bigint → 十进制字符串；undefined → 「表达式无返回值（请确保以表达式结尾，不要用分号/语句）」；异常 → 错误信息。
- 安全边界：`vm.createContext` 隔离全局，表达式看不到 `process` / `require` / `globalThis` / IO。

## 配置
本包无自有配置命名空间，无配置项。

## 与其他插件的关系
package.json 依赖：`@agentchat/agent-loop`、`@agentchat/toolkit`、`@agentchat/tools`、`@agentchat/cordis`。

使用方：工具经 `ctx.tools` 注册；由 cordis.yml 挂载（inject: ['tools']），registerCoreServices 的无 Loader 兜底同样经本插件行挂载。

## 表达式示例
| 表达式 | 结果 | 说明 |
| --- | --- | --- |
| `1+2*3` | `7` | 基础运算 |
| `sqrt(16)` | `4` | 函数已全局化 |
| `2**10` | `1024` | 幂运算 |
| `sin(PI/2)` | `1` | 常量与函数 |
| `0.1+0.2` | `0.3` | `toPrecision(15)` 精度归一化 |
| `Math.floor(3.7)` | `3` | 也支持 `Math.*` 前缀 |
| `10n**20n` | bigint 十进制字符串 | 大整数 |

## 错误返回
| 场景 | 返回 |
| --- | --- |
| 缺少 expression | `{status:'error', data:{message:'缺少 expression 参数'}}` |
| 表达式以分号/语句结尾 | `{status:'error', data:{expression, message:'表达式无返回值…'}}` |
| 沙箱超时（2000ms）或运行异常 | `{status:'error', data:{expression, message:<err.message>}}` |

## 备注
- 与 `register_tool`（dev 包）的沙箱不同：math 不提供 `Promise` / `Array` / `Object` / `Date` / `console`，只注入数学求值所需最小集合。
- `random` 已全局化，但 LLM 不应依赖它生成需要可复现的随机数。
- 浮点归一化边界：绝对值 `< 1e-12` 的结果直接归 0，避免 `-0` 与极小误差。
- 表达式以 `(expr)` 形式传入 `vm.runInContext` 的字符串求值，实际执行的是 JS 表达式语义。
- `evaluateExpression` 为文件内函数（未 export），对外契约是 `mathTools` 数组；上文签名用于说明实现。

## 测试
package.json 仅 `typecheck`（tsc --noEmit），无 test 脚本。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)

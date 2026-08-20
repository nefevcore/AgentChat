# @agentchat/agent-persona
> 包路径 `src/agent-persona/agent-persona` · 版本 0.1.0 · 文档对应 v0.6.3（2026-08-16）

## 概述

Agent 人设注入扩展。自 `@agentchat/agent-prompt` 拆出（v0.6.3 二次拆分：
先拆钩子，再拆独立插件包）：人设装配与框架装配彻底解耦，可按 Agent 单独
挂载/摘除（presets + hooks 清单控制）。

## 装载优先级

1. `<agentDir>/AGENT.md`（目录实体，支持本地覆盖预设定义）
2. `config.persona`（内联，预设 Agent 定义携带，loader 装入）

均无 → 不注入（standard 预设保持无人设）。

## 注入语义

- runStart 钩子 `agent-persona.persona`：`<persona>...</persona>` 标签包裹、
  无标题行，**前置**到 `ctx.systemPrompt`（agent-prompt 框架块追加其后；
  两种钩子顺序收敛到同一结构）。
- `SYSTEM.md` 存在时跳过（完全覆盖语义：SYSTEM.md 即完整提示词）。
- 无会话键（子 Agent）不装配，与 build-system-prompt 对齐。
- 预览组合装配：`buildSystemPromptWithPersona`（AgentService.getAgentSystemPrompt
  使用，与运行时钩子链同构）。

## 插件行

| 模块文件 | 插件 name | inject | 注册内容 |
| --- | --- | --- | --- |
| `plugin.ts` | `agentchat-agent-persona` | `['hooks']` | runStart 钩子 `agent-persona.persona`（owner = 插件 name） |

推荐排在 `agent-prompt.build-system-prompt` 之前（角色块先行写入）；
后置亦兼容（本钩子前置注入，两种顺序收敛到同一结构）。

## 测试

测试文件：`tests/persona.test.ts`（AGENT.md 优先 / 内联回退 / SYSTEM.md
跳过 / 空白视同无人设 / 钩子顺序无关收敛）。

## 相关文档

固定链接：[插件索引](./README.md) · [agent-prompt.md](agent-prompt.md) · [agent-datetime.md](agent-datetime.md)

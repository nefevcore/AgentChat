# @agentchat/agent-skill
> 包路径 `src/agent-skill/agent-skill` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述

Agent 技能域：自 `@agentchat/agent-prompt` 拆出的独立插件。runStart 钩子
`agent-skill.discovered_skills` 发现 `<agentDir>/skills/*/SKILL.md`，解析
frontmatter，渲染 `<available_skills>` 区块并追加到 `ctx.systemPrompt` 末尾。

## 目录（关键源文件 + 一句话）

| 文件 | 职责 |
| --- | --- |
| `plugin.ts` | cordis 插件行：`agentchat-agent-skill`，inject `hooks` |
| `register.ts` | 注册 runStart 钩子 `agent-skill.discovered_skills` |
| `skills.ts` | SKILL.md 发现、frontmatter 解析、`<available_skills>` 渲染与钩子工厂 |
| `index.ts` | 统一 re-export |

## 插件行

| 模块文件 | 插件 name | inject | 注册内容 |
| --- | --- | --- | --- |
| `plugin.ts` | `agentchat-agent-skill` | `['hooks']` | runStart 钩子 `agent-skill.discovered_skills`（owner = 插件 name） |

## 提供的能力

### 钩子

| 钩子 | 阶段 | 行为 |
| --- | --- | --- |
| `agent-skill.discovered_skills` | runStart | `agent.prompt.skills !== false` 时：`resolveAgentDir` → `discoverSkills` → `buildSkillsBlock` → 追加到 `ctx.systemPrompt` |

### SKILL.md 发现规则

- 技能路径：`<agentsDir>/<agentDirName>/skills/<dirName>/SKILL.md`。
- 仅扫描 `skills/` 下**目录**，读取每个子目录的 `SKILL.md`。
- frontmatter 解析：
  - `name: value`（单行，去引号；缺省回退目录名）。
  - `description: value`（单行）或 `description: |` 多行块（去缩进、合并为一行）。
  - 无 frontmatter 或解析失败 → 该技能被跳过（返回 `null`）。
- 技能清单按 `name` 升序排序（`localeCompare`）。

### 渲染规则（`buildSkillsBlock`）

- 无技能 → 返回空串。
- 区块标题 `## 可用技能`；提示：任务匹配时用 `read` 加载 SKILL.md，相对路径相对技能目录解析。
- 每个技能渲染为：

```xml
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>./agents/<agentDirName>/skills/<dirName>/SKILL.md</location>
  </skill>
</available_skills>
```

- XML 转义 `& < > " '`；`description` 超过 200 字符截断为前 197 字符 + `...`。

## 关键契约 / API

| API | 签名 | 说明 |
| --- | --- | --- |
| `SkillManifest` | `{ name: string; description: string; dirName: string }` | 技能清单 |
| `parseSkillFrontmatter` | `(skillMdPath: string, dirName: string) => SkillManifest \| null` | frontmatter 解析 |
| `discoverSkills` | `(agentDir: string) => SkillManifest[]` | 扫描 skills 目录并排序 |
| `buildSkillsBlock` | `(skills: SkillManifest[], agentDirName: string) => string` | 渲染 `<available_skills>` |
| `makeInjectSkillsHook` | `(config, services: ToolContext) => RunStartHook` | 钩子工厂 |
| `registerSkillHooks` | `(hooks, owner) => void` | 注册入口 |

## 配置

- 本包不声明独立配置命名空间；复用 `agent.prompt.skills`（`NS_AGENT_PROMPT`）开关，
  默认 `true`，仅当显式 `false` 时跳过技能发现。
- 需要 `services.agentsDir`；为空或 `resolveAgentDir` 失败时静默跳过。

## 与其他插件的关系

- 依赖（package.json）：`@agentchat/agent-config`、`@agentchat/agent-loop`、
  `@agentchat/hooks`、`@agentchat/toolkit`（`NS_AGENT_PROMPT`）、
  `@agentchat/tools`（`ToolContext`）、`@agentchat/util`、`@agentchat/cordis`。
- 与 `agent-prompt` 协同：`agent-prompt.build-system-prompt` 默认装配中预留“技能清单”
  槽位但不再自行注入；本插件负责实际发现与注入，执行顺序声明置于 `open-mcp` 前。

## 测试

`package.json`：仅 `typecheck`（无 test script）。包内未发现独立测试文件。

## 相关文档

固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)

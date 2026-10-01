# Bug：ac-sap-adt 配置层错位（UI 面写死键）

> **已修复（2026-09-04，方向 A——对齐 mcp 语义）**：`enabledNow()` 拆为
> 行 config 硬停（boot 不注册）+ `settings['sap-adt'].enabled` 热启停
> （`settingsOf` 合成：全局默认层 ∪ Agent 差异层）；执行期
> `tool/before-execute` veto + `loop/before-run` 暴露面收敛双防线；
> extension.listeners 声明 respectsEnabled。`sap-adt:` 顶层段裁决为
> **引擎域**（destinations/policy/configFile——进程级、非弹窗面）。
> 以下为修复前的记录原文。

> 2026-09-04 全行"误判进程级"审计发现（同族问题：ac-mcp 已修，见
> CHANGELOG Unreleased「MCP 可配置面 II」）。**本文档只记录，不动代码——
> 由维护者自行选择修复方向。**

## 现象

插件库与 Agent 设置页都出现「SAP ABAP ADT 工具行」的软停用开关，但
**开关怎么点都不生效**：

- 插件库「插件配置」卡片行尾开关写 `config.json → settings.sap-adt.enabled`
  （`config/set`，`configNs='sap-adt'`），提示"立即生效（config/changed 热更）"。
- Agent「插件配置」页同理（差异层 `settings['sap-adt'].enabled`，非 automatic
  行还会出现 per-Agent 行尾开关）。

两者写入的键**行代码从不读取**——纯死配置面。

## 根因（层错位）

扩展自述声明了 `fields`，但行读取的是另外两个层：

| 面 | 键 | 位置 |
|---|---|---|
| UI 开关写 | `settings['sap-adt'].enabled` | `src/webui/src/settings/api.ts` setGlobalSetting → `config/set { key: 'settings.sap-adt' }` |
| 行实际读 ① | 行 config `enabled` | `src/ac-sap-adt/src/index.ts` `enabledNow()`（约 L136：`options.enabled === false → false`） |
| 行实际读 ② | `config.json` 顶层 `sap-adt:` 段 | `globalSectionOf()`（约 L105：`config.get('sap-adt')`——顶层域，**不是** `settings` 域） |

即 `enabledNow()` 的合成链是 `行 config ∧ config.json 顶层 sap-adt 段`，
与 UI 写入的 `settings.sap-adt` 域完全不相交。次要矛盾：字段自述
"改后重载行生效"与开关文案"立即生效（config/changed 热更）"互相打架
（行也确实监听了 config/changed —— 但读的是另一个域）。

## 修复方向（二选一）

### A. 对齐 mcp 语义（推荐——平台标准分层词汇）

- `enabledNow()` 改为读合成层：`ctx.agents.settingsOf(agentId, 'sap-adt')`
  的 `enabled`（全局默认层 ∪ Agent 差异层；无身份场景回落全局层）。
- 工具行的 per-Agent 语义 = **注册进池 + 执行期收敛**：47 个 adt_* 工具
  全局注册不变（boot 期无 run 身份），per-Agent 停用经执行身份自查
  （`tool/before-execute` 拦截 or 工具体内 `call.agentId` 查
  `settingsOf(...).enabled === false` → veto/报错），可见性可选走
  `loop/before-run` 收敛 `request.tools`（参照 ac-mcp `scopeForAgent`）。
- 行 config 与 `sap-adt:` 段的 `enabled` 保留为基线层（合成链底座）。
- 顺带裁决：`sap-adt:` 顶层段（destinations/configFile/allowDebugger 等）
  是全局唯一域还是并入 `settings.sap-adt` 全局默认层——并入则弹窗可配，
  保留则文档写明"进程级、非弹窗面"。

### B. 收缩声明（最小改动）

- 撤掉 `extension.fields`（或整段 `extension` 自述）——`configNs` 不再
  透出，UI 不开面；启停只经行 config / `sap-adt:` 段（进程级，明示）。
- 一行删除，零行为风险；代价是失去 per-Agent / 弹窗配置能力。

## 验证建议

- A 方向：`config.set('settings.sap-adt', { enabled: false })` → adt 工具
  对应 Agent 不可用（热更生效，无需重载行）；差异层 `enabled: true` 覆盖
  全局 `false`；行 config `enabled:false` 仍硬停。
- B 方向：`plugin/extension-catalog` 不再含 `sap-adt` 条目（或无 `configNs`），
  插件库/Agent 页开关消失。
- 回归：`src/webui/tests/portb-e2e.test.ts` 扩展目录名单断言需随 B 调整。

## 同族背景

平台约定（`AgentConfig.settings` 契约注释，ac-agents/src/service.ts）：
扩展插件经 `loop/before-run` 等事件按 `request.agent` 查
`ctx.agents.settingsOf(id, '<name>')`——全局默认层 ∪ Agent 差异层合成，
数组整体替换、差异层键优先。**声明了 `fields` 就必须消费这个合成层**；
只认行 config / 自有顶层域的行，不应声明 `fields`。

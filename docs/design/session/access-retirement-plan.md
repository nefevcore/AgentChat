# access 轴退役计划（access-retirement-plan）

> 性质：实施计划——access 三档体系整体退役：沙箱常量化、full 统一为权限门裁决（cr-1078/1079 审批轴的自然收口）。
> 状态：现行 · cr-1082 2026-11-14 · 前序 cr-1078（risk 分级/allow≠full 论证）、cr-1079（四层设置链）、conv-scope-plan（批 3 写面收口）。
> 读者：权限域与工具行维护者（实施前通读 §一/§二；与 conv-scope-plan 的接续关系见 §五）。

## 一、背景与裁决

**用户裁决（2026-11-14）**：access 本质上是 approval 操作——base 实际就是 sandbox（Agent 无配置时的回退词），遇危险操作询问、无人场景按配置拒绝/通过；full 直接全通过。access 属性整体退役。

**代码证据链（2026-11-14 勘察）**：

1. **执行面只有两态**：工具执行链（fs-tools/shell-tools/fs-search/sre/sandbox-core）对 `sandbox-access` 零分支——所有边界判定只区分 full 与非 full（白名单 resolveSafePath、readDeny 跳过、命令扫描跳过）。sandbox 相对 base 无任何执行面差异，是安慰剂档。
2. **使用面没有第三态**：会话 access 键 857 个全为 full-access（sandbox=0、base=0）；Agent 侧 4 full + 8 sandbox（旧 tier 字段，sandbox 与不配置等价）。
3. **full 的真实身份是审批**：ToolCall.access 合法来源三处（contract.ts）——event 信封（上限 sandbox）/ subagent 继承 / 审批注入（人批了才 full）。cr-1078 安全论证已确立「allow 直通后沙箱轴照拦（D9）」——审批轴已在做安全决策，access 独立配置无剩余职责。

**终态模型**：

```
执行边界两态：沙箱（常量，所有人的缺省执行态）｜full（唯一授权态，只能由门注入）
full 的来源（唯一正路）：权限门决策序 5 的「通过」——弹卡批准（单次/run）或设置链 allow（预授权）
危险操作语义：沙箱态遇 ask 建议 → 有人问人（弹卡）/ 无人按设置链（allow 过 / 缺省拒）——即 base 档的历史语义，收归审批轴
```

**行为变更点（需显式裁决）**：现行设置链 allow 放行**不注入 full**（沙箱照拦）；统一后「通过即 full 执行」要求设置链 allow 路径补 full 注入——与弹卡批准同权。这是本计划的核心语义变更：审批轴成为 full 的唯一发放者。

## 二、退役清单（词汇/键/链路）

| # | 退役项 | 现状 | 退役后 |
|---|---|---|---|
1 | `AccessLevel` 三档类型 + `ACCESS_RANK` | ac-agents-core 单源，17 处消费 | `unrestricted: boolean` 两态判定（或 `isFullAccess(call)`）；rank 序删除 |
2 | Agent 配置 `access`/旧 `tier` 字段 | agent.json 4 full + 8 sandbox | 字段退役；full Agent 的语义迁移 = permission-gate.json onAsk=allow（无人桶全免）——news 等 4 个 Agent 迁移脚本处理 |
3 | 会话键 `access`（+旧 elevation 读窗） | 857 个全 full-access | 键整体退役；「会话级武装 full」语义并入会话键 approval=allow（批 3 补 full 注入后等价）；存量 857 键清理 |
4 | 输入框选档 UI（access 档位钮） | ChatInput 两态选择（sandbox/full） | 退役——approval 键的 UI（已存在「工具审批」档）承接；快捷提权 = 切 approval=allow |
5 | deliver 档位继承/剥除/不降档链 | ac-conversation L415-470（写键留痕/继承/sanitize/不降档） | 整段退役——无人桶无会话键（conv-scope 批 1），机制 run 档位 = Agent 底座（即沙箱）；event 信封 access 上限语义随之消亡 |
6 | subagent 档位继承（inherit.access） | ac-shell-subagent inherit.ts | 退役——子档位 = 父配置底座（沙箱），full 经父的门 |
7 | `effectiveAccessOfCall` 的 agents 底座合成 | per-call 单源（cr-363 收编） | 保留但简化：入参只剩 call.access（门注入位），agentsOf 查询删除 |
8 | 权限门批准/缓存命中的 full 注入 | 已有（cr-1066/1071） | 不变——成为 full 唯一发放者；**新增**：设置链 allow 路径同款注入 |

## 三、分批切分（文件级）

### 批 A：门侧统一（full 注入扩展 + Agent 迁移）

| # | 改动 | 文件 |
|---|---|---|
| 1 | 设置链 allow 路径补 full-access 注入（与批准/缓存命中同款变异 execution.call）——「通过即 full」裁决落地 | ac-permission-gate/src/index.ts |
| 2 | Agent access/tier → permission-gate onAsk 迁移脚本：4 个 full Agent 写 onAsk=allow、清 access 字段；8 个 sandbox Agent 清字段（等价无配置） | scripts 一次性 + agents/ 数据 |
| 3 | 守护测试：档位不参与审批的 cr-1070 红线语义换锚（access 轴消亡后红线自然成立，测试改锚为「full 只来自门」） | ac-permission-gate tests |

### 批 B：词汇两态化（类型与消费链）

| # | 改动 | 文件 |
|---|---|---|
| 1 | AccessLevel 退役 → `isFullAccess(call, agentsOf)`（或 unrestricted 布尔）两态判定；ACCESS_RANK/effectiveAccessOf 归一简化 | ac-agents-core config.ts |
| 2 | 四工具行消费点换判定（fs-tools/shell-tools/fs-search/sre 的 accessOfCall/effectiveAccessOfCall） | 各包 |
| 3 | ToolCall.access 契约注释改写：合法来源唯一 = 门注入（原三处裁二） | ac-tools contract.ts |
| 4 | deliver 档位继承/剥除/不降档段退役；event 信封 access 剥除语义清理 | ac-conversation service.ts |
| 5 | subagent inherit.access 退役 | ac-shell-subagent |

### 批 C：键与 UI 退役 + 存量清理

| # | 改动 | 文件 |
|---|---|---|
| 1 | conv-settings BUILTIN_KEYS 删 access 条目 + elevation 读兼容窗退役 | ac-conv-settings service/contract |
| 2 | ChatInput 选档 UI 退役（access ref/持久化/武装态警示色）；composePrefs 清 access 项 | ac-client-ui-conversation |
| 3 | 会话键存量清理：857 个 full-access 键删除（approval 键承接语义——迁移脚本顺带给这批会话写 approval=allow 保行为连续） | scripts 一次性 + meta/conv-settings |
| 4 | webui 会话设置面板/agents 面板的 access 展示面清理 | ac-client-ui-settings / ac-client-ui-agents |

## 四、两层验收

### 测试标准（过程门）

| 批 | 必跑 |
|---|---|
| A | typecheck + test:unit + check:deps + 定向 eslint + vitest（permission-gate） |
| B | 同上 + pnpm test 全量（动契约/多包）+ test:integration（会话链路） |
| C | 同上 + webui:typecheck + build:channel |

### 验证目标（目的态断言）

| # | 断言 |
|---|---|
| V1 | 设置链 allow（会话键/Agent settings/全局任一层）放行的调用注入 full-access——「通过即 full」单测锁定 |
| V2 | 沙箱态（无人预授权、建议 ask 拒绝后）的越界调用仍被沙箱轴拦（D9 不回退——allow≠full 的防线只剩门，沙箱轴职责不变） |
| V3 | 4 个原 full Agent（news/admin/abap-dev/tester）迁移后无人桶 ask 建议全免（onAsk=allow 生效）——行为等价迁移验证 |
| V4 | 全仓 `sandbox-access`/`base-access`/`ACCESS_RANK`/`effectiveAccessOf` 零残留（词汇退役判据） |
| V5 | 会话 access 键存量 = 0；输入框无选档 UI；「快捷提权」改走 approval 键 |
| V6 | subagent/event 继承链无 access 分支（档位继承语义消亡后链路最短） |

## 五、与 conv-scope-plan 的接续

- 本计划吸收 conv-scope-plan 键清单中的 access 条目（该行随本计划落地标记退役，非挂门）；其余键（toolMode/browserTier/model/issueSubmit/harnessTier）的挂门计划不变。
- 实施序建议：conv-scope-plan 批 1（effective 读取面）→ 本计划批 A/B → conv-scope-plan 批 2/3。理由：access 退役动 deliver/subagent 继承链，先落 effective() 再拆继承链，每批改动面更小。
- 会话键清理两计划合流：conv-scope-plan 批 3 的无人桶清理 + 本计划批 C 的 access 键清理，同一脚本一次跑。

## 六、风险与边界

- **「通过即 full」的放大效应**：设置链 allow 从「免弹卡但仍沙箱」变「免弹卡且 full」——预授权语义实质增强。这是裁决的组成部分（用户裁决语义如此）；风险控制 = allow 仍是显式配置（三层都可精确控制），且 D9 沙箱轴对 deny/ask 拒绝路径照拦。
- **event 信封上限的语义缺口**：原「机制 run 档位上限 sandbox」防线随 access 轴消亡——机制 run 的 full 只能经设置链 allow（Agent settings 层），这正是 news 现场已验证的形态；防线从「信封档位」移到「门设置链」，不变量等价（无人桶 deny 缺省仍 fail-closed）。
- **news 轮巡的行为连续性**：news 已是 onAsk=allow + timer 驱动，迁移只清 access 字段，轮巡不受影响（cr-1079 现场已验证链路）。
- **回滚路径**：词汇两态化（批 B）是单向门——落地前批 A 必须先行且 V1/V3 绿；批 C 存量清理最后做（键删除不可逆，approval 迁移脚本先跑保连续）。

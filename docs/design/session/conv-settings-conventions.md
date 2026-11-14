# 会话键契约（conv-settings-conventions）

> 性质：规约——会话设置键（conv-settings）从注册到消费的全生命周期统一契约；新键作者的单一入口档。
> 状态：现行 · cr-1085 2026-11-14（吸收 conv-scope-plan §二键清单 与 cr-1084 草稿暂存裁决）。
> 读者：要新增或修改会话键的人（内置键 owning 侧 / 生态扩展键作者 / 消费方行作者）；落笔任何键前通读 §一。

## 一、键的生命周期总纲

一个会话键从诞生到生效要过七道面。**全部走对了键才算「入籍」；漏任何一道都会复现历史事故**（见 §六）。

| # | 面 | 单源位置 | 规则 |
|---|---|---|---|
| 1 | 注册 | `ac-conv-settings/src/service.ts` `BUILTIN_KEYS`（内置）/ `ctx.convSettings.registerKey`（生态） | `ConvSettingsKeyDef` 全字段：`enum`（或 `pattern`）值域 / `description` / `group: 'experimental'` + `label` + `options`（要进实验性菜单时）/ `grants`（值→能力标签，仅授权类键） |
| 2 | UI | ChatInput 实验性菜单（目录驱动——`conv-settings/keys` RPC 拉 `group === 'experimental'`` 键） | **泛写口**（`selectExtKey`）自动覆盖任何注册键——生态键零前端改动即出现；内置键另有专用控件时才手写 |
| 3 | 写 | ChatInput `setConvSetting` 统一边界 → `conv-settings/set` RPC | 唯一正路。**草稿位（新会话未物化）自动暂存**进草稿（`PendingMeta.convOverrides`），物化时搬运（cr-1084）——写口不得直写哨兵 `__pending__` |
| 4 | 服务端写面 | `ac-host-webui/src/web-api.ts` conv-settings/set | 三闸：词法校验 / **哨兵词 fail-loud 拒收**（cr-1084）/ 无人桶 fail-loud 拒收（cr-1083）→ `ConvSettingsService.set` 键域校验（非法值 = 删键） |
| 5 | 持久化 | `<dataRoot>/meta/conv-settings/<conversationId>.json`（兼容窗回落旧位置） | 文件名即 conversationId；原子写（tmp + rename）；全空 = 删文件；无迁移脚本不搬旧键 |
| 6 | 读 | 决策面一律 `effective(id)`（无人桶恒 `{}`）；`get(id)` 仅展示面 | 壳侧同形（`ConvSettingsShim.effective`）；**消费方禁止自己再判 humanPresentOf**——读取面已单源 |
| 7 | 消费 | 按键语义各归其位 | 见 §二消费方式三型与既有键登记表 |

## 二、消费方式与键登记表

### 消费三型（决定你要在哪儿读键）

| 型 | 读法 | 适用 | 先例 |
|---|---|---|---|
| A 决策链 | `effective(conv).<key>` 直读 | 审批 / 开关类 | approval（权限门 `onAskOf` 第一层） |
| B 能力注入 | **不要自己读**——声明 `grants`，`sessionCapsOf` 统一遍历注入 | 授权 / 可见性类（值→能力标签） | browserTier、issueSubmit enabled |
| C 继承 | subagent 装配点 `convInheritOf` 等价词映射 | 子 Agent 要继承父会话偏好时 | cr-753 继承面（elevation→档位词已随 cr-1082 退役） |

**判据**：B 型判据 = 该键的某个值应当改变 Agent 的工具可见面 / 能力集——此时写 `grants`（值→标签数组），消费自动经 `sessionCapsOf`（六决定点已全接：router / web-api / collab list_tools / run_code 投影 / security 门 / subagent 装配）；自己合成 caps = 重复实现（cr-1074 收敛裁决）。A 型仅当键值直接进入行为决策链（审批 / 拦截开关）。

### 既有键登记表（新增键在此表加行）

| 键 | 值域 | 型 | 消费方 | 前端 UI |
|---|---|---|---|---|
| model | `name@model` 或裸名 | 特例（deliver 合并→信封，不进本表消费型分类） | user-stub deliver 合并；subagent 继承 | 模型菜单（1v1 键；singles 走 session.json） |
| toolMode | `tc-*` 开放词 | A | `effectiveToolMode`（收窄 LLM 工具面） | 专用控件（三档钮） |
| browserTier | observe/manipulate/inject/disabled | B | `grants` → `sessionCapsOf`；web-tools 层级门 | 专用控件（实验性菜单二级） |
| issueSubmit | enabled/disabled | A+B 混（disabled 拦截走 A；enabled 注入走 grants） | issue-tools 前置拦截 | 泛写口 |
| approval | allow/ask/deny | A | 权限门 `onAskOf` 第一层 | 泛写口 |

生态键示例：harnessTier（ac-harness-tools `registerKey`，A 型前置拦截）。

## 三、草稿位契约（cr-1084）

新会话是草稿（id = 哨兵 `__pending__`），真实 sid 首条消息 `dispatchDraft` 才签发。键在草稿期的读写必须走暂存面，否则键永远到不了真实会话（approval 对 run 不可见的根因事故）：

- **写**：ChatInput `setConvSetting` 判 `onDraft` → `singlesBoard.setConvOverride(key, value)` 暂存进 `PendingMeta.convOverrides`（随草稿 localStorage 留存，刷新不丢）。
- **读**：`convSettingStored(key)` 回显暂存值；草稿位不读服务端（哨兵键上的存量脏值不回显）。
- **搬**：`SingleBoardService.dispatchDraft` 在 `singles/create` 成功后逐键写真实 sid（入口快照——create 内 created 帧先触发 retireDraft）；失败 warn 不阻断发送。
- **禁**：服务端写面对哨兵词 fail-loud 拒收（旧前端 / 其他写面再造残值即显性报错）。

## 四、作用域（cr-1080/1083 已实施）

全部键默认**仅有人会话生效**（`humanPresentOf` 单源——对桶含 user / singles sid）；无人桶（self / agent~agent / 群成员流）读面恒空、写面 fail-loud。不设 per-key 例外字段——确需无人桶生效的键出现时先在本档登记裁决再动 `ConvSettingsKeyDef`（YAGNI，承接 conv-scope-plan §五）。

## 五、例外与反模式

| 面 | 规则 | 例外 |
|---|---|---|
| 注册 | enum / pattern 二选一 | 无（开放词键用 pattern，先例 toolMode `^tc-[a-z0-9-]+$`） |
| UI | 生态键经目录驱动自动出现 | 内置键要专用控件（档位钮）才手写 |
| 写 | `setConvSetting` 唯一入口 | model 的 singles 分流（写 session.json，非本域——见 contract.ts 头注） |
| 读 | 决策面 `effective` | 展示面 `get`（运行跟踪读残留值展示） |
| 消费 | B 型不自己读键 | 无——自合成 caps 是重复实现 |
| 草稿 | 暂存→搬运 | 无 |
| 持久化 | 单文件单会话 | 无 |

**反模式清单**（发现即改）：直写 `conv-settings/set` 绕过统一写口；草稿位读服务端；消费方内联 `humanPresentOf` 判定；B 型键手写 caps 合成；前端写死键目录不走 `conv-settings/keys`；给哨兵键写任何值。

## 六、防复发（历史事故 → 规则的由来）

| 事故 | 根因 | 沉淀为 |
|---|---|---|
| cr-1084 | 草稿位会话键写哨兵 `__pending__`，物化时无人搬运——approval 对 run 不可见 | §三草稿位契约 + 服务端哨兵闸 |
| cr-1080/1083 | 无人桶残值压 Agent 配置（UI 早期全树写入产物） | §四作用域 + effective 读取面单源 |
| cr-1074 | 各消费方手写 caps 合成走散 | §二 B 型「不自己读」+ sessionCapsOf 单源 |
| cr-911 | 前端包靠 hoisting 隐式生效 | （跨域先例，此处适用）依赖显式声明 |

新键作者 checklist（七面顺序）：① 注册（def 全字段）→ ② UI 有无（泛写口自动 / 专用控件）→ ③ 写口已收（统一边界自动覆盖）→ ④ 服务端闸已覆盖（自动）→ ⑤ 持久化自动 → ⑥ 消费方读法定型（A/B/C）→ ⑦ 草稿位行为确认（暂存/搬运自动覆盖——泛写口键零额外工作）。
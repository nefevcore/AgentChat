# 会话键契约（conv-settings-conventions）

> 性质：规约——会话设置键（conv-settings）从注册到消费的全生命周期统一契约；新键作者的单一入口档。
> 状态：现行 · cr-1259 2026-11-23 增补：`immediate` 键字段（选择即写——per-step 生效单键面，approval 首例；cr-1094 精简四批仍为基础层）。
> 读者：要新增或修改会话键的人（内置键 owning 侧 / 生态扩展键作者 / 消费方行作者）；落笔任何键前通读全文。

## 一、键的旅程与生效模型

键值沿一条数据流走到底：**控件 → 统一写口 → 服务端闸 → 落盘 → 读面 → 消费**。生效模型一句话：**设置随消息边界生效，进行中的 run 不受干扰**；例外——`immediate` 键选择即写，下一消费点（per-step）即生效（cr-1259）。

### 消息边界写（cr-1093 已实施）

「选择即写」已废弃——写时机与各键互不相同的读时机正交组合，行为是涌现的而非设计的（同为运行中切换：approval 下次工具调用即变〔半个 run 生效〕、toolMode 下一 run 生效、browserTier 工具面与执行门新旧并存）。收敛为：

- **草稿位**：选择只改表单状态，无任何写机制；真实 sid 首条消息发送时一次 patch 写入全部键。
- **续聊位**：改值暂记表单，随下一条消息发送生效（UI 显示表单值即未生效，属正常，无提示）。
- 键级 patch 语义保留（多端并发不互清键）。
- **immediate 例外（cr-1259）**：def 标 `immediate: true` 的键（首例 approval）选择即落盘——非草稿位上泛写口直接 `conv-settings/set` 单键 patch，写成功基线同步（不进发送边界 flush），写失败回滚表单 + toast（immediate 键真相 = 落盘值，静默吞会留「显示已改、实际未改」假象）；草稿位仍走发送边界。**判据**：只标给消费方逐调用读取的键（写落盘即被下一次消费看见——「写即生效」自洽）；run 装配点读的键（如 toolMode 收窄工具面）mid-run 写不改进行中 run 行为，制造「改了没生效」模糊态，禁标。

**唯一写点 = 发送链**：`prepareSend`（草稿物化拿真实 sid）→ `flushConvSettings`（表单 vs 基线的脏值一次 patch）。键面 = toolMode / browserTier / 实验目录键 / 1v1 的 model。

**例外（既有域名分流，cr-1093 复核保留）**：singles 的 model 归 session.json 域（`updateSession`）且**即时写**——单条消息的信封模型取自会话上下文（`chat-core` deliver 带 `ctx.model`），延迟写会让信封与会话元数据双源。

随此裁决已蒸发的机制（cr-1093）：草稿暂存三件套（`setConvOverride` / `convOverrideValue` / `PendingMeta.convOverrides` + `dispatchDraft` 逐键搬运）、偏好继承写（`toolModeInherit` 登记 + deliver 前 `settleToolMode` 等待）、写失败回滚（五处控件 prev/回滚/toast）、`convSettingStored` 暂存读口。

### 现行代码流程

```
控件（专用控件 / 泛写口 selectExtKey——conv-settings/keys 目录驱动）
  │  只改表单 reactive 值（+ saveComposePrefs 记偏好：新会话表单初值来源）
  ▼
发送链 prepareSend（ChatInput send / sendNow 共用）
  ├─ 草稿位（哨兵 __pending__）：dispatchDraft 签发真实 sid（幂等锚）
  └─ flushConvSettings(真实会话键)：表单 vs 基线 diff → 一次 patch
       （无变化 = 零写；写失败不阻断发送、不回滚表单——下次发送重试）
  │
  ▼
宿主 web-api 拒收闸（哨兵词 / 无人桶 / patch 形状——fail-loud；保险丝性质）
  → ConvSettingsService.set（词法校验；键域不校验——字符串值原样落盘，cr-1091）
  → <dataRoot>/meta/conv-settings/<conversationId>.json（原子写；全空 = 删文件）
  │
  ▼
读面（宿主 service 与壳侧 ConvSettingsShim 同形）：
  get = 展示面原样读；effective = 决策面（无人桶恒 {}——humanPresentOf 单源）
  │
  ▼
消费：消费方直读（grants 标签桥已随 cr-1092 退役）/ 子代理继承映射
```

## 二、注册：键定义

单源：内置键 `packages/ac-conv-settings/src/service.ts` `BUILTIN_KEYS`；生态键 `ctx.convSettings.registerKey`（注册即归属——卸载自动回收〔键从目录/UI 消失；已落盘值保留不清理，cr-1091〕；撞名 fail-loud）。

| 字段 | 规则 |
|---|---|
| `enum` | **UI 选项列表**（泛写口渲染数据源——`ChatInput.vue` `v-for` 直接遍历），与 `options`/`label`/`group` 同族；**不承担值域校验**（cr-1091 已实施，见下方「值域校验核验」） | 
| `pattern` | **已退役（cr-1091）**——零真实消费，字段已删 |
| `description` | 键语义一句话 |
| `group: 'experimental'` + `label` + `order` + `options` | 要进输入框「实验性」菜单时给；缺省不出前端目录（纯消费面键） |
| `grants` | **已退役（cr-1092）**——字段已删。验尸结论：宣称的六个消费决定点中三个不存在（web-api / security 门 / subagent 装配）、三个空转（caps 全喂恒 true 的 toolAllowedFor），唯一真实消费点 = web-tools browser 分层门禁，已改直读 `max(Agent levels, effective().browserTier)` |

**值域校验核验（cr-1088）与退役实施（cr-1091）**：`enum`/`pattern` 的宣称作用「写面 `isValid` 非法值删键 + 回读面注册回收清存量值」经三条依据判无意义：① 消费方全部精确匹配 + 天然回落（approval 落缺省 deny、toolMode 未知词回退 baseFace + warn〔可用性优先〕、browserTier/issueSubmit 不命中即跟随 Agent）——垃圾值天然免疫；② 唯一写入口泛写口的选项列表本身从 enum 渲染，用户只能点出合法值；③ 宿主 service 回读过滤而壳侧 Shim 从不校验（`typeof v === 'string'` 即透出），两种读法并存运行数月零事故。**cr-1091 已实施退役**：pattern 字段 / isValid / 回读键域过滤三面删除，落盘即真相（读面只留 typeof string 类型闸防文件损坏），双树读面从此同形。

**双树裂痕（现行已知）**：宿主/壳分树下，壳内行经垫片注册的键在宿主侧键目录缺席（`conv-settings/keys` 只回宿主注册表；回读键域过滤已随 cr-1091 退役，写面不再被静默清）。harnessTier 曾是此类键（cr-1066 记录）——已随 cr-1094 **整键退役**，当前无活案例。因此**内置语义键一律进 `BUILTIN_KEYS`**；生态键跨树可见性问题若再现，先查 `docs/design/session/permission-gate-handoff.md` 遗留项④。

**键目录树（目标态）**：输入框工具栏最多两级——分组 → 会话属性 → 可选值。workspace / agent 是草稿身份字段（PendingMeta，随 singles/create 走，不进 conv-settings 文件）；model 值域动态（池菜单），需 def 增 dynamic 标记；reasoning_effort 现为消息级参数（组合偏好，不落盘），进树即会话键化 = 产品裁决，均未实施。

## 三、写路径：从控件到落盘

### 控件层

- 生态键零前端改动：实验性菜单目录驱动（`conv-settings/keys` RPC 拉 `group === 'experimental'` 键），泛写口 `selectExtKey` 自动覆盖任何注册键；前端禁止写死键目录。
- 内置键专用控件（模型菜单 / toolMode 三档钮 / browserTier 二级菜单）现状仍在——目标态随统一目录树收编，见 §七①。

### 唯一写点（cr-1093）

`flushConvSettings`（ChatInput）是前端唯一写边界——`conv-settings/set` RPC 直写面全局仅此一处（回归锁：`packages/ac-client-ui-conversation/tests/draft-conv-settings.test.ts` 断言直写面恰好 1 处、蒸发物不回流）。控件不再各自发起 RPC：选择只改表单 + 记组合偏好；发送边界按「表单 vs 基线」diff 出脏值一次 patch（§一）。服务端哨兵闸降级为纯保险丝（防旧前端，代码保留）。

例外：model 的 singles 分流（独立会话写 session.json，非本域——防双源，见 `contract.ts` 头注；该域即时写，理由见 §一例外段）。

### 服务端闸与持久化

`packages/ac-host-webui/src/web-api.ts` conv-settings/set 拒收三闸，全 fail-loud：① 哨兵词 `__pending__`；② 无人桶（`humanPresentOf` 判定——会话键是用户偏好载体，无人桶无偏好可写，cr-1083）；③ patch 形状。词法校验（conversationId 禁路径分隔/遍历/空白）在 `ConvSettingsService.set`。键域校验 `isValid` 已随 cr-1091 退役——字符串值原样落盘（删键只剩 null 显式语义）。

持久化形态：`<dataRoot>/meta/conv-settings/<conversationId>.json`，文件名即 conversationId；原子写（tmp + rename）；全空 = 删文件（新旧两位置一并清）；兼容窗读侧回落旧位置不物理迁移；无迁移脚本不搬旧键。壳侧无写权——`ConvSettingsShim.set` 恒抛（写者单源 = 宿主行）。

## 四、读路径与作用域

| 方法 | 语义 | 谁用 |
|---|---|---|
| `get(id)` | 原样读（含残留值） | 展示面（运行跟踪读残留值展示） |
| `effective(id)` | 无人桶恒 `{}`（`humanPresentOf` 单源；壳侧 Shim 同形） | **一切决策 / 合成 / 继承读取** |

作用域裁决（cr-1080/1083）：全部键默认**仅有人会话生效**（对桶含 user / singles sid）；无人桶读面恒空、写面 fail-loud。不设 per-key 例外字段——确需无人桶生效的键出现时先在本档登记裁决再动 `ConvSettingsKeyDef`（YAGNI）。**消费方禁止自己再判 `humanPresentOf`**——读取面已单源。

## 五、消费方式与键登记表

### 消费方式（cr-1087 订正后）

键作者只答**一问**：键值要不要进入行为决策链（审批 / 拦截开关 / 档位判定）？要 → 消费方在自己代码里 `effective(conv).<key>` 直读（cr-1092 起 grants→sessionCapsOf 能力注入通路整体退役——会话授权一律消费方直读）。子代理继承（`convInheritOf`）按需映射，现状仅 browserTier。

### 既有键登记表（新增键在此表加行）

| 键 | 值域 | 消费方（实际生效面） | 前端 UI |
|---|---|---|---|
| model | `name@model` 或裸名 | user-stub deliver 合并；subagent 继承；singles 分流 session.json（防双源） | 模型菜单（专用） |
| toolMode | `tc-*` 开放词 | `effectiveToolMode`（收窄 LLM 工具面） | 专用控件（三档钮） |
| browserTier | observe/manipulate/inject/disabled | web-tools 分层门禁：disabled 直读拦截；层级判定 = max(Agent levels.browser, 本键)（cr-1092 直读合一——与 grants 注入恒等，并集只升不降） | 专用控件（实验性二级） |
| issueSubmit | enabled/disabled | **enabled = no-op**（def 无 grants，注入从未发生）；disabled = issue-tools 直读前置拦截 | 泛写口 |
| approval | allow-sandbox / allow-full / ask / deny（存量 allow 读侧映射 allow-sandbox，写恒新词——cr-1261） | 权限门 `onAskOf` 第一层（逐工具调用读 effective；allow-full 免卡注 full-access 越沙箱生效——**仅本层合法**，Agent/全局层 onAsk 维持三值） | 泛写口（immediate——选择即写，cr-1259） |
| ~~harnessTier~~（生态） | — | **已整键退役（cr-1094）**：原为壳内 registerKey 注册键（宿主侧键目录不可见 = 双树裂痕）+ grants 零消费（cr-1092 已删），disabled 拦截臂是唯一活闸而写面到不了宿主——死键双向空转。会话级禁用改由 Agent 行卸载表达；`run_harness` 工具本体保留 | ——（不再出现在实验目录） |

### 运行中切换语义（cr-1093 后；cr-1259 增补）

**一句话**：设置随下一条消息生效，进行中的 run 不受干扰——immediate 键除外（选择即写，进行中 run 的下一消费点即生效）。

cr-1087 实测的三种涌现语义（approval 半个 run 生效 / toolMode 下一 run 生效 / browserTier 工具面与执行门新旧并存）随「选择即写」一并消失——写只发生在发送边界，故**同一 run 内不会看到会话键变化**。消费方读取时机（逐调用 / run 装配）仍各异，但对用户可见效果统一为「下一条消息起生效」。cr-1259 起 approval 恢复且**结构化**了「半个 run 生效」：写时机不再是控件各自为政，而是 def `immediate` 字段统一声明（与读时机对齐的键才允许），门逐 tool call 读 effective 的既有消费面 + runApproved 缓存在设置链之后求值——mid-run 改 deny 立即压过已批准缓存，改 allow 立即免卡（sandbox-access 分级不变），改回 ask 与缓存正交（缓存兑现「本轮免再问」）。

## 六、反模式与防复发

**反模式清单**（发现即改）：直写 `conv-settings/set` 绕过 `flushConvSettings` 发送链（immediate 键泛写口分流除外）；非 immediate 键控件里「选择即写」；**给 run 装配点读的键标 immediate**（读时机不对齐——制造「改了没生效」模糊态）；草稿位读服务端；消费方内联 `humanPresentOf` 判定；前端写死键目录不走 `conv-settings/keys`；给哨兵键写任何值；壳内写会话设置；**新键给 def 加 grants 字段（字段已随 cr-1092 删除）**。

| 事故 | 根因 | 沉淀为 |
|---|---|---|
| cr-1084 | 草稿位会话键写哨兵 `__pending__`，物化时无人搬运——approval 对 run 不可见 | §三写路径 + 服务端哨兵闸（cr-1093 后草稿位不再有任何写机制——问题面整体消失） |
| cr-1080/1083 | 无人桶残值压 Agent 配置（UI 早期全树写入产物） | §四作用域 + effective 读取面单源 |
| cr-1074 | 各消费方手写 caps 合成走散 | （cr-1087 验尸：sessionCapsOf grants 注入段实为单键通路）——cr-1092 已退役 |
| cr-1066 | 垫片注册键宿主 set 面不认（读写链静默断） | §二双树裂痕 + 内置语义键进 BUILTIN_KEYS |
| cr-953/2026-09-26 | requiredTags 门禁退役留 toolAllowedFor 恒 true 过渡形状；browserTier 会话授权到不了执行层 | 恒 true 链已随 cr-1092 清零；可见性断层修复实况见 web-tools 门禁 |
| cr-911 | 前端包靠 hoisting 隐式生效 | （跨域先例，此处适用）依赖显式声明 |

新键作者 checklist（按站点，现行）：① 注册（def = 纯 UI 元数据，无值域/无 grants，§二）→ ② UI 自动（实验目录驱动 + 泛写口，§二/§三）→ ③ 写时机免管（发送边界自动，§一/§三）→ ④ 服务端闸与持久化（自动，§三）→ ⑤ 消费方直读定型（一问，§五）。

## 七、实施轨道（cr-1087 裁决方向；④②① 已实施，③ 待定）

| # | 批次 | 内容 | 蒸发物 |
|---|---|---|---|
| ① | 发送时写 | **已实施（cr-1093）**：ChatInput 表单化（控件只改表单）+ 发送链 `prepareSend` → `flushConvSettings` 单次 patch + 偏好只做表单初值 | 草稿暂存三件套、偏好继承写（toolModeInherit）、写失败回滚、逐键搬运 RPC、运行中切换的三种涌现语义 |
| ② | grants 退役 | **已实施（cr-1092）**：web-tools 层级判定改直读（max(Agent levels, effective().browserTier)）；删 grants 字段 + sessionCapsOf + toolAllowedFor 恒 true 链（三调用点 + 函数本体，cr-953 欠账清零）——sessionCapsOf 全仓零消费整删 | grants 维度、「六决定点」宣称、caps 标签桥 |
| ③ | harnessTier 处置 | **已实施（cr-1094，用户定案整键退役）**：删 HARNESS_TIER_KEY 注册 + disabled 拦截臂 + 行对 conv-settings 的 inject 依赖；`run_harness` 工具保留 | 死键双向空转链、双树裂痕唯一活案例 |
| ④ | 值域校验退役 | **已实施（cr-1091）**：`pattern` 字段 + `isValid` 键域校验 + 宿主回读过滤三面删除（未注册键/非法值不再删键——落盘即真相，垃圾值由消费方天然回落兜底）；`enum` 语义改注为 UI 选项列表 | isValid / pattern / 回读过滤三面校验 |

批次①~④全部落地后，键定义契约收敛为：**一个纯 UI 元数据的 def**（group/label/order/options/enum-as-选项列表 + description），值域与消费完全是后端自己的事——键作者零校验心智。

统一目录树（分组两级：workspace/agent 草稿身份字段、model dynamic 标记、reasoning_effort 会话键化裁决）并入①或独立批次，实施前定案。文档随实施逐节翻转目标态 → 现行实况。**逐批改动面/文件行号锚点/测试重锁清单/建议顺序（④→②→①→③）见交接档 [conv-settings-simplify-handoff.md](conv-settings-simplify-handoff.md)（cr-1090）。**


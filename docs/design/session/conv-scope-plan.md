# 会话键作用域计划（conv-scope-plan）

> 性质：实施计划——「会话键只存在于有人会话」原则的全键推广（cr-1079 续记裁决的 generalize）。
> 状态：现行 · cr-1080 2026-11-14 · 前序 cr-1079（approval 首例 + humanPresentOf 单源）。
> 读者：conv-settings 域与各会话键消费方维护者（实施前通读 §一/§二）。

## 一、背景与根因

**原则（用户裁决，2026-11-14）**：会话设置（conv-settings 键）是**用户偏好载体**——只在存在人类参与的会话（humanPresentOf：a~user 对桶 / singles sid）有意义。无人桶（self a~a / agent~agent / g-<gid>~member）上不应有会话键参与任何决策。

**根因**：conv-settings 域从 cr-565 起按 conversationId 寻址读写，从未限定会话形态。三条后果链：

1. **残值压 Agent 配置**：无人桶文件残留键值会静默覆盖 Agent 侧同语义配置（Agent 是无人场景的唯一配置主体）——「Agent 设置未生效」的诡异排查面。实锤：news~news 残留 toolMode/browserTier（mtime 2026-11-10，UI 早期全树写入产物）；审批轴同病已修（cr-1079 续记，会话键层加 humanPresentOf 门）。
2. **UI 可达性错位**：webui 会话设置面板 / 输入框实验性菜单按 conversationId 开放，无人会话（运行跟踪里可见 news~news 等）也可写键——写了不生效或更糟（生效到下次修复前）。
3. **概念错配**：群聊 / Agent 间会话无「本会话的用户偏好」语义可言；键域词汇（approval「本会话自动放行」等）在无人桶上是无主授权。

**与既有裁决的关系**：本计划是 cr-1079 续记（会话键 approval 仅有人桶参与设置链）的推广——首例已落地，本计划收全部键。**无人语义单源 = humanPresentOf（ac-agents），不新造判定。**

## 二、键清单与消费点全景（2026-11-14 勘察）

| 键 | 值域 | 消费点（读） | 无人桶现状 | 推广后 |
|---|---|---|---|---|
| approval | allow/ask/deny | 权限门 onAskOf 第一层 | ☑ 已修（cr-1079 续记） | 有人会话唯一 |
| toolMode | tc-* 开放词 | effectiveToolMode（ac-agents：override ?? toolModeOf） | 残值收窄机制 run 工具面 | 有人会话唯一 |
| browserTier | observe/manipulate/inject/disabled | ac-web-tools 覆盖 tags；sessionCapsOf grants 注入 | 残值 disabled 可整体禁 browser | 有人会话唯一 |
| access | base/sandbox/full | ac-conversation（user 消息写键 + event 继承读键） | user 信封不到无人桶——写面天然限有人；读面 event 继承在无人桶可达 | **整体退役**（cr-1082：执行面本就两态、857 键全 full、full 真实身份是审批——收归权限门，见 access-retirement-plan.md） |
| model | name@model / 裸名 | user-stub deliver 合并 → 信封透传 router；subagent convOf.model 继承 | deliver 合并在宿主 user 面无人桶天然缺席；subagent 继承读需门 | 门加在 subagent 继承读 |
| issueSubmit | enabled/disabled | ac-issue-tools 前置拦截 | 残值 disabled 禁用无人桶 submit_issue | 有人会话唯一 |
| harnessTier | enabled/disabled（扩展键，ac-harness-tools registerKey） | ac-harness-tools 前置拦截 | 同上 | 有人会话唯一 |
| （未来扩展键） | registerKey 注册 | 各行消费 | 无统一约束 | 单源收口（批 1 读取面） |

**写面**：宿主 conv-settings/set RPC（web-api）+ ac-conversation（user 消息档位留痕）——两处写面都按 conversationId 无形态校验。

**读面分流**：① 直接消费（权限门/issue/harness/web-tools/effectiveToolMode）② grants 注入（sessionCapsOf：listKeys 遍历 grants 并入能力集——browserTier 的层级值经此路注入 caps）③ 继承面（ac-conversation event 继承 / subagent convInheritOf）。

## 三、分批切分（文件级）

### 批 1：单源谓词 + 直接消费面挂门（行为收口主批）

| # | 改动 | 文件 |
|---|---|---|
| 1 | convSettings 读取面增「作用域过滤」：get(id) 不变（原样——展示面需要），新增 effective(id)（无人桶恒返 {}——决策面统一换用） | ac-conv-settings service + 壳侧 ConvSettingsShim 同步 |
| 2 | 权限门 onAskOf 第一层换 effective（替换 cr-1079 续记的内联 humanPresentOf 门——同一语义上收到读取面单源） | ac-permission-gate/src/index.ts |
| 3 | effectiveToolMode 换 effective | ac-agents/src/service.ts |
| 4 | browserTier 覆盖读换 effective | ac-web-tools/src/index.ts |
| 5 | issueSubmit 前置拦截读换 effective | ac-issue-tools/src/index.ts |
| 6 | harnessTier 前置拦截读换 effective | ac-harness-tools/src/index.ts |

实施注记：effective 的实现 = humanPresentOf(id) ? get(id) : {}——语义单源收敛到读取面，消费方零重复判定；humanPresentOf 已是 ac-agents 导出词，ac-conv-settings 引用它做值导入（ac-agents 不依赖 ac-conv-settings，无环）。

### 批 2：grants 注入与继承面

| # | 改动 | 文件 |
|---|---|---|
| 1 | sessionCapsOf 的 convSettings.get 换 effective（grants 注入不再吃无人桶残值） | ac-agents/src/service.ts |
| 2 | event 继承读（ac-conversation inherited）换 effective——无人桶不继承会话档位（防伪造不变量 sanitizeAccess 照走） | ac-conversation/src/service.ts |
| 3 | subagent convInheritOf / modelOverride 继承读换 effective | ac-shell-subagent/src/service.ts |

### 批 3：写面与 UI 可达性 + 存量清理

| # | 改动 | 文件 |
|---|---|---|
| 1 | conv-settings/set RPC 增形态校验：无人桶写键报错（fail-loud——与壳侧 Shim.set fail-loud 同姿态，防 UI 再造残值） | ac-host-webui web-api |
| 2 | webui 会话设置面板 / 输入框实验性菜单：无人会话隐藏键操作（前端按会话形态过滤——后端校验兜底） | ac-client-ui-conversation / ac-client-ui-settings |
| 3 | 扩展键 registerKey 契约注释：键默认仅有人会话作用域（行为由读取面统一保证，ConvSettingsKeyDef 不加字段） | ac-conv-settings contract |
| 4 | 存量清理：一次性删除无人桶的 conv-settings 文件（勘察 9 个：admin~mathematician / admin~nana / admin~tester / editor~neko / editor~writer / g-mthfaf3e-tmx1~news / nana~neko / neko~neko / news~news——cr-1081 兼容窗收口后已集中 meta/conv-settings 单位置）——内容全是残值无迁移价值；脚本清理 + CR 登记 | scripts 一次性 + meta/conv-settings |

## 四、两层验收

### 测试标准（过程门）

| 批 | 必跑 |
|---|---|
| 1 | typecheck + test:unit + check:deps + 定向 eslint（六包） |
| 2 | 同上 + 定向 vitest（ac-conversation / ac-shell-subagent） |
| 3 | 同上 + webui:typecheck + build:channel（动前端）+ 全量 pnpm test |

### 验证目标（目的态断言）

| # | 断言 |
|---|---|
| V1 | 无人桶（news~news / alice~bob / g-x~y）文件存在残值时：toolMode/browserTier/approval/issueSubmit/harnessTier 消费面全部按「无键」处理（Agent 侧配置接管）——单测逐键锁定 |
| V2 | 有人桶（a~user / singles sid）行为分毫不变（既有用例全绿即证——无人桶键此前无生效正当性） |
| V3 | grants 注入：无人桶残值 browserTier=observe 不再注入 web/observe 能力 |
| V4 | event 继承：无人桶 event 信封不继承会话 access（回落信封自带或 Agent 底座） |
| V5 | subagent：父会话无人桶时子 config 不吃残值 model/access |
| V6 | 写面：无人桶 set 请求 fail-loud 报错；前端不再渲染无人会话的键操作 |
| V7 | 存量清理后：无人桶 conv-settings 文件数 = 0（脚本验证） |

## 五、风险与边界

- **access 继承门的风险**：无人桶 event 继承被掐后，机制唤醒 run 的档位回落信封/Agent 底座——若有部署依赖「用户曾在 UI 给该会话选过 full」来喂机制 run，行为变化。勘察判断：无人桶上用户不可能有过正当选档（UI 只对用户参与的会话开放选档），残值来自早期全树写入——风险可忽略，V4 锁定。
- **model 继承门同理**：subagent 父会话残值 model 不再传播到子——子的模型回落父 config 静态值，语义更正。
- **get() 保持原样的理由**：展示面（运行跟踪等）可能读无人桶文件展示历史残留，effective 只约束决策面——读写分离，展示不受影响（批 3 前端收口后展示也消失）。
- **不引入 per-key 作用域字段**：全部键统一「仅有人会话」——若未来出现确需无人桶生效的键（防御性声明），届时再在 ConvSettingsKeyDef 加 opt-out 字段，不在本计划预埋（YAGNI）。

## 六、批次时序

批 1（行为收口）先行——它消除全部「残值压 Agent 配置」的现行风险；批 2（继承面）次之；批 3（写面/UI/存量清理）收尾。批间无依赖硬序，但按此序每批独立可交付。


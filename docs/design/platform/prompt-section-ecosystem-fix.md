# system prompt 段位生态开放与快照漂移修复（cr-944）

> 性质：域深设计（实施裁决存档）——PromptSection 动态注册制、指纹段集维度、物化 prepare 缝、段位认知分层正典（§8 判据 v2 表为段位分配依据）。
> 状态：已实施待归档（cr-944 2026-11-08 同日实施完成，全量 unit 2858 绿；四项裁决 A 动态注册 / B 档 2 / C 放开 / D 段位重排全部落地）· cr-944 2026-11-08。
> 读者：注册新提示词段、或排查快照指纹/段序漂移的人。
>
> 关联裁决：cr-881（段注册制）、cr-888（singles 物化四机制）、cr-886（host-face-client 两段式装配 fiber 教训）、cr-883（GUIDELINES_TIMER 宿主行回退）。
> 背景：对 cr-881/cr-888 成果的再评估发现四处债——一处活的架构反例（sap-adt 走 before-run 追加）、两处快照盲区（指纹对段集漂移失明 / 物化与远程段装配竞态）、一处段位与自家分类法相悖（GROUP_CONTRACT 内嵌群名坐 355）；后补段序认知评估（判据 v2：认知信息/行为指令/参考材料/动态状态四类分层）新增 P5 段位重排。本方案一次收口，修 P1 为主，P2×2、P3、P4、P5 顺带归位。

## 0. 问题清单（一处一状，行号为 2026-11-08 树）

| # | 问题 | 事实 | 违反的原则 | 严重度 |
|---|---|---|---|---|
| P1 | 段位词表封闭 vs 开放生态 | SECTION_ORDER 封闭 const；knownSectionName 拒未知远程段；ac-sap-adt/src/index.ts L198-214 在 loop/before-run 向 request.system 尾部 append `<sap-adt-tools>` 规约（落在 DATETIME 之后，破「日期行绝对收尾」不变量） | cr-881「before-run 不再承载提示词装配语义」；一切皆插件的可扩展面 | 高 |
| P2a | 快照指纹对段集/段文漂移失明 | fingerprintOf 键面（service.ts L1195 邻域）无段集维度：行升级新增/改写段 → 冻结前缀永久陈旧至下次换 model | cr-888 §2「工具面/指引漂移由 ④ 引导」——④ 对段集维度无键可 diff | 高 |
| P2b | 物化与远程段懒装配竞态 | syncPrefixSnapshot 在 agentLoop.run() **之前**（service.ts L549 邻域）；远程段契约在 run **内** before-run 同步段才应用（host-face-client L205-208）→ 首 run 物化不含远程段，正文永不重写 → 永久缺席 | cr-888 目标不变量「物化 = 全段求值」被时序击穿 | 高 |
| P3 | GROUP_CONTRACT 动态内容坐静态区 | 段文内嵌 `[群聊 gid「群名」]`（collab-tools L160 邻域）——群名可变（改名即失效 355 之后全部缓存），且群身份在 CONVERSATION(900) 已由 `[当前群聊]` 承载——双写 | sections.ts L21 自家分类法「会话动态 900+，静态在前」 | 中 |
| P4 | TERMINOLOGY 段位漂移 | 250 坐「环境 200-299」区，实为协作词汇表 | 同上分类法（引用/投影 100-199） | 低 |
| P5 | 段位与认知信息构建链错配 | PTC_SDK（数 KB 参考材料）插在认知链 112→200 之间：注意力稀释 + KV 失效面 760→460；TERMINOLOGY 与引用词汇同层却隔三个环境段（词汇层分裂）；REFERENCE 组 110/111/112 连号零插入位 | 判据 v2：认知信息（身份→词汇→世界模型）须连续成链；参考材料不占框架位 | 中 |

## 1. 裁决请求（实施前拍板）

1. **A（扩展段区形态）——已裁决（2026-11-08 用户）**：放弃封闭词表 + EXT 区间门，
   改**动态注册机制**：贡献方自报 name + order，无词表审批。保留两条边界：
   order ∈ [0, 900)（900+ 会话动态收尾区为核心保留——护 KV 不变量，技术性非官僚性）；
   SECTION_ORDER 降级为核心行共用常量表（闸门→惯例，内部行单源防魔法数字，不约束生态）。
2. **B（段集漂移的通知面）**：段**名集**变化 → ledger 通知（行为面，对齐 §4-1 精神）；
   段**文本**漂移 → 仅 debug 日志 + 指纹更新，不通知（尊重 cr-888 §5「散文措辞漂移
   不注入」既有裁决）。若用户要文本漂移也通知，扩 §4 表即可，机制不变。
3. **C（GUIDELINES_TIMER 的 notSingle 门）——已裁决（2026-11-08 用户确认）**：放开。
   查证：三远程段 notSingle 是 cr-886 统一门形惯性（TERMINOLOGY/COLLAB 有语义理由——
   协作知识对 singles 是噪音；TIMER 无独立论证，纯跟随）；notSingle 非工具门控而是
   会话形态门，与「有 timer 能力才教」正交。gate 改 `{ toolsAny: ['timer'] }`——工具
   在场判定与本地段同构（widenToolsForGating；timer 代理走 requiredTags:['infra'] 壳闸，
   展开面即生效工具面）。依赖链：P2b（prepare 缝）先行——TIMER 进 singles 快照要求
   物化时远程契约已应用。host-face/src/sections.ts 注释记档此变更。
4. **D（段位重排）——已裁决（2026-11-08 用户确认 PTC_SDK 后移）**：判据从「角色锚定」
   升级为「认知信息构建链」（§9）。三步：PTC_SDK 150→450（参考材料让出框架位——
   单块过大易注意力漂移）；词汇聚簇（REFERENCE 110/114/118 + TERMINOLOGY 122——
   词汇层连续成链）；§9 判据表立为段位分配的正典依据。

## 2. P1：动态段位注册 + sap-adt hack 退役（裁决 A 形态）

### 2.1 契约（ac-agent-loop/src/sections.ts / service.ts）

- 注册入口合一：`registerPromptSection({ name: string; order: number; text; description? },
  owner)`——name 开放任意非空串（去 SectionName 封闭闸），order 贡献方自报。核心 26 段
  事实上仍走 SECTION_ORDER 惯例值（见下），类型面从「具名联合」放宽为 string，
  sectionOrder() 未知名抛错的闸退役。
- 唯一硬边界（注册期校验，fail-loud）：**order ∈ [0, 900)**——900+ 为会话动态收尾区
  （CONVERSATION 900 / DATETIME 910），核心保留；第三方段排到日期行之后会打穿
  「日翻只失效日期行自身」的 KV 不变量，此边界是技术性的，非词表官僚。
- SECTION_ORDER 降级保留：闸门 → 核心行共用常量表。26 个核心段继续引用（单源防
  魔法数字漂移），但不再构成注册白名单；表头注释改述「核心段惯例位分配（生态段
  自由注册，order < 900）」。建议生态段落 300-899 惯例带（指引 300-499 / 扩展 500+），
  文档约定，不代码强制。
- 同名冲突仍抛错（不变）；同 order 不冲突——排序键本就是 (order, name) 双键，
  name tiebreaker 已在（assembleSystemPrompt L105），生态撞核心位不破坏确定性。
- 治理注释写明 KV 纪律：自报段 text 须 per-run 稳定；会话动态内容不进自报段
  （900+ 区或 context 行是正位）。

### 2.2 快照与远程段面随宽（cr-888 零机制改动）

- FrozenPromptSection { name: string; order: number; text } 本就数值承载——动态段
  物化/冻结/重组装零改动兼容。
- ac-host-face-core contract.ts `HostFaceSectionSpec.name` 同步放宽为 string + order
  字段新增（宿主远程段自报位）；knownSectionName 校验放宽为词形校验（非空 +
  order ∈ [0,900)），未通过仍拒装 fail-loud。HOST_FACE_SECTIONS 值补 order（现三段
  沿用 SECTION_ORDER 惯例值）。

### 2.3 sap-adt 迁移（hack 退役）

- 删 loop/before-run 注入监听（index.ts L198-214）与 ExtensionMeta.listeners 对应条目；
  改 `ctx.agentLoop.registerPromptSection({ name: 'sap-adt-guide', order: 500,
  text: provider }, 'ac-sap-adt')`（动态形态——无需上游词表；命名去 EXT_ 前缀规约，
  直接以行名开头防撞）；ADT_TOOLS_GUIDE 措辞逐字不动（文案纪律：现有测试锁定）。
- provider 门控迁移时修正一个连带 bug：现判据 `request.tools ?? 全目录` 在
  tc-programmatic 下面（request.tools 收窄为 ['run_code']）会静默漏注入，而 run_code
  程序经 SDK 投影**能**调 adt_*——改用 widenToolsForGating 展开面判定（与 collab-tools
  各段同源单例）。
- inject 增补：start-time 段注册按 cr-282 规则声明 `['agentLoop', 'tools']`。
- order=500（惯例带指引区之后、900 之前——规约属强行为约束，置扩展带首位）；
  「日期行绝对收尾」不变量自动恢复。

## 3. P2a：指纹增段集维度（cr-888 §3 键面扩展）

- fingerprintOf 新增两键（求值口径与 ptcSdk 同——snapshotRequest 现算）：
  - `sectionSet`：物化段名清单（排序 join）的 hash——覆盖全部注册段（核心 + 动态）；
  - `sectionTexts`：[段名 + order + 段文本 hash] 排序序列的 hash——**order 入键**：
    段位变化 = system 字节变 = 前缀从变化点全失效（缓存域必死），按 cr-888 裁决
    「③ 只在缓存域必死时动快照」，段位变化走 ③ 重算通道（分流见下）。
- 分流（diffFingerprints 增两条，进 §4 表）：
  - sectionSet 变化 → 注入：`[会话设置] 系统提示词已新增段落：<段名>（快照基线将在下次模型切换时收编）。`
    / `[会话设置] 系统提示词段落已移除：<段名>，其指引不再适用。`（新增/移除分句，清单逗号并列）；
  - 仅 sectionTexts 变化 → 分两路：**order 漂移**（段名集不变、位变）→ 视同缓存域必死，
    走 ③ 重算 + debug 日志（不发通知——重算后 system 自明，无「旧先验失效」幻觉面）；
     纯文本漂移 → 不注入（裁决 B），debug 日志一行 + 指纹更新（漂移只报一次）。
4. **B（段集漂移的通知面）——已裁决（2026-11-08 用户）**：维持档 2——段名集变化
   → ledger 通知；段文本漂移 → 不通知（debug 日志 + 指纹更新）。论证：行为面变化已被
   cr-888 §3 十类键全覆盖（工具/档位/技能/SDK 各有专属通道），「文本变但十类键不变」
   的残余恰是散文（§5 豁免类）；singles 冻结缺口由「强约束漂移必连带工具面变化」+
   「model 切换 ③ 重算收编」双兜。治理补强：强行为规约不裸依赖 system 文本——正位是
   工具描述（tools 键覆盖）或 needPermission（权限拦截）；文本层只留引导性散文。
- 红线测试沿用 §3 惯例：新键缺席 = 段漂移永久失明——断言快照含两键且首物化即写。
- 注意：sectionSet 求值依赖注册面完整——P2b 修复是其前置（否则远程段缺席会先误报一次
  「新增段落」，宿主恢复后的下一个 run 到来——一次性噪音，可接受但测试要锁定该行为）。

## 4. P2b：物化前移「段装配就绪」缝

- ac-agent-loop 新增服务方法 `registerSectionPrepare(fn: () => Promise<void> | void,
  owner)`（fiber.effect 归属，复用现有机制）；`run()` 入口第一拍 `await` 全部 prepare
  （Promise.all，单 fn 抛错 warn 后放行——host 离线不得 veto run；1500ms 超时同放行）。
- ac-host-face-client 注册 prepare：`async () => { await pending; ensureAssembled(); }`
  ——staged 应用从 before-run 回调挪到 run 入口调用链（同为 run() 执行链上的同步调用，
  fiber 域特征与 before-run 回调一致；若实测再现 cr-886 挂死，回退方案：prepare 只等
  staging，apply 仍走 before-run，物化对远程段的首拍缺席由 §3 的一次性「新增段落」
  通知兜底——显式接受，注释记档）。
- 红线测试：fresh boot + 宿主契约含远程段 + 首 singles run → 快照 sections 含远程段；
  宿主离线 → 首 run 不死等、正常收束（超时放行路径）。
- 时序不变量（测试锁定）：syncPrefixSnapshot 晚于全部 prepare 完成——即「物化 = 全段
  求值」在 cr-888 §0 语义上恢复成立。

## 5. P3：GROUP_CONTRACT 静态化（去群名头）

- 段文删首行 `[群聊 gid「群名」]`，保留纯行为契约（per-Agent contractText 覆盖机制
  不动）；群身份唯一承载 = CONVERSATION(900) `[当前群聊]` 行——双写收敛为单源。
- 效果：段真静态化，355 位次与分类法自洽；群改名只失效 900 之后（CONVERSATION/DATETIME
  本就会话动态，失效面正确）。
- 测试：collab-tools 段断言更新（锁新词形）；prefix-snapshot 快照如涉及群会话同步。

## 6. P5/P4：段位重排——PTC_SDK 后移 + 词汇聚簇（裁决 D）

- PTC_SDK 150 → **450**：参考材料让出认知链框架位（数 KB 签名投影夹在词汇层与
  世界模型层之间——用户确认「单块太大，容易让注意力漂移」）；450 = 指令区 410
  之后、动态区 900 之前——认知分层正位 + KV 失效面 760→460。tc-programmatic 下
  每轮使用的论据不敌认知稀释——参考材料是回查字典，不吃 primacy 红利。
- 词汇层聚簇（§9 分层表落地）：REFERENCE_FS 110 / REFERENCE_AGENT 114 /
  REFERENCE_SESSION 118 / TERMINOLOGY 122——输入语言词汇 + 系统术语表连续成链，
  消除「术语表隔着三个环境段才到、350 协作指引立即使用其概念」的认知断裂；
  组内改 4 间隔留插入位（原 110/111/112 连号零缝）。
- 段位注释与 system-prompt-decentralization-plan.md §3 表同步；旧 P4 的「TERMINOLOGY
  →120」并入本节聚簇方案（122 位）。
- 影响面核查：TERMINOLOGY 本地段与远程段均 gate notSingle → singles 会话恒缺席
  → 快照与指纹零影响；非 singles 段序变化走 §3 order 漂移 → ③ 重算。

## 7. 实施顺序与验证

顺序（依赖链）：
1. §2.1 契约（动态注册：name 放宽 string + order ∈ [0,900) 硬边界 + SECTION_ORDER 降级注释）
   + §2.2 快照/远程段面随宽；
2. §4 prepare 缝（P2a 的前置）；
3. §3 指纹两键 + diff 两条 + 红线测试；
4. §2.3 sap-adt 迁移（hack 退役 + widenToolsForGating 判据修正）；
5. §6 段位重排（PTC_SDK 450 + 词汇聚簇 110/114/118/122——改 SECTION_ORDER 值 +
   受影响测试快照）；§5 GROUP_CONTRACT 静态化；裁决 C（TIMER 去 notSingle，gate 改
   `{ toolsAny: ['timer'] }`——P2b 已就位，进 §4 后即安全）；
6. 文档收口：decentralization-plan §3 表（EXT 行 + sap-adt owner）、sections.ts 区间注释、
   materialization-plan §3 键面与 §4 表增行、裁决 C 若放开则 host-face/src/sections.ts 注释。

验证阶梯（契约/事件/行集/持久化全动）：`pnpm typecheck && pnpm test:unit &&
pnpm check:deps` + 定向 lint（改动文件/目录）+ `pnpm test` 全量 + `pnpm test:integration`；
定向：ac-agent-loop sections 测试、ac-shell-conversation prefix-snapshot 测试、
ac-host-face-client client-row 测试、ac-collab-tools、ac-sap-adt。

## 8. 判据 v2：认知信息分层（段位分配正典，随裁决 D 立档）

模型处理 system prompt = 逐段构建世界模型。信息四类各有正位：

| 信息类型 | 定义 | 正位 | 现状段 |
|---|---|---|---|
| 认知信息 | 身份、词汇、世界模型——构建「我是谁/在哪/系统怎么说话」的框架 | 前置且按依赖链连续：身份 → 词汇 → 世界模型 | CALLER/PERSONA/MEMORY/SKILLS → 引用+术语聚簇 → ENV_* |
| 行为指令 | 在已建框架上定义操作规范 | 中部 | GUIDELINES_* 300-410 |
| 参考材料 | 字典式签名/清单，按需回查，不参与框架构建 | 指令后、动态前——大块低密度材料前置稀释框架保持 | PTC_SDK 450、sap-adt-guide 500 |
| 动态状态 | 每会话/每 run 变化的情境事实 | 收尾 | CONVERSATION 900 / DATETIME 910 |

- 原「角色锚定」判据只管 persona 打头；v2 要求整条认知链连续——本节为后续新段
  位分配的依据（生态段惯例带 300-899 的细分可引本表）。
- 与 KV 判据的关系：两者独立成立、此处同向（参考材料恰是高频变化段——投影随
  工具注册面变）。冲突时（低频参考 vs 高频指令）认知判据优先——注意力一次损失
  重于缓存一次重算。

## 9. 不做什么（显式边界）

- 不开放 900+ 核心区注册（CONVERSATION/DATETIME 词表封闭面不动——护 KV 收尾不变量）；
- 不引入动态段的 per-Agent 启停 UI（行级启停已覆盖——行卸载 = fiber 回收段）；
- 不改「快照正文永不重写」四机制（§3 只加检测与通知，重算仍仅 model 切换）；
- 不回退 cr-886 两段式装配的既有形态（prepare 是新增前置缝，不是重构）。
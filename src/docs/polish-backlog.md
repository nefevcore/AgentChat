# 细节优化清单（polish backlog）

> 状态：§一（P1–P12）✅ 全部完成 + §二 C3/C4/C5/C6/C8(①②) ✅（2026-08-30 打磨轮；C1/C2/C7 及 C8③ 徽章族未做，见各条注）。来源：2026-08-30 会话末用户反馈 7 条（§一）+ 同日追加 P8–P12 + 未决事项合并（§二 UI/交互打磨候选、§三 架构演进项）。供打磨阶段逐项领走；完成一项勾一项并在提交信息引用条目号。
>
> 基线：32726bc（801 测试全绿）。涉及前端的条目完成后需 `pnpm preview:webui:build`；涉及后端的需重启实例。
>
> 本轮完成态：804 测试全绿（+3：P2 settingsOf 收口用例 ×1、P5 官方 loader-boot 聚合用例 ×2）+ typecheck（preview 与 webui vue-tsc）+ webui build + smoke 均过。

## 一、用户反馈（优先）

### ✅ P1. 插件目录：可配置项过滤勾选
- **现象**：想快速找到有配置项的插件，需逐张卡片找 ⚙ 徽章。
- **修法**：插件视图工具行加一个 checkbox「只看可配置」——过滤 `builtinWithExt` 中 `ext` 命中且 `configNs` 在场的条目（复用 `extOf`）；过滤态在 zone 标题显示计数。
- **涉及**：`webui/src/settings/components/PluginLibraryPane.vue`。
- **落点**：`.pl-filter-row` + `onlyConfigurable`/`visibleBuiltin`；过滤态 zone 标题显示「命中 N / 总数」，过滤空结果有专门空态文案。

### ✅ P2. 全局设置：「会话回放」移出，收口为插件可配置项
- **现象**：全局设置导航的 `sys.session`（会话回放，M21/D14 的 `session.replayTrajectory` 布尔开关）本质是 ac-session 的行为参数，在全局设置里属于冗余展示位。
- **根因**：M21 时代落在全局 config 域（`config.session.replayTrajectory`），早于 M24 X1/A1 的 `settings[具名]` 词汇收口。
- **修法**：
  1. `EXTENSION_CATALOG` 的 `session` 条目（automatic，现无 configNs/fields）补 `configNs: 'session'` + `fields: [{ name: 'replayTrajectory', description: '轨迹回放…' }]`；
  2. 后端消费点改读 `settingsOf` 合成（全局默认层 ∪ Agent 差异层）——注意向后兼容：存量 `config.session.replayTrajectory` 值迁移或双读过渡；
  3. 前端移除 SettingsPanel 的 `sys.session` 导航叶与会话回放面板块。
- **涉及**：`ac-web-api/src/index.ts`（EXTENSION_CATALOG）、`ac-session`（消费点）、`webui/src/settings/components/SettingsPanel.vue`、可能 `ac-config` 白名单（CONFIG_KEY_PREFIXES）。
- **落点**：双读过渡（`SessionService.replayTrajectoryOf`：settingsOf 显式值优先 → 回落存量 config 键；存量 `session` 前缀白名单保留）。config 白名单无需动（`settings` 键已在）。README / session-design.md §2.5 已同步新键语义。测试：`ac-session/tests/replay-trajectory.test.ts` 补合成层/覆盖/双读用例。

### ✅ P3. 工具清单卡片：id 重复显示
- **现象**：卡片标题行显示两遍工具 id。
- **根因**：`plugin-name` 渲染 `t.label || t.name`，旁边 `plugin-version` 又渲染 `t.name`——工具大多无 label，name 出现两次。
- **修法**：仅当 `t.label && t.label !== t.name` 时显示第二格 id 徽章；否则只显示一格。
- **涉及**：`PluginLibraryPane.vue` 工具视图卡片。

### ✅ P4. 工具详情弹窗：文字颜色过灰
- **现象**：详情内容（参数表说明列等）对比度不足。
- **修法**：`.tp-desc`/`.tp-type`/`.tp-default` 由 `--text-3` 升 `--text-2`；表头保持 `--text-3` 但字重已足够。整体过一遍弹窗内 `--text-3` 用量，正文性文字一律 `--text-2` 起。
- **涉及**：`PluginLibraryPane.vue` 样式节。
- **落点**：`.tp-type`/`.tp-enum`/`.tp-default`/`.tp-desc` 升 `--text-2`（`.tp-desc` 显式声明；表头 `th` 维持 `--text-3`）。

### ✅ P5. 事件清单：叶节点归属显示「Loader」
- **现象**：监听器叶节点 owner/行名显示成 Loader，而非所属插件 id。
- **根因**：`ac-event-policy/src/aggregate.ts` 的 `rowOfFiber` loader 路径——`topLevel` 集合取自 `loader.root.store`（**根组直接 entry**），但官方 boot 下全部 yml 行嵌在 include 子树内，根组只有 include 载体一行 → 行 fiber 沿祖先链命中的顶层 entry 恒为 include/Loader 侧，聚合失效（`aggregate.test` 大概率只覆盖了程序化路径）。
- **修法**：top-level 判定改为「include 子树内的直接 entry 集」（或等价地：沿祖先链取**最近的带 `options.name` 的 entry**）；补官方 loader-boot 路径的聚合测试（bootTest 真实 yml，断言 ws-bridge/security 等监听器 row = 对应 `ac-*` 包名）。
- **涉及**：`ac-event-policy/src/aggregate.ts`、`ac-event-policy/tests/aggregate.test.ts`。
- **落点**：实查根因更具体——`EntryGroup` 根本没有 `store` 面，`loader.root.store` 恒 undefined → loader 路径是死代码，静默回落程序化路径（root 直接子 = Loader 服务 fiber → 全显 Loader）。修法取等价形态：loader 在场时沿祖先链取**最近 entry**（`options.name ?? id`；行内子 fiber 经 internal/plugin 继承 fiber.entry，首个命中即归属行）。boot 测试落在 `ac-app/tests/aggregate-boot.test.ts`（真实 yml + bootFromConfig 脚手架现成；放 ac-event-policy 会引入对组合根的倒挂依赖）。

### ✅ P6. 事件清单：治理入口去重 +「治理」改名
- **现象**：事件节点的「治理」按钮与叶节点的「×」按钮都调用 `openGov(owner, event)`——同一功能两处入口；且事件节点按钮取 `listeners[0].owner`，多监听器时语义含混；「治理」一词不自明。
- **修法**：留叶节点入口（粒度正确、上下文清晰），移除事件节点按钮；「×」改为明确的「停用」小按钮（icon + tooltip「停用该监听器（重启生效）」）；`openGov` 确认弹窗标题同步用「停用 …」。若需要事件级批量停用，后续再加（显式「停用全部监听」文案），首期不做。
- **涉及**：`PluginLibraryPane.vue` 事件树模板 + 治理确认弹窗文案。
- **落点**：事件节点按钮移除；叶按钮 = `<Icon name="x"/>停用` 胶囊（tooltip 同建议）；弹窗与注释全部「关停 → 停用」统一。

### ✅ P7. 设置弹窗左侧导航：menu-item 风格不统一
- **现象**：`.sp-navitem` 字体颜色偏浅，与插件库左导航（`.pl-navitem`）、其他菜单项视觉不一致。
- **修法**：对齐 `.pl-navitem` 的规格——默认 `--text-2`、hover `--bg-hover`、active 态 `--text-1` + 字重 500 + 边框/底色强调；顺带核对全局 menu 类组件（AgentListPane/PoolManager 侧栏等）统一令牌用量，必要时抽公共样式。
- **涉及**：`SettingsPanel.vue` 样式节（可顺带全局面板走查）。
- **落点**：`.sp-tree-leaf(:hover/.active)` 对齐 pl-navitem 规格（active 从 primary 着色改 `--bg-surface`+`--text-1`+500+`--line-strong` 边框）；`.sp-tree-cat:hover` 令牌统一 `--bg-hover`。查证：AgentListPane/PoolManager 无侧栏 menu 类组件（清单当时的猜测）；全局 menu 类组件（AgentList `.menu-item` 等）hover 已用 `--role-hover-bg` 回落 `--bg-hover`（两令牌同值），不动。

### ✅ P8. 事件清单：模板化兜底描述（「X 在 Y 上的监听」式同义反复）
- **现象**：`loop/before-run` 下出现「MCP 工具发现 在 loop/before-run 上的监听」这类表述——事件描述是 `events/descriptions` 对未声明 description 的监听条目做的模板兜底（`${ext.label} 在 ${l.event} 上的监听`；动态插件同款 `${name} 声明订阅`），对用户是纯噪音。
- **修法**：去掉模板兜底——`description` 只透传真实声明（builtin 目录 listeners.description / 动态 manifest provides.events[].description），类型改可选；前端事件节点描述行取**首个带正文的声明**（`eventDescOf`），全无声明则不渲染。行为角色注释（role）不受影响，仍在监听器叶节点呈现（mcp 叶显示「MCP 工具懒建连」）。
- **涉及**：`ac-web-api/src/index.ts`（events/descriptions）、`webui/src/shims/@agentchat/protocol.ts`（EventDescriptionEntry.description 可选）、`PluginLibraryPane.vue`。

### ✅ P9. 事件树风格：叶节点常显灰底 → 对齐运行跟踪树
- **现象**：监听器叶节点 `.evt-leaf` 常显 `--bg-hover` 灰底，整树行风格与运行跟踪（RunTrackingPanel）树不一致。
- **修法**：事件树整体对齐运行跟踪树规格——30px 行高、透明底色、hover 浮起（bg + 边框 + 微影）、caret 换 chevron 图标、叶「停用」按钮 hover 浮现（leaf-stop 同款，含 focus 可达性）；scope 根与事件节点**合并为一套行样式**（`.evt-scope-node, .evt-node` 同规则组，修饰类只管缩进/着色）；叶 owner 从盒装 chip 改纯 mono 文本（与 leaf-name 同风）。**追加（同日反馈）：监听器叶节点行首补 `activity` 图标**（16px 列，与事件节点 caret 列同位对齐——caret 列 = 节点、activity 列 = 监听器叶，层级一眼可辨；停用态随 dim 半透明）。
- **涉及**：`PluginLibraryPane.vue` 事件树模板 + 样式节。

### ✅ P10. Agent 设置·装配页完全对齐插件库页（2026-08-30 追加，用户裁决）
- **现象**：装配页（ExtToolsPane）与插件库页（PluginLibraryPane）结构同源但形态漂移——左导航 active 用 primary 着色、行卡是旧 hook-row 密排（· 前缀点 + id 徽章横排）、事件视图是 evt-card 链式 chip、工具详情无参数表、开关是裸 checkbox。
- **修法**：装配页整体重写为插件库页同构——
  - 左导航：pl-navitem 同规格（active = bg-surface + text-1 + 500 + line-strong 边框；count 胶囊；去分隔线）；
  - 扩展视图：plugin-item 卡片解剖（名称 / settings 键徽章 / ⚙ 可配置 / 落点·状态徽章 / 描述 + 行尾红绿开关）；基础设施行 = `.ui-row.is-auto` 虚线 + 「基础设施」徽章；动态装载只读区同卡片化；卡片点击直达「配置（差异层）」弹窗（原两段跳 detail→配置 收敛为一段，与插件库交互一致）；
  - 工具视图：插件库工具卡片同款（label/id/能力标签徽章[具备=主色·缺失=红]/三态徽章 + 意图开关）；详情弹窗移植参数表格化（toolParamRows + JSON Schema 表）；
  - 事件视图：插件库事件树同款（run/host scope 根 → 事件节点 → 监听器叶[activity 图标 + owner + role 描述 + facet 标注]），灰显 = 本 Agent 软停用（facet 感知），无治理按钮（指向插件库）；
  - 红绿开关提升为 `ui/row.css` 的 `.ui-switch`（插件库装配 toggle 同步迁移共用）。
- **涉及**：`ExtToolsPane.vue`（整体重写）、`ui/row.css`（+ui-switch）、`PluginLibraryPane.vue`（switch → ui-switch）。
- **验证**：vue-tsc + preview:test 804/804 + webui build 均过。

### ✅ P11. 装配「扩展」收窄为纯配置覆盖（2026-08-30 追加，用户裁决）
- **诉求**：装配页「扩展」与插件库「插件」完全一致——移除启用/禁用开关，默认筛选存在可配置项的插件，只保留差异层配置覆盖功能。
- **修法**（`ExtToolsPane.vue`）：
  - 导航「扩展」→「插件」；卡片与插件库内置组同款（名称/settings 键徽章/⚙ 可配置/落点徽章/描述），**无行尾开关**；
  - 「按插件分组」「仅显示有参数」两开关移除，换为插件库同款**「只看可配置」且默认开**（zone 标题显示「命中 N / 总 M」，空命中有专门文案）；
  - 基础设施行不再单列 zone——并入插件列表混排（`.ui-row.is-auto` 虚线 + 「基础设施」徽章）；
  - 启停面移除：软停用改经配置弹窗内 enabled 字段（声明了该字段的行——ExtensionSettingsModal 行为开关分区），进程级启停在插件库；`extEnabled`/`toggleExt` 等开关逻辑删除；
  - 动态装载只读区保留。
- **验证**：vue-tsc + preview:test 804/804 + webui build 均过。

### ✅ P12. 插件卡片命名统一（2026-08-30 追加，用户反馈）
- **现象**：插件库「插件」卡片显示 **包名 + 版本**（ac-persona v0.1.0），Agent 装配「插件」卡片显示 **描述 + settings 键**（人设注入 persona）——同一插件两页命名形态不一致。
- **修法**：统一为「**人类可读标签（主名）+ 装配行包名（ID 徽章）+ 版本（有则显）**」——
  - 插件库内置卡：主名改用扩展目录 label（`b.ext?.label ?? 包名`；无目录条目回落包名且不重复显 ID 徽章），包名降为 ID 徽章，版本照旧；
  - 装配插件卡：ID 徽章从 settings 键（e.name）换成**装配行包名（e.row，与插件库同锚点）**，settings 键（配置锚点）移入 tooltip；
  - 动态插件卡（两页）本就是 label + manifest 名 + 版本，天然一致。
- **涉及**：`PluginLibraryPane.vue`、`ExtToolsPane.vue`。
- **验证**：vue-tsc + webui build 过。

## 二、UI/交互打磨候选

- **C1. 今日 UI 全量浏览器走查**：插件卡片（红绿 toggle/⚙ 徽章/点击弹窗/滚动收口）、工具参数表格、事件树、配置弹窗分区（字段描述/enabled 分区）、还原按钮组——全部经事故链阻隔未经目验，是 §一 的前置。**未做：需人工浏览器目验（本轮改动已过单测/构建，目验留给下轮会话）。**
- **C2. 事件树手感**：默认收拢是否合适、展开状态记忆（localStorage）、scope 根计数徽章信息量。**未做：产品手感决策，暂维持现状（scope 根展开/事件收拢）。**
- ✅ **C3. PluginLibraryPane 孤儿 CSS 清理**：重写后遗留（`.pl-event-row` 旧执行链样式族等）。**落点：全量比对模板/样式类名——`.pl-event-row` 族已不存在（前轮已清）；本轮随 P6 移除 `.evt-gov` 基样/`.evt-gov.off`、清除 `.plugin-item + .plugin-item` no-op 规则。**
- ✅ **C4. `PluginMeta.fields` 疑似遗留字段**（`webui/src/settings/types.ts`）——查证消费方后清理。**落点：整个 `PluginMeta` 接口零消费方（旧 hook 目录时代遗留），整体删除；顺带去掉重复注释行。**
- ✅ **C5. 市场零结果引导**：`keywords:agentchat-plugin` 生态为空，空态文案可教人怎么发布/自标。**落点：空态文案改为 opt-in 发现标记教学（npm keywords / github topic，安装仍人审）。**
- ✅ **C6. EXTENSION_CATALOG 覆盖面**：11 条 vs 实际行集——event-policy/market 等新行无目录条目 → 无「⚙ 可配置」徽章（与 P1 联动：过滤后更明显）。**落点：目录扩至 18 条——补 automatic 基础设施条目 plugin-registry/plugin-market/event-policy/backup/timers/workspace（无 settings 面不虚设 configNs）；session 条目随 P2 补 configNs+fields。锁目录形状的测试（web-api extension-catalog / portb-e2e 全链路）已同步。**
- **C7. ws-bridge 30 条监听器描述为同款模板文案**——可接受，可选打磨（按事件名差异化前半句）。**未做（维持清单原判：可选）。**
- ✅ **C8. 卡片风格盘点与收敛（2026-08-30 追加，用户反馈"与整体 UI 风格不适配"；同日裁决按 ①+② 执行，③ 徽章族未做）**：webui 内并存两套行/卡语言——
  - **A 主应用「扁平行」**（AgentList/SessionList `.list-item`、RunTracking `.tree-node/.tree-leaf`、StarCard）：透明底+透明边框、hover 才浮起（bg-hover+边框+微影 `0 1px 3px`）、固定行高、选中 `--role-selected-bg`；
  - **B 设置域「盒装卡片」**：每行常驻 `border: var(--line)` + `background: var(--bg-surface)`、hover 换主色边框、无微影——密度高边框线多，即不适配感来源（与 P9 事件叶"常显灰底"同根）。
  - **落点 ①（死代码清理）**：删除 `PluginCard.vue`（`.plugin-card` 纵向卡，零引用）与 `PluginDevCard.vue`（PluginLibraryPane 死导入未渲染）。
  - **落点 ②（收敛 A 语言）**：新增 `webui/src/ui/row.css` 公共行类 `.ui-row`（透明底/透明边框、hover 浮起 bg+边框+微影、`.is-selected` = StarCard.selected 同 recipe 底面+主色描边、`.is-auto` 静默虚线；main.ts 接线于 tokens.css 后）。五个行卡族迁移为 `class="<语义类> ui-row"`、scoped 样式只剩专属修饰：`.plugin-item`（插件库五视图：内置/待审/本地/工具/市场）、`.hook-row`（装配·扩展/动态插件/工具行；基础设施行 auto → `is-auto`）、`.pool-entry`（池条目；默认标记 `is-default` → `is-selected`）、`.agent-pool-item`（Agent 清单）、`.g-timer-item`（全局定时任务）。弹窗内 `.ext-modal-cfg`/`.mkt-warn` 等小盒维持（弹窗语境可接受）。
  - **遗留 ③（未做）**：徽章族四处重复定义（`.plugin-state-badge`/`.perm-badge`/`.load-badge` 等）可抽公共 badge 类；StarCard 仍零使用（扁平行语言组件化载体，后续新列表可用）。
  - 验证：vue-tsc + preview:test 804/804 + webui build 均过。

## 三、架构演进项（后续里程碑，非本轮打磨）

- ✅ **A1. M22 P3 注册制目录（2026-08-31 落地，用户裁决"EXTENSION_CATALOG 太僵硬"）**：静态表退役——行包在**入口模块**自述 `export const extension: ExtensionMeta`（新纯库 `ac-extension-core` 契约：name[settings 键锚点]/label/description/automatic/fields/listeners——M25 P2 监听器级声明原样迁入；type-only 零运行时依赖）；ac-web-api `collectExtensionCatalog` 扫 cordis registry 聚合（vendor `Runtime.plugin` 检视面存源插件对象——src/lib/d.ts 三处同步，registry 本体零应用词汇）；派生 row=runtime 名、targets=listeners[].event 去重、configNs=name（fields 非空才透出）。行装载即条目在、卸载即条目失；**新增可配置行 = 入口加一个 export，不再改消费方**。18 个 owning 行迁移（含 C6 补的基础设施行）；wire `targets` 放宽 string（落点自由生长，未知回落原文）。
- **A2. `agentchat.contracts: "^1"`**：声明位已留，等市场/版本门工作启用（勿提前加投机字段）。
- **A3. npm 发布行包 + 市场打通**：`keywords: "agentchat"` / `agentchat.plugin: true` 已就位；发布与 `market/search` 消费是下一步。
- **A4. 生产 bundle 目录演进**：生产形态内置组为空（既定缩水），由 market + 声明判据接管。
- **A5. dep-graph 软依赖盲区**：`ctx.get` 依赖不在图内（已文档化；补齐需静态分析，代价高收益低）。
- **A6. ac-web-api 静态 inject 瘦身**（17 项）：级联易碎的根源；已有急救行缓解，「RPC 面这么容易挂」本身可改——非核心 inject 改 `ctx.get` 软依赖（RPC 失败容忍）或拆面。改动面大，需单独立项。

## 四、边界备忘（勿顺手恢复）

- M24/M25 缩水红线：监听器优先度/重排、**单监听器粒度治理**、capabilities 减法、签名形态统一、治理面按 Agent 细分（归 agentGate facet）。
- 停用 ac-web-server = UI 无法自救（传输本体），手工编辑 cordis.patch.yml 是设计兜底。
- `workspace/default` 是 src 旧轨数据，preview 迁移脚本不得触碰。

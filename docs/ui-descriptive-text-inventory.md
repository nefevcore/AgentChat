# UI 描述性文本清单（tooltip / 帮助文档化改造素材）

> 目的：收集当前**渲染在页面上**的说明性/解释性文本，供改造为 tooltip 或迁入帮助文档（用户手册将随新架构重写），让页面保持简洁。
> 范围：`src/webui/src` 全部 Vue 组件。代码注释（不渲染）不收；纯按钮/标签词不收。
> 每条含：位置（文件:行）、页面区域、呈现方式、原文、改造建议。
> 行号以收集时（2026-10）代码为准，后续漂移以就近搜索原文为准。

## 呈现方式图例

| 标记 | 含义 |
|---|---|
| 常显 | 始终/条件渲染在页面上的正文说明 |
| 空态 | 列表为空时显示的引导语 |
| 弹窗 | 模态弹窗内的说明 |
| placeholder | 输入控件占位文本 |
| title-hover | 已挂在 `:title` 上的悬浮提示（改造为帮助文档素材或统一 Tooltip 组件的候选） |

## 改造建议图例

- **→ 帮助文档**：机制解释（写哪个文件、什么事件热更、分层语义、治理模型），页面只留一句短话或 ? 图标。
- **→ tooltip**：操作入口指引、开关后果、徽章含义等即看即用的短说明。
- **→ 保留**：空态引导、错误恢复路径等任务必需上下文（可精简措辞）。

---

## 1. 设置 · 插件库 `PluginLibraryPane.vue`

### 1.1 常显说明

| 位置 | 区域 | 呈现 | 原文 | 建议 |
|---|---|---|---|---|
| PluginLibraryPane.vue:670-672 | 插件库顶部·安全模式横幅 | 常显（safeMode 时） | 安全模式生效中——动态插件本次全部未装载（AGENTCHAT_SAFE_MODE 或 .safe-mode 标记）；yml 装配行不受影响。删除数据根下的 .safe-mode 文件并重启可恢复。 | 保留（异常态恢复指引），可精简为一句 + 详情进帮助文档 |
| PluginLibraryPane.vue:688-690 | 「插件目录」·区块标题 | 常显 | 装配行（N）—— cordis.yml 出厂组合 × cordis.patch.yml 强制停用；文件 xxx | 「——」后半 → tooltip；计数保留 |
| PluginLibraryPane.vue:694-696 | 「插件目录」·RPC 兜底告警 | 常显（catalogError 时） | 插件目录 RPC 面不可用（xxx）——以下清单自动并入 cordis.patch.yml 兜底条目（“目录外”行，急救开关照常可用）。手工恢复：编辑数据根下 cordis.patch.yml 删除停用条目后重启进程。 | 保留（急救路径），机制部分 → 帮助文档 |
| PluginLibraryPane.vue:741-744 | 「插件目录」·页脚注 | 常显 | 强制停用 = 行级装配开关：关闭立即卸载整行并写入 cordis.patch.yml（重启保持停用）；“承重”徽章 = 停用将级联断链的注入方。软停用（跳过行为、行仍装载、Agent 可覆盖）在「插件配置」页签——两者分层不混淆。 | → 帮助文档「启停两层」词条；页脚留一句 + ? 图标 |
| PluginLibraryPane.vue:772-774 | 「插件配置」·插件视图·区块标题 | 常显 | 内置（N）—— 包源清单；右侧开关 = 软停用（行为门控，行仍装载；Agent 可覆盖） | 「——」后半 → tooltip（现 zone-title 已有 title，可合并精简） |
| PluginLibraryPane.vue:775-778 | 插件视图·加载失败说明 | 常显（catalogError 时） | 插件目录加载失败：xxx——常见原因：强制停用级联下线了设置后端（ac-web-api）。恢复路径：「插件目录」页签对该行重新开启（热恢复）。 | 保留（错误恢复），精简后机制 → 帮助文档 |
| PluginLibraryPane.vue:828-830 | 插件视图·本地组区块标题 | 常显 | 本地（N）—— 扫描 <数据根>/plugins/（安装态 ∪ 开发面 ∪ 会话装载） | 「——」后半 → tooltip |
| PluginLibraryPane.vue:831-833 | 插件视图·开发目录提示 | 常显 | 开发目录布局：`<数据根>/plugins/<agentId>/<name>/`（含 manifest.json + 入口） | → 帮助文档「插件开发」；页面留链接 |
| PluginLibraryPane.vue:844 | 待审行·描述位 | 常显 | 暂存待人审——安装前可查看全部文件（只读代理）与内容哈希 | → tooltip（行已有徽章） |
| PluginLibraryPane.vue:890 | 工具视图·区块标题 | 常显 | 工具目录（N）—— 详情看参数表；启停/暴露在 Agent「插件配置 · 工具」视图；同源行大组默认收起 | 「——」后半 → tooltip |
| PluginLibraryPane.vue:909-912 | 事件视图·区块标题 | 常显 | 事件清单（N run + M host）——全量以声明目录为准；叶节点「停用」= 进程级治理（owner::event） | 「——」后半 → tooltip |
| PluginLibraryPane.vue:955-957 | 事件视图·页脚注 | 常显 | 治理键 = `owner::event`（owner 原文；停用集存 config `events.disabled`）。生效时机：注册期吞注册 + boot 末清扫——已注册条目需重启进程（yml 行）或重载插件。承重半边停用可破坏插件内部不变量（session 桶一致性、archive 三闸、供应链防线）——停用前看清角色注释。机械上不做监听器间依赖分析（数据流不可见）。 | → 帮助文档「事件治理」词条；页脚删除或留 ? 图标 |
| PluginLibraryPane.vue:996 | 插件市场·页脚注 | 常显 | 安装流：第三方来源 = 供应链人审（M23 B2 裁决维持）——安装 → **暂存**进入「目录 · 插件 · 本地」组（待审徽章 + 审查文件弹窗：只读文件树 / 哈希 / 权限快照 / 来源锚定）→ 人审批准 → 安装装载。与 Agent 自开发免审流（install_plugin）分立。 | → 帮助文档「插件安装与供应链人审」；页脚留一句 |
| PluginLibraryPane.vue:1036 | 工具详情弹窗·页脚注 | 弹窗 | 「能力标签」与调用方能力集交叉（base ∪ tags ∪ agent:<id>，AND 语义）；「必填」指模型调用时参数必给——两者是不同的门。 | → 帮助文档「能力标签」词条；弹窗内 → ? 图标 tooltip |

### 1.2 空态 / 引导

| 位置 | 区域 | 呈现 | 原文 | 建议 |
|---|---|---|---|---|
| PluginLibraryPane.vue:740 | 插件目录 | 空态 | 无装配行信息（目录与行偏好清单均空） | 保留 |
| PluginLibraryPane.vue:737 | 插件目录·无开关行尾 | 常显 | 未装配——编辑 cordis.yml | → tooltip |
| PluginLibraryPane.vue:779 | 插件视图 | 空态 | 内置目录为空（生产 bundle 首期不内置清单——仅开发形态可用）（catalogNote 兜底） | 保留 |
| PluginLibraryPane.vue:780 | 插件视图·过滤空 | 空态 | 无命中「只看可配置」的行（N/M 行带参数面）——取消勾选查看全部 | 保留（过滤反馈） |
| PluginLibraryPane.vue:853 | 本地组 | 空态 | 暂无本地插件（安装 / 开发 / 会话装载均空） | 保留 |
| PluginLibraryPane.vue:891 | 工具视图 | 空态 | 暂无工具 | 保留 |
| PluginLibraryPane.vue:947 | 事件叶 | 空态 | 零监听器——声明目录条目 | 保留，后半 → tooltip |
| PluginLibraryPane.vue:950 | 事件域 | 空态 | 暂无 xxx 域事件 | 保留 |
| PluginLibraryPane.vue:975-977 | 插件市场·无结果 | 空态 | 无搜索结果。市场按 opt-in 发现标记检索：npm 包 keywords 加 `agentchat-plugin`、GitHub 仓库挂 topic `agentchat-plugin` 即可被搜到（不标则不出现）；安装一律走暂存人审。要分发自己的插件，发布时自标即可。 | 首句保留；发现机制长解释 → 帮助文档 |
| PluginLibraryPane.vue:969 | 市场·搜索框 | placeholder | 搜索 npm / github（npm keywords:agentchat-plugin / github topic:agentchat-plugin） | 精简为「搜索 npm / github」，括号内容 → 帮助文档 |

### 1.3 弹窗内说明

| 位置 | 区域 | 呈现 | 原文 | 建议 |
|---|---|---|---|---|
| PluginLibraryPane.vue:1046-1049 | 市场安装确认 | 弹窗 | 来源：xxx（第三方供应链）· 定位 xxx。第三方来源经**暂存 → 人审 → 安装**（与 Agent 自开发免审流分立）：安装将把包下载进暂存区并在「目录 · 插件 · 本地」生成待审条目；人审可查看全部文件（只读代理）与内容哈希。声明权限以暂存 manifest 快照为准（ui 权限 = 浏览器会话上下文执行，将高亮提示）。 | 保留（安全确认语境）；流程解释 → 帮助文档 |
| PluginLibraryPane.vue:1067-1077 | 治理停用确认 | 弹窗 | 保护行：xxx 承担安全防线（门禁/沙箱/供应链 gate）。停用后**全部 Agent** 失去该防线——自担风险。/ 承重警示：该监听器承担插件内部不变量（如会话桶一致性 / 用量记账）。停用可破坏对应功能。/ 生效时机：注册期——已注册条目需重启进程（yml 行）或重载插件。吞注册 ≠ veto：剩余监听器自动构链照常跑。 | 保留（危险操作确认，属必要警示） |

### 1.4 已是 title tooltip（帮助文档素材 / Tooltip 组件统一候选）

| 位置 | 原文 |
|---|---|
| PluginLibraryPane.vue:700 | 停用全部非核心行，保留会话链+RPC面+急救+安全行+一个 provider——诊断基线 |
| PluginLibraryPane.vue:703 | 清空全部停用条目，回到出厂 cordis.yml 全量装配 |
| PluginLibraryPane.vue:714 | cordis.patch.yml 已停用——当前进程该行已卸载/不再装载 |
| PluginLibraryPane.vue:715,796 | 不在当前组合（cordis.yml）——装配 = 编辑 yml |
| PluginLibraryPane.vue:716 | 条目 id 未命中目录/装配清单（目录 RPC 阵亡或陈旧条目）——急救开关仍可用 |
| PluginLibraryPane.vue:717 | 承重行——停用将级联断链注入方：xxx |
| PluginLibraryPane.vue:725-727 | 强制停用开关（当前停用）：开启 = 立即装载该行（清除 cordis.patch.yml 停用条目）/ 强制停用开关（当前装载）：关闭 = 立即卸载该行（写入 cordis.patch.yml，重启后保持停用） |
| PluginLibraryPane.vue:767 | 只显示带参数面（enabled 行为开关以外有具体字段）的行——快速定位 ⚙ 可配置插件 |
| PluginLibraryPane.vue:772 | 软停用写 config.json 全局默认层（settings.<configNs>.enabled，config/changed 热更）；强制停用入口在「插件目录」页签 |
| PluginLibraryPane.vue:784 | 点击卡片配置（全局默认层） |
| PluginLibraryPane.vue:794 | 带参数面（点击卡片配置） |
| PluginLibraryPane.vue:795 | cordis.patch.yml 已强制停用（行不装载）——软停用开关无意义；恢复入口在「插件目录」页签 |
| PluginLibraryPane.vue:804-808 | 行已被强制停用（cordis.patch.yml）——先在「插件目录」页签恢复装载 / 软停用开关（当前停用）：开启 = 恢复该插件行为（行本就装载，立即生效）/ 软停用开关（当前启用）：关闭 = 跳过该插件行为（行仍装载；写 settings 全局默认层，Agent 差异层可覆盖） |
| PluginLibraryPane.vue:821 | 此行未声明行为门控（enabled），无软停用——行级强制停用在「插件目录」页签 |
| PluginLibraryPane.vue:841,343 | 暂存待人审 |
| PluginLibraryPane.vue:862 | 归属 Agent（开发/安装者） |
| PluginLibraryPane.vue:863 | 会话级装载（重启即失） |
| PluginLibraryPane.vue:864 | M23 F7：携带非隔离 UI（可读会话流/以用户身份调 RPC） |
| PluginLibraryPane.vue:897,1013 | 能力标签（AND）——调用方能力集（base ∪ tags ∪ agent:<id>）须全含才可用 |
| PluginLibraryPane.vue:943 | 停用该监听器（重启生效）——治理键 owner::event 写 config events.disabled |
| PluginLibraryPane.vue:927 | 链首有 prepend 监听器（插队执行） |
| PluginLibraryPane.vue:935 | 监听器（owner 注册的事件监听） |
| PluginLibraryPane.vue:936 | owner: xxx（prepend） |
| STATE_LABELS（PluginLibraryPane.vue:337-343） | 已装载=进程内已装载；已安装·未装载=registry.json 安装态；boot 扫描恢复装载；装载失败=最近一次装载失败（见 error）；已熔断=连续装载失败熔断；复位 = bump version 重装 / 卸载 / 删 .load-health.json；开发面=devScan 扫描到、未安装——可装载试跑或暂存发布 |
| EVT_SCOPE_ROOTS（PluginLibraryPane.vue:534-536） | run=发生在某 Agent 执行上下文内（可 per-Agent 门控：agentGate）；host=宿主/进程生命周期（仅治理面——不可 per-Agent 门控） |

---

## 2. 设置 · Agent「插件配置」页 `ExtToolsPane.vue`

### 2.1 常显说明

| 位置 | 区域 | 呈现 | 原文 | 建议 |
|---|---|---|---|---|
| ExtToolsPane.vue:361-363 | 插件视图·顶部说明 | 常显 | 点击带 ⚙ 的卡片编辑本 Agent 差异层（只存差异项，空 = 继承全局默认；生效 = settingsOf 合成，差异优先）。行尾开关 = 本 Agent 软停用（差异层 enabled，行仍装载、监听器跳过）；进程级启停在插件库。 | → 帮助文档「差异层」词条；页面留一句 + ? |
| ExtToolsPane.vue:372-374 | 插件视图·区块标题 | 常显 | 插件（N）—— 行尾开关 = 本 Agent 软停用；点击 ⚙ 卡片配置差异层 | 「——」后半 → tooltip |
| ExtToolsPane.vue:419 | 动态装载·区块标题 | 常显 | 动态装载（N）—— 只读；启停与卸载在插件库 | 「——」后半 → tooltip |
| ExtToolsPane.vue:447-449 | 工具视图·顶部说明 | 常显 | 工具按能力标签门禁默认提供；开关写 tools.include / tools.exclude（exclude 优先）。点击卡片看参数表。 | → 帮助文档「工具门禁」；页面留一句 |
| ExtToolsPane.vue:453 | 工具视图·区块标题 | 常显 | 工具目录（N/M）—— 详情看参数表；启停 = 本 Agent 工具意图；同源行大组默认收起 | 「——」后半 → tooltip |
| ExtToolsPane.vue:497-500 | 事件视图·区块标题 | 常显 | 生效链（N run + M host）——灰 = 本 Agent 软停用（settingsOf 门控，分发时跳过、链继续） | 「——」后半 → tooltip（图例） |
| ExtToolsPane.vue:541-548 | 事件视图·页脚注 | 常显 | 粒度边界：per-Agent 停到「行为 / facet」为止——本页无事件粒度开关，owner::event 进程级治理在插件库 · 目录 · 事件。注：部分监听器属声明目录未覆盖的行、或未声明 respectsEnabled——「停用未必生效」（该行未承诺自查 enabled；agentGate 普及后自然收敛）。 | → 帮助文档；页脚删除或留 ? 图标 |
| ExtToolsPane.vue:601 | 工具详情弹窗·页脚注 | 弹窗 | 「能力标签」与调用方能力集交叉（base ∪ tags ∪ agent:<id>，AND 语义）；「必填」指模型调用时参数必给——两者是不同的门。 | 同 PluginLibraryPane.vue:1036（两处同文） |

### 2.2 空态

| 位置 | 原文 | 建议 |
|---|---|---|
| ExtToolsPane.vue:375 | 暂无扩展（扩展目录随行装载增删） | 保留 |
| ExtToolsPane.vue:376 | 无命中「只看可配置」的插件（N/M 项带参数面）——取消勾选查看全部 | 保留 |
| ExtToolsPane.vue:435 | 声明但未授予：xxx（重启后可能加载失败）（plugin-meta 行内） | 保留（警示） |
| ExtToolsPane.vue:454-455 | 暂无可用工具 / 没有匹配「xxx」的工具 | 保留 |
| ExtToolsPane.vue:534 | 零监听器 | 保留 |
| ExtToolsPane.vue:537 | 暂无 xxx 域事件 | 保留 |

### 2.3 已是 title tooltip（择要）

| 位置 | 原文 |
|---|---|
| ExtToolsPane.vue:366 | 只显示带可配置参数（fields 非空）的插件——快速定位 ⚙ 可配置项 |
| ExtToolsPane.vue:381 | 点击卡片配置（本 Agent 差异层） |
| ExtToolsPane.vue:389 | AgentConfig.settings 键：xxx（装配行 yyy） |
| ExtToolsPane.vue:390 | 带参数面（点击卡片配置差异层） |
| ExtToolsPane.vue:391 | 基础设施行：自动进入每个 run，装载即生效 |
| ExtToolsPane.vue:392 | 本 Agent 已软停用（settings 差异层 enabled=false；行仍装载，监听器跳过） |
| ExtToolsPane.vue:393-394 | 事件落点：xxx / 纯能力供给行（非事件拦截） |
| ExtToolsPane.vue:402-404 | 行为门控：启用中（点击软停用——行仍装载，本 Agent 监听器跳过）/ 行为门控：已软停用（settings 差异层 enabled=false；点击启用 = 写 enabled true 覆盖） |
| ExtToolsPane.vue:469-474 | 已具备此能力标签 / 缺少此能力标签，无法启用（补标签 = Agent tags）/ 已停用（tools.exclude，本 Agent 差异层）/ 已列入本 Agent 清单，但缺少所需能力标签——模型可见，调用会被安全行拦截（补标签 = 基本信息 · 能力标签）/ 默认启用（能力标签门禁通过）/ 已在 tools.include 显式启用 |
| ExtToolsPane.vue:481 | 缺少所需能力标签（调用会被安全行拦截）；关闭 = 写入 tools.exclude / 停用工具（写入 tools.exclude） |
| ExtToolsPane.vue:521-525 | facet:xxx 本 Agent 已停用（子键覆盖回落行为级）/ 本 Agent 已软停用（settings[具名].enabled=false）/ prepend：插队到链首 |
| ExtToolsPane.vue:531 | facet 切面（settings[名][facet].enabled ?? enabled） |
| ExtToolsPane.vue:577 | 本 Agent 状态徽章四态文案（默认启用（能力标签门禁通过）/ tools.include 显式启用 / 已列入清单，但缺少能力标签——调用会被安全行拦截 / 未启用（tools.exclude 或未开启）） |
| pluginBadge（ExtToolsPane.vue:78-101） | 默认授予 / 已显式授予 / 会话级·已装载=会话级装载（重启即失）；卸载在插件库「目录 · 插件 · 本地」组 / 已装载=安装态在 registry.json，boot 扫描装载；卸载在插件库 / 装载即生效=cordis.yml 装配行：进程级启停 = 编辑行组合并重启，UI 不重复表达 |
| EVT_SCOPE_ROOTS（ExtToolsPane.vue:219-221） | run=发生在某 Agent 执行上下文内（本 Agent 可经 settings 软停用）；host=宿主/进程生命周期（本 Agent 不可门控——进程级治理在插件库 · 事件） |

---

## 3. 配置弹窗（双实例共享）`ExtensionSettingsModal.vue`

| 位置 | 区域 | 呈现 | 原文 | 建议 |
|---|---|---|---|---|
| ExtensionSettingsModal.vue:272-281 | 弹窗顶部提示条 | 弹窗 | agent 模式：只存差异项（空 = 继承全局默认）；生效 = settingsOf 合成（全局默认 ∪ 差异层，差异优先）。保存写 agents/update-config。启停不在此弹窗：本页卡片行尾软停用开关。/ global 模式：全局默认，Agent 层覆盖——保存写 config.json → settings.<configNs>（config/changed 热更）。启停不在此弹窗：软停用 = 卡片行尾开关；强制停用 = 插件库「插件目录」页签。 | 机制解释 → 帮助文档；弹窗内精简为一句「空 = 继承全局默认」+ ? tooltip |
| ExtensionSettingsModal.vue:311-312 | 字段恢复按钮 | title-hover | 清除本 Agent 差异键——回归继承（全局默认 ?? 行缺省）/ 清除全局配置键——回归行缺省 | 保留 tooltip |
| ExtensionSettingsModal.vue:312,321,355,377,389,399 | 各输入控件 | placeholder | 未配置（继承缺省）（×4 处）；未配置（继承缺省）——对象/数组，JSON 格式 | 保留（操作语义） |
| ExtensionSettingsModal.vue:341 | 列表添加框 | placeholder | 输入后回车或点添加 | 保留 |
| ExtensionSettingsModal.vue:381 | JSON 校验错误 | 常显 | xxx（保存被阻止——修正或清空） | 保留 |
| ExtensionSettingsModal.vue:405-409 | 无参数说明 | 弹窗 | 此行无声明参数——启停 = 本页卡片行尾软停用开关 / 本行无参数配置——启停入口：软停用 = 卡片行尾开关；强制停用 = 插件库「插件目录」页签 | 精简 + ? tooltip |
| ExtensionSettingsModal.vue:414 | 保存按钮 | 按钮文案 | 保存（agents/update-config）/ 保存（config/set） | API 通道信息 → 帮助文档；按钮回归「保存」 |
| metaText/metaMark（ExtensionSettingsModal.vue:118-136） | 字段元信息行 | 常显 | 生效 xxx · 本 Agent 差异 / 生效 xxx · 全局默认 / 生效 xxx · 行缺省 / 未配置 / 缺省 xxx / 已配置（行未声明缺省）/ 覆盖中 / 已自定义 | 保留（归因是本弹窗核心功能） |

---

## 4. Agent 编辑 `AgentPane.vue`

| 位置 | 区域 | 呈现 | 原文 | 建议 |
|---|---|---|---|---|
| AgentPane.vue:465 | 基本信息·能力标签 | 常显 | 组合式能力声明（工具按 requires 匹配）：点击启用/关闭，可自定义领域标签 | 前半 → 帮助文档；留操作提示 |
| AgentPane.vue:475 | 自定义标签输入框 | placeholder | 自定义领域标签（如 sap / math / qa），回车添加 | 保留 |
| AgentPane.vue:485 | 基本信息·SYSTEM.md | 常显 | 覆盖 builtin.build-system-prompt 装配的系统提示词 | → tooltip 或帮助文档 |
| AgentPane.vue:493 | 基本信息·AGENT.md | 常显 | 定义 Agent 的角色、行为和能力边界 | 保留（一句定义） |
| AgentPane.vue:507 | 模型·模型池 | 常显 | 选择池预设；“默认”则继承全局配置 | 保留（短） |
| AgentPane.vue:524 | 模型·字段继承徽章 | 常显 | 本 Agent / 继承 | 保留 |
| AgentPane.vue:526 | 模型·schema 字段描述 | 常显 | {{ s.f.description }}（来自后端 schema） | 见附录 B（schema 驱动） |
| AgentPane.vue:530 | 模型·恢复继承按钮 | title-hover | 恢复为继承（删除本 Agent 覆盖，回退全局/池） | 保留 tooltip |
| AgentPane.vue:555 | 安全·路径穿透白名单 | 常显 | 允许 Agent 的工具访问工作区之外的路径。可手动输入（支持相对路径）或从本机目录选择；未配置则仅允许工作区内。 | 首句保留；后半 → 帮助文档/tooltip |
| AgentPane.vue:557 | 安全·已配置计数 | 常显 | 已配置 N 个白名单路径 | 保留 |
| AgentPane.vue:450 | 头像 | 常显 | 点击更换 | 保留 |
| PathListEditor.vue:79 | 白名单空态 | 空态 | 未配置——仅允许工作区内路径 | 保留 |
| PathListEditor.vue:89 | 白名单输入框 | placeholder | 输入路径（支持相对路径如 ../shared），回车加入 | 保留 |

---

## 5. 全局定时任务 `SettingsPanel.vue`（sys.timer 叶）

| 位置 | 区域 | 呈现 | 原文 | 建议 |
|---|---|---|---|---|
| SettingsPanel.vue:464 | 页头说明 | 常显 | 每个任务 = 时间点 + 提示内容 + 目标 Agent（空=全部）。提示支持占位符：{{now}} / {{time}} / {{date}} | 后半占位符 → tooltip 或帮助文档 |
| SettingsPanel.vue:518 | 编辑弹窗·任务类型 | 弹窗 | 系统任务为纯机制操作（不走 LLM）；自定义任务为报时提醒 | → tooltip |
| SettingsPanel.vue:528 | 编辑弹窗·提示内容 | 弹窗 | 留空则使用默认报时文本。占位符：{{now}} / {{time}} / {{date}} | 占位符 → 帮助文档 |
| SettingsPanel.vue:535-536 | 编辑弹窗·机制说明 | 弹窗 | {{ specialHint(gTaskType)?.desc }}（动态）；hint 固定为 xxx，仅可调整时间与目标 / 保存后仍可删除或改回自定义 | 保留（系统任务语境） |
| SettingsPanel.vue:541 | 编辑弹窗·目标 Agent | 弹窗 | 每行一个 Agent ID，留空 = 全部 Agent | 保留（格式提示） |
| SettingsPanel.vue:481 | 删除按钮 | title-hover | 内置系统任务不可删除 | 保留 |
| SettingsPanel.vue:499 | 重启后端按钮 | title-hover | 完全重启后端（会中断所有进行中的任务，几秒后自动恢复） | 保留 |

## 6. Agent 定时任务页签 `TimerPane.vue`

| 位置 | 区域 | 原文 | 建议 |
|---|---|---|---|
| TimerPane.vue:70 | 页头说明 | 配置定时自动触发 Agent，结果发送给 target | 保留（短） |
| TimerPane.vue:94 | 空态 | 暂无定时任务，点击右上角“添加”创建 | 保留 |
| TimerPane.vue:119 | 间隔输入框 placeholder | 1h（支持 30s / 5m / 2h30m） | 保留 |
| TimerPane.vue:131 | 重复次数 placeholder | 0 = 永久 | 保留 |
| TimerPane.vue:135 | 提示内容 placeholder | 触发时发送给 Agent 的指令 | 保留 |
| TimerPane.vue:139 | 目标 placeholder | user, coding_agent（逗号分隔，默认 user） | 保留 |

## 7. Agent 列表 `AgentListPane.vue`

| 位置 | 区域 | 原文 | 建议 |
|---|---|---|---|
| AgentListPane.vue:131 | 页头说明 | 管理所有 Agent。点击条目进入配置；虚拟 Agent（如 user）无配置文件，仅作路由端点。 | 后半 → tooltip；留首句 |
| AgentListPane.vue:180 | 新建弹窗·模型 Provider | 可选；留空则继承全局默认模型 | 保留（短） |
| AgentListPane.vue:176 | 新建弹窗·ID placeholder | 留空自动生成（字母/数字/连字符/下划线） | 保留 |
| AgentListPane.vue:138-139 | 空态 | 暂无 Agent，点击“+ 添加 Agent”创建 / 未找到匹配的 Agent | 保留 |

## 8. 暂存插件人审弹窗 `StagingReviewModal.vue`

| 位置 | 区域 | 原文 | 建议 |
|---|---|---|---|
| StagingReviewModal.vue:151 | 授予权限·说明 | fs / network 默认授予；以下权限必须宿主显式勾选后才写入 registry 授予快照。 | 保留（安全确认语境），后半机制 → 帮助文档 |
| StagingReviewModal.vue:155 | ui 权限警示 | UI 代码将在浏览器会话上下文中执行（同源信任） | 保留（危险提示） |
| StagingReviewModal.vue:156 | process/shell 警示 | 高危：可执行任意进程/命令 | 保留 |
| StagingReviewModal.vue:158 | 无需授予空态 | 无需额外授予（仅 fs/network 默认权限） | 保留 |

## 9. 模型/搜索池 `PoolManager.vue`

| 位置 | 区域 | 原文 | 建议 |
|---|---|---|---|
| PoolManager.vue:234 | 编辑弹窗·schema 字段描述 | {{ f.description }}（来自后端 schema） | 见附录 B |
| PoolManager.vue:197 | 空态 | 暂无条目，点击“+ 添加”创建 | 保留 |
| PoolManager.vue:206,212 | 默认星标/设为默认 | title：当前默认 / 设为默认 | 保留 |

---

## 10. 通用组件（聊天/运行跟踪/用量/会话等）

### 10.1 运行矩阵 `RunTracking.vue`

| 位置 | 区域 | 呈现 | 原文 | 建议 |
|---|---|---|---|---|
| RunTracking.vue:411-413 | 头部·范围切换组 | title-hover | 浓度 = xxx 范围内消息量（对数归一化）/ 后端为旧版本，暂无时间窗口数据 —— 当前按总消息量着色；重启后端（pnpm dev）后可按范围筛选 | 保留（口径说明，已是 tooltip） |
| RunTracking.vue:423 | 快照时间 | title-hover | 快照生成于 xxx | 保留 |
| RunTracking.vue:426 | 拉取失败 | 常显（错误态） | 快照拉取失败：xxx | 保留 |
| RunTracking.vue:432 | 矩阵空态 | 空态 | 暂无成员（加载中…） | 保留 |
| RunTracking.vue:485-488 | 图例·活跃度 | 常显 + title | 活跃度（xxx）：N 条（title：xxx 范围内消息量（对数刻度，上限 N 条封顶）：N 条） | 保留图例；口径细节留 title |
| RunTracking.vue:490 | 图例·操作注 | 常显 | 点击格子进入会话（上/下三角均可） | 保留（操作引导，一句） |
| RunTracking.vue:496-502 | 覆盖面分析（折叠） | 折叠展开 | ✅ 已入矩阵：1v1 会话（chat~，自会话/旧 chat~x~self 均归一落对角线）N 个 + 群会话 M 个；轴集合 = Agent 清单 ∪ 群组清单 ∪ system（无主触发）。agent×群格子仅在有参与证据（周归档 / 运行中 / 旧格式会话键）时点亮——并非所有群成员都实际参与过群聊；群消息按人比例归属为后续增量。/ ⚠️ 矩阵之外：独立会话（single~）N 个 —— 它们没有两两端点（用户 ↔ 会话引用的 Agent，上下文按会话隔离），结构上无法落入两两格子；其中 M 个正在运行，请看「运行中会话」。/ 独立会话（single~）：0 个 —— 当前全部会话均已入矩阵。/ ⚠️ 残留端点：xxx —— 出现在会话键但已无对应 Agent/群组（已删除等），以「未知端点」入轴保留数据。 | 已是折叠区（默认收起）可保留；首段机制解释 → 帮助文档「运行矩阵统计口径」词条 |

### 10.2 运行跟踪面板 `RunTrackingPanel.vue`

| 位置 | 区域 | 呈现 | 原文 | 建议 |
|---|---|---|---|---|
| RunTrackingPanel.vue:192 | 「运行总览」矩阵入口 | title-hover | 运行矩阵：会话对 N · 群 M · 矩阵外独立 K（点击打开/关闭） | 保留 |
| RunTrackingPanel.vue:207 | 「运行中」树空态 | 空态 | 没有正在运行的会话 | 保留 |
| RunTrackingPanel.vue:210 | 运行中会话叶节点 | title-hover | 会话标题 + convKey + 点击进入会话 | 保留 |
| RunTrackingPanel.vue:215 | 运行条目·中断按钮 | title-hover | 中断该 run（软中断） | 保留 |
| RunTrackingPanel.vue:229 | 「活跃子Agent」树空态 | 空态 | 无运行中的子 Agent | 保留 |
| RunTrackingPanel.vue:230 | 子 Agent 叶节点 | title-hover | 名称 · 父 parentId + 任务描述 | 保留 |

### 10.3 Token 用量 `TokenUsage.vue`

| 位置 | 区域 | 呈现 | 原文 | 建议 |
|---|---|---|---|---|
| TokenUsage.vue:904 | 左侧栏·统计范围下拉 | title-hover | 筛选统计的时间范围（默认近 30 天） | 保留 |
| TokenUsage.vue:914 | 左侧栏·筛选空态 | 空态 | 范围内暂无记录 | 保留 |
| TokenUsage.vue:946 | 弦图·图例说明 | 常显 | 弦图：外环弧段 = Agent（长度 ∝ 协作流量，颜色区分），弦（色带）连接 1v1 会话，宽度与颜色渐变 ∝ 用量；悬停弧段/弦查看明细。预设模式（标准/极简等）与群聊流量不计入。 | 图例解读 → ? 图标 tooltip 或帮助文档；页面留「悬停查看明细」 |
| TokenUsage.vue:947-950 | 弦图·包含开关 | title-hover | 取消勾选可排除 user↔agent 与自身(self)对话流量；群聊与预设模式流量始终排除（后续单独图谱） | 保留 |
| TokenUsage.vue:956-958 | 弦图空态 | 空态 | 当前范围内没有 Agent 间 1v1 协作流量 / 可勾选「包含 user / self 流量」或调整左侧统计范围 | 保留（引导） |
| TokenUsage.vue:974 | 柱状图·图例说明 | 常显 | 自上而下：缓存 → 未缓存 → 输出（缓存+未缓存=输入）/ 自上而下按模型 ID 排序（其他垫底） | 保留（短口径）或 → tooltip |
| TokenUsage.vue:961,981 | 数据空态 | 空态 | 暂无数据 | 保留 |
| renderCloud/renderChartTip 注入 | 弦图/柱图悬停明细 | 自定义 HTML tooltip | 明细数值（数据驱动） | 保留 |

### 10.4 会话列表 `SessionList.vue`

| 位置 | 区域 | 呈现 | 原文 | 建议 |
|---|---|---|---|---|
| SessionList.vue:284 | 顶部·新增按钮 | title-hover | 新建会话（已有空会话时复用） | 保留 |
| SessionList.vue:294 | 工具栏·新增工作区按钮 | title-hover | 新增工作区（登记一个文件夹白名单区域） | 保留 |
| SessionList.vue:307 | 树根·工作区/未分组节点 | title-hover | 工作区名 + 路径 / 未挂工作区的会话 | 保留 |
| SessionList.vue:329 | 工作区节点·「+」按钮 | title-hover | 在此工作区新建会话 | 保留 |
| SessionList.vue:344 | 会话项·删除按钮 | title-hover | 删除会话（含消息，不可恢复） | 保留 |
| SessionList.vue:351-353 | 列表空态 | 空态 | 暂无会话 / 点击「新增」直接开始；「+」登记文件夹工作区分组管理会话 | 保留（引导），后半工作区概念 → 帮助文档 |
| SessionList.vue:360-361 | 删除确认弹窗 | 弹窗 | 确定要删除 xxx 吗？/ 会话消息将一并删除，不可恢复。 | 保留（危险确认） |
| SessionList.vue:374 | 新增工作区弹窗 | 弹窗 | 登记一个本机文件夹作为会话分组；挂在此工作区的会话，其 Agent 可访问该文件夹（沙箱白名单）。 | 保留（首次概念引入），沙箱机制 → 帮助文档 |
| SessionList.vue:379 | 路径输入框 | placeholder | 点击右侧按钮选择文件夹，或直接输入/粘贴绝对路径 | 保留 |
| SessionList.vue:383 | 系统对话框等待提示 | 常显（picking 时） | 已打开系统文件夹选择对话框，请在弹出的窗口中选择（10 分钟内有效；也可直接手动输入路径）… | 保留（异步操作状态） |
| SessionList.vue:386 | 名称选填标注 | 常显 | （可选，缺省 = 文件夹名） | 保留 |
| SessionList.vue:418 | 删除工作区弹窗·后果说明 | 弹窗 | 会话保留并移入「未分组」；文件夹本身不受影响。 | 保留（后果说明） |

### 10.5 会话视图 `DialogView.vue` / `PairDialogView.vue`

| 位置 | 区域 | 呈现 | 原文 | 建议 |
|---|---|---|---|---|
| DialogView.vue:470 | 头部·Token 仪表盘 | title-hover | N / M tokens · K 条消息 · 约剩余 J 条后需归档 | 保留 |
| DialogView.vue:673 | Token 弹层·归档按钮（弹层底部动作行，原会话头独立按钮迁入） | 常显 + title-hover | 归档对话 / 正在归档整理记忆… / 回复进行中，结束后再归档 / 归档对话：先整理记忆，再归档早期消息 | 保留 |
| DialogView.vue:505-605 | 头部·功能按钮群 | title-hover | 预览 System Prompt / Agent 配置 / 更多操作 / 群聊信息 / 回到底部 | 保留 |
| DialogView.vue:546 | 头部下方·连接状态条 | 常显（断连时） | [WARN] 连接已断开，正在重连... | 保留 |
| DialogView.vue:560 | 历史加载占位 | 常显 | 正在加载历史消息… | 保留 |
| DialogView.vue:566 | 会话空态 | 空态 | 群聊开始 — 发送第一条消息吧 / 开始对话 — 发送第一条消息吧 | 保留 |
| DialogView.vue:573 | 追加加载指示 | 常显 | 加载历史消息中… | 保留 |
| DialogView.vue:637-639 | 删除确认弹窗 | 弹窗 | 删除群聊群组 / 归档独立会话 / 永久删除 Agent。此操作将删除该群组的所有消息记录 / 归档该会话（消息保留，可从数据目录找回）/ 删除该 Agent 的所有配置、会话历史和凭据，归档后不再出现在列表中。/ 不可恢复，不可撤销。 | 保留（危险确认，后果说明必需） |
| DialogView.vue:614 | 群聊输入框 | placeholder | Agent 回复中... / 输入消息发送到群聊... | 保留 |
| DialogView.vue:659 | System Prompt 弹窗 | 加载态 | 正在组装 System Prompt… | 保留 |
| DialogView.vue:720 | 无选中空态 | 空态 | 选择一个群组开始聊天 / 选择一个 Agent 开始对话 | 保留 |
| PairDialogView.vue:143 | 头部·system 端点名 | 常显 | system（系统触发） | 保留 |
| PairDialogView.vue:144 | 头部·副标注 | 常显 | 只读 · 双方视角 | 保留 |
| PairDialogView.vue:159 | 消息区空态 | 空态 | 这两个对象之间暂无会话记录 | 保留 |

### 10.6 输入框 `ChatInput.vue`

| 位置 | 区域 | 呈现 | 原文 | 建议 |
|---|---|---|---|---|
| ChatInput.vue:299 | 输入框 | placeholder | 输入消息… (Enter 发送, Shift+Enter 换行) / 当前 Agent 正在归档整理记忆，稍后处理您的回复…（归档中） | 保留 |
| ChatInput.vue:315 | 工作区选择器 | title-hover | 工作区：xxx + 路径 / 未分组（会话不挂任何工作区） | 保留 |
| ChatInput.vue:324 | 工作区下拉·「未分组」选项 | title-hover | 会话不挂任何工作区 | 保留 |
| ChatInput.vue:348-350 | Agent 选择器（独立会话） | title-hover | 会话已有消息，预设/Agent 已锁定：xxx / Agent：xxx / 默认预设描述或「默认预设（无人物设定，仅基础工具）」 | 保留（锁定规则提示） |
| ChatInput.vue:361 | 预设选项 | title-hover | 无人物设定，仅基础工具预设（默认预设描述兜底） | 保留 |
| ChatInput.vue:390 | 模型选择器 | title-hover | 模型覆盖：xxx / 模型：Agent 原配置 | 保留 |
| ChatInput.vue:411 | 思考强度选择器 | title-hover | 思考强度：xxx / 思考：关闭 | 保留 |
| ChatInput.vue:431,442 | 附件/发送按钮 | title-hover | 附件上传 / 打断并发送 / 发送 | 保留 |

### 10.7 其他组件零散条目

| 位置 | 区域 | 呈现 | 原文 | 建议 |
|---|---|---|---|---|
| AgentList.vue:195 | 列表空态 | 空态 | 无匹配项 / 暂无 Agent / 群组 | 保留 |
| AgentList.vue:197 | 新增 Agent 弹窗 | 常显 | Agent ID（可选，留空自动生成）/ 将使用全局默认模型配置（default-hint） | 保留 |
| AgentList.vue:197 | 新增弹窗 placeholder | placeholder | 如 my_agent，留空则自动生成 UUID / 如 我的助手 | 保留 |
| CreateGroupDialog.vue:89-90 | 群组 ID | 常显 + placeholder | （可选，留空自动生成）/ 如：general，留空则自动生成 UUID | 保留 |
| VersionDialog.vue:98,102 | 版本弹窗·状态条 | 常显 | 新版本可用！建议更新以获得最新功能和修复。/ 已是最新版本。 | 保留 |
| Sidebar.vue:188 | 「更多」菜单·备份状态 | 常显（备份时） | 正在备份… / ✅ 备份完成：xxx（N MB，保留 M 份） | 保留（数据驱动状态） |
| UserMessage.vue:89 | 消息编辑态 | 常显（编辑时） | Enter 确认 · Esc 取消 | 保留 |
| UserMessage.vue:119 | 继续生成按钮 | title-hover | 继续生成：让 Agent 基于当前对话继续推理 | 保留 |
| ToolMessage.vue:111 | 写文件工具标签 | title-hover | 点击查看文件内容 | 保留 |
| ToolResultTerminal.vue:34,69,81,84 | 终端结果横幅 | 常显 + title | cwd 路径（title）/ 含 stderr / 输出已截断；命令超时 / (无输出) | 保留 |
| ToolResultCode.vue:247 | 代码卡·截断提示 | 常显 | 内容已截断，仅显示前 xxx（原始 yyy） | 保留 |
| chat/ToolResult/*、chat/Message/* 其余 | 各工具卡/消息卡 | 加载态/空态 | 正在执行…/正在读取.../仍在运行中…/暂无活跃子 Agent/无网页内容/（无变更）/（无输出内容）等 | 保留（短状态句，非改造对象） |
| InteractionBar.vue / ToolResultBrowser.vue | — | — | 无符合标准的描述性文本 | — |

### 10.8 通用组件统计

26 个通用组件文件共收集约 127 条用户可见文本，按呈现方式分布：

| 呈现方式 | 约计 | 说明 |
|---|---|---|
| 页面可见文本（空态/图例/加载态/状态提示） | 60 | 绝大多数为短状态句，属「保留」；长文案集中在 RunTracking 覆盖面分析、TokenUsage 弦图图例、SessionList/DialogView 弹窗说明 |
| placeholder | 5 | 均为操作说明，保留 |
| title tooltip | 45 | 密度最高：ChatInput（工作区/Agent/模型/思考强度四组选择器口径）、RunTracking（浓度口径/图例区间/快照时间） |
| 自定义 HTML 悬停 tooltip | 15 | TokenUsage 弦图/柱状图与 RunTracking 矩阵格子的明细注入（数据驱动） |

---

## 附录 A：改造优先级建议

1. **首选移帮助文档**（最长、最"机制"的段落）：PluginLibraryPane 事件页脚注（治理键）、市场页脚注（安装流）、插件目录页脚注（启停两层）、RunTracking 覆盖面分析首段（统计口径）。这些是页面噪音主体，且用户指南 §10/§13 已有对应章节可扩充。
2. **区块标题统一瘦身为「名称（计数）」**：`——` 后的解释全部转 zone-title 的 title 或 ? 图标 tooltip（插件目录/插件配置/工具/事件/内置/本地/动态装载共 8 处）。
3. **配置弹窗 esm-note 精简**：保留一行「空 = 继承全局默认 / 全局默认，Agent 可覆盖」，通道与热更细节 → 帮助文档；保存按钮去掉 API 名后缀。
4. **图例说明瘦身**：TokenUsage 弦图图例（946 行整段）→ ? 图标 tooltip + 帮助文档；柱状图口径句保留或转 tooltip。
5. **空态与错误恢复文案保留**，仅措辞精简；发现机制/目录布局类长解释（市场空态、开发目录布局）→ 帮助文档。
6. **危险确认弹窗文案全部保留**（删除会话/Agent、治理停用、市场安装、暂存人审）——后果说明属于必要警示，不属"页面噪音"。
7. **已是 title 的长 tooltip**（1.4/2.3 节，约 45 条）可作为帮助文档「插件库字段词汇表」的素材源；后续可统一换用 `ui/Tooltip.vue` 组件获得样式与换行控制（ChatInput/RunTracking 的口径类 tooltip 同理）。

## 附录 B：schema 驱动的字段描述（不在硬编码改造范围）

以下描述来自后端 `/api/*-schemas` 返回的 schema（`settings/schema.ts` 归一化为 FieldMeta），前端仅渲染：

- `NsFieldList.vue:77`（ns-desc）、`AgentPane.vue:526`（info-desc）、`PoolManager.vue:234`（pool-field-desc）、`ExtensionSettingsModal.vue`（esm-field-desc / entry.description）、工具参数表 tp-desc（PluginLibraryPane.vue:1027 / ExtToolsPane.vue:592）。

若这些也要 tooltip 化，应改 schema 消费端渲染方式（一处改全局生效），不动各页面。

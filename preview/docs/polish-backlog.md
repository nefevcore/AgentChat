# 细节优化清单（polish backlog）

> 状态：📋 待实施。来源：2026-08-30 会话末用户反馈 7 条（§一）+ 未决事项合并（§二 UI/交互打磨候选、§三 架构演进项）。供打磨阶段逐项领走；完成一项勾一项并在提交信息引用条目号。
>
> 基线：32726bc（801 测试全绿）。涉及前端的条目完成后需 `pnpm preview:webui:build`；涉及后端的需重启实例。

## 一、用户反馈（优先）

### P1. 插件目录：可配置项过滤勾选
- **现象**：想快速找到有配置项的插件，需逐张卡片找 ⚙ 徽章。
- **修法**：插件视图工具行加一个 checkbox「只看可配置」——过滤 `builtinWithExt` 中 `ext` 命中且 `configNs` 在场的条目（复用 `extOf`）；过滤态在 zone 标题显示计数。
- **涉及**：`webui/src/settings/components/PluginLibraryPane.vue`。

### P2. 全局设置：「会话回放」移出，收口为插件可配置项
- **现象**：全局设置导航的 `sys.session`（会话回放，M21/D14 的 `session.replayTrajectory` 布尔开关）本质是 ac-session 的行为参数，在全局设置里属于冗余展示位。
- **根因**：M21 时代落在全局 config 域（`config.session.replayTrajectory`），早于 M24 X1/A1 的 `settings[具名]` 词汇收口。
- **修法**：
  1. `EXTENSION_CATALOG` 的 `session` 条目（automatic，现无 configNs/fields）补 `configNs: 'session'` + `fields: [{ name: 'replayTrajectory', description: '轨迹回放…' }]`；
  2. 后端消费点改读 `settingsOf` 合成（全局默认层 ∪ Agent 差异层）——注意向后兼容：存量 `config.session.replayTrajectory` 值迁移或双读过渡；
  3. 前端移除 SettingsPanel 的 `sys.session` 导航叶与会话回放面板块。
- **涉及**：`ac-web-api/src/index.ts`（EXTENSION_CATALOG）、`ac-session`（消费点）、`webui/src/settings/components/SettingsPanel.vue`、可能 `ac-config` 白名单（CONFIG_KEY_PREFIXES）。

### P3. 工具清单卡片：id 重复显示
- **现象**：卡片标题行显示两遍工具 id。
- **根因**：`plugin-name` 渲染 `t.label || t.name`，旁边 `plugin-version` 又渲染 `t.name`——工具大多无 label，name 出现两次。
- **修法**：仅当 `t.label && t.label !== t.name` 时显示第二格 id 徽章；否则只显示一格。
- **涉及**：`PluginLibraryPane.vue` 工具视图卡片。

### P4. 工具详情弹窗：文字颜色过灰
- **现象**：详情内容（参数表说明列等）对比度不足。
- **修法**：`.tp-desc`/`.tp-type`/`.tp-default` 由 `--text-3` 升 `--text-2`；表头保持 `--text-3` 但字重已足够。整体过一遍弹窗内 `--text-3` 用量，正文性文字一律 `--text-2` 起。
- **涉及**：`PluginLibraryPane.vue` 样式节。

### P5. 事件清单：叶节点归属显示「Loader」
- **现象**：监听器叶节点 owner/行名显示成 Loader，而非所属插件 id。
- **根因**：`ac-event-policy/src/aggregate.ts` 的 `rowOfFiber` loader 路径——`topLevel` 集合取自 `loader.root.store`（**根组直接 entry**），但官方 boot 下全部 yml 行嵌在 include 子树内，根组只有 include 载体一行 → 行 fiber 沿祖先链命中的顶层 entry 恒为 include/Loader 侧，聚合失效（`aggregate.test` 大概率只覆盖了程序化路径）。
- **修法**：top-level 判定改为「include 子树内的直接 entry 集」（或等价地：沿祖先链取**最近的带 `options.name` 的 entry**）；补官方 loader-boot 路径的聚合测试（bootTest 真实 yml，断言 ws-bridge/security 等监听器 row = 对应 `ac-*` 包名）。
- **涉及**：`ac-event-policy/src/aggregate.ts`、`ac-event-policy/tests/aggregate.test.ts`。

### P6. 事件清单：治理入口去重 +「治理」改名
- **现象**：事件节点的「治理」按钮与叶节点的「×」按钮都调用 `openGov(owner, event)`——同一功能两处入口；且事件节点按钮取 `listeners[0].owner`，多监听器时语义含混；「治理」一词不自明。
- **修法**：留叶节点入口（粒度正确、上下文清晰），移除事件节点按钮；「×」改为明确的「停用」小按钮（icon + tooltip「停用该监听器（重启生效）」）；`openGov` 确认弹窗标题同步用「停用 …」。若需要事件级批量停用，后续再加（显式「停用全部监听」文案），首期不做。
- **涉及**：`PluginLibraryPane.vue` 事件树模板 + 治理确认弹窗文案。

### P7. 设置弹窗左侧导航：menu-item 风格不统一
- **现象**：`.sp-navitem` 字体颜色偏浅，与插件库左导航（`.pl-navitem`）、其他菜单项视觉不一致。
- **修法**：对齐 `.pl-navitem` 的规格——默认 `--text-2`、hover `--bg-hover`、active 态 `--text-1` + 字重 500 + 边框/底色强调；顺带核对全局 menu 类组件（AgentListPane/PoolManager 侧栏等）统一令牌用量，必要时抽公共样式。
- **涉及**：`SettingsPanel.vue` 样式节（可顺带全局面板走查）。

## 二、UI/交互打磨候选

- **C1. 今日 UI 全量浏览器走查**：插件卡片（红绿 toggle/⚙ 徽章/点击弹窗/滚动收口）、工具参数表格、事件树、配置弹窗分区（字段描述/enabled 分区）、还原按钮组——全部经事故链阻隔未经目验，是 §一 的前置。
- **C2. 事件树手感**：默认收拢是否合适、展开状态记忆（localStorage）、scope 根计数徽章信息量。
- **C3. PluginLibraryPane 孤儿 CSS 清理**：重写后遗留（`.pl-event-row` 旧执行链样式族等）。
- **C4. `PluginMeta.fields` 疑似遗留字段**（`webui/src/settings/types.ts`）——查证消费方后清理。
- **C5. 市场零结果引导**：`keywords:agentchat-plugin` 生态为空，空态文案可教人怎么发布/自标。
- **C6. EXTENSION_CATALOG 覆盖面**：11 条 vs 实际行集——event-policy/market 等新行无目录条目 → 无「⚙ 可配置」徽章（与 P1 联动：过滤后更明显）。
- **C7. ws-bridge 30 条监听器描述为同款模板文案**——可接受，可选打磨（按事件名差异化前半句）。

## 三、架构演进项（后续里程碑，非本轮打磨）

- **A1. M22 P3 注册制目录**：EXTENSION_CATALOG 仍为静态表（今日还深化了字段级描述）；行 apply 时自注册元数据消灭静态表——`ctx.on` description 机制（监听器自述）已是同款先例，模式可循。
- **A2. `agentchat.contracts: "^1"`**：声明位已留，等市场/版本门工作启用（勿提前加投机字段）。
- **A3. npm 发布行包 + 市场打通**：`keywords: "agentchat"` / `agentchat.plugin: true` 已就位；发布与 `market/search` 消费是下一步。
- **A4. 生产 bundle 目录演进**：生产形态内置组为空（既定缩水），由 market + 声明判据接管。
- **A5. dep-graph 软依赖盲区**：`ctx.get` 依赖不在图内（已文档化；补齐需静态分析，代价高收益低）。
- **A6. ac-web-api 静态 inject 瘦身**（17 项）：级联易碎的根源；已有急救行缓解，「RPC 面这么容易挂」本身可改——非核心 inject 改 `ctx.get` 软依赖（RPC 失败容忍）或拆面。改动面大，需单独立项。

## 四、边界备忘（勿顺手恢复）

- M24/M25 缩水红线：监听器优先度/重排、**单监听器粒度治理**、capabilities 减法、签名形态统一、治理面按 Agent 细分（归 agentGate facet）。
- 停用 ac-web-server = UI 无法自救（传输本体），手工编辑 cordis.patch.yml 是设计兜底。
- `workspace/default` 是 src 旧轨数据，preview 迁移脚本不得触碰。

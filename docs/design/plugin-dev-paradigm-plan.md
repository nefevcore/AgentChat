# 插件开发范式重设计方案（plugin-dev-paradigm）

> **已被 cr-900（2026-11-05）`plugin-architecture-v2.md` 取代**——批 1/3/5
> 的语义（重载、watch、脚手架）内建于 v2（§3.2 link 形态 + §3.5 三命令），
> 批 2/4 由 v2 治理层（§3.4）重新承载。本档降为历史裁决。

> cr-899（2026-11-05）发起。姊妹档：`plugin-face-unification-plan.md`（cr-898）
> 管**装载面**——安装态单一路径与单一事实源；本档管**开发面**——插件作者
> （出厂行开发者 + Agent 自开发双人群）写作与迭代的范式。参照系：DeepSeek
> Harness（DSH）的扩展模型——本仓已部分吸收（ac-skill-core 的 SKILL.md 约定
> 连 `.dsh/skills` 目录都兼容扫描），但**开发范式**层面尚未对齐。

## 一、问题陈述（开发视角四实证）

### 1.1 迭代回路是最重摩擦，且自带认知陷阱

现状「改一行代码」的完整回路（`ac-shell-rows/src/plugin-dev.ts` 实证）：

```
改代码 → unregister_plugin → register_plugin → run_code 子调用测试
→ （定型）bump version → install_plugin → 新壳 boot 才进直调面
```

- **幂等陷阱**：`register_plugin` 同名已装载时幂等返回、**不重载新代码**
  （loadSession L97-99 注释明示「迭代语义 = 先 unregister 再 register」）。
  作者改完代码直接再 register → 拿到成功回执 → 测的还是旧代码。
  这是「成功回执掩盖无效操作」的结构性陷阱，不是文档能救的。
- **两步仪式**：即使知道正确姿势，每次迭代也要 unregister → register 两跳。
- **版本仪式错位**：试跑态（重启即失、无安装态写入）的回执也提示
  「记得 bump version」——version 纪律只属于 install 定格态，dev 态被
  无关仪式打扰。
- **直调面断层**：install 后新行需新壳 boot（restart.ts 工具描述实证）；
  程序化模式经 run_code 即刻可测，直调面不行——两套时效并存但无提示。

### 1.2 表达梯度断层：config 与 code 之间没有叙事

- config 档（llmProviders 零代码）与 data 档（技能包 cr-879、webui 主题包
  cr-693）都已存在，但互相不成叙事；「插件单元」只承认 code 行。
- DSH 的经验反着来：**绝大多数扩展需求是知识与流程，不是代码**——DSH
  生态里扩展的主形态是 skill（markdown 目录），代码扩展是终档例外。
- Agent 自开发模板只有 tool/provider/event 三种 code 骨架，没有
  「这件事其实不用写代码」的归位引导（技能 / 提示词 / 主题 / config）。

### 1.3 护栏靠自律：四条规约零机械强制

模板 README 明示「机械护栏只有保留字」；以下全是自律规约，违反零拦截：

- 「不 provide 新服务」——装载后无检查；
- 「不 emit loop/*」——越权只致 usage 双记账，装载照常；
- 「不注册他人 Agent」——provides.agents 对账存在但靠声明；
- 「description 禁指令式措辞」——提示注入防线靠模板注释提醒。

events 对账现况：warn 不阻断（manifest.ts 注释实证）——声明漂移
（写了 provides.events 但订阅别的事件）在试跑与安装两态都静默。

### 1.4 脚手架原始、知识双源

- 模板 `PLACEHOLDER-AGENTID` 手工全局替换——生成物带不定时炸弹
  （漏替换一处 = 运行期才暴露）。
- 模板规约注释（index.ts 头部 21 行）与 plugin-dev skill 各存一份，
  漂移无检测。

## 二、DSH 参照系（可借鉴的四机制）

| DSH 机制 | 实质 | AgentChat 对应缺口 |
|---|---|---|
| skill = 目录 + SKILL.md | 零构建、零版本仪式、**编辑即生效**（下轮重读） | 迭代要两步仪式 + 版本提醒 |
| available_skills 摘要 + 按需 load | 渐进披露：常驻成本只有 200 字符摘要 | 插件目录无同款分层（全量或没有） |
| client plugin HMR | dev watcher 常驻，改动免刷新生效 | 无任何 watch 消费面（RPC 参数在、无人用） |
| 沙箱拒绝 fail-loud | 边界违反 = 可诊断的策略错误，非道德规约 | 四条自律规约零机械强制 |

## 三、范式主张

一句话：**插件开发的默认档是数据、代码是终档；迭代回路的成本与「改一行」
成正比；护栏是机械的不是道德的。**

三支柱：

1. **迭代即时化**——试跑态改代码即得新代码（重载语义 + 可选 watch），
   版本仪式只属于 install 定格态（既有裁决「安装即定格」不动）。
2. **表达梯度成叙事**——config → data → code 三档，需求归位到最低够用
   档；数据档产物（技能 / 主题 / 提示词）纳入插件单元统一注册表
   （与装载面统一批 B 的 facets 合流）。
3. **自律机械化**——四条规约逐条落成装载边界 / 对账红灯 / 事件策略，
   与 webui 侧行 seats 双向对账（cr-690）同一设计语言。

## 四、方案分批

### 批 1——register 默认重载（P0，断 1.1 幂等陷阱根）

- `loadSession` 同名已装载时改为 **unload → load 原子重载**（先 dispose
  旧 fiber 再动态 import；入口 URL 的 `?t=` 时间戳已天然绕模块缓存）。
  内容一致与否不做比对——dev 态重载本身即目的，比对是多余仪式。
- 三工具 description、回执 note、模板 README 同步改写：迭代 = 改代码 →
  register_plugin 一步。
- 试跑态回执不再提示 bump version（该提示只留 install 语境）。
- 竞态处置：in-flight execute 期间重载沿用 cordis fiber dispose 语义
  （dispose 等待收割），不自造取消协议。

### 批 2——护栏机械化三件（P0，断 1.3 根；「fail-loud 不是说明」同装载面档 §四）

1. **events 对账升级**：装载后比对实际订阅 ∪ provides.events——漂移 =
   试跑态 warn（容错迭代）+ install 态红灯（拒绝定格）。
2. **define 拒绝**：装载边界拒绝插件行 define 新 ctx 服务（与 permissions
   超授拒绝同层——「不 provide 新服务」从自律升装载检查）。
3. **loop/\* 停用**：动态插件行装载期按 owner 注入事件策略停用
   `loop/*`（复用 ac-event-policy 进程级停用机制，注册期吞掉）。

description 措辞 linter（词表匹配指令式措辞）随本批做 warn 面，install
红灯视词表误报率再定（开放问题 3）。

### 批 3——试跑态 watch（P1）

- `register_plugin` 增 `watch?: boolean`：装载后 fs.watch 插件目录，
  变更 → 批 1 重载语义自动执行 → 回执事件投递本会话（「已重载 v…，
  可继续测试」）。
- 先例：webui 会话装载已用 `plugin/load` RPC 的 `watch: true` 参数
  （ac-client-ui-plugin-registry/client/pluginApi.ts 实证）——本批把
  同款时效带给 Agent 自开发回路；DSH client plugin HMR 同源。
- 防抖 + dispose 收割（watcher 随 sessionLoad fiber 回收——注册即归属）。

### 批 4——表达梯度成叙事（P1，与装载面批 B 合流）

- manifest facets 增 **data 面**：纯数据插件（技能包 / 主题包 / 提示词
  集）以插件单元登记 plugin-rows.json（`source: data`，免审——与装载面
  开放问题 3 的「纯 web 免审」同判定：不进进程无授权面）。
- 模板 README 首节增「需求归位表」：config（provider 连接）/ data（技能、
  主题、提示词）/ code（tool / provider 协议 / event）——三档各给一行
  何时够用的判据。模板族可增 `data-row` 骨架（SKILL.md + manifest）。

### 批 5——脚手架与知识单源（P2）

- `new_plugin` 生成器工具（或 install/register 的 `--scaffold` 面）：
  按 owner id 自动填充命名与 owner tag，消灭 PLACEHOLDER。
- 模板规约注释与 plugin-dev skill 单源锁定：规约正文住 skill，模板头部
  只留指路句 + 漂移检测测试（快照双向锁定，cr-690 对账同思想）。

### 测试面

- 批 1：同名重载 e2e（改文件内容 → register → 新行为可见）；in-flight
  execute 竞态回归；幂等陷阱旧语义删除的快照更新。
- 批 2：events 漂移双态（试跑 warn / install 红灯）；define 拒绝；
  loop/* 注册期吞掉。
- 批 3：watch 触发重载 + 防抖 + dispose 收割。
- 批 4：data 面登记免审路径；归位表与模板族快照。
- 批 5：生成器输出零 PLACEHOLDER；规约单源锁定测试。

## 五、备选与拒绝理由

- **install 态也开 watch（全量热重载）**：与「安装即定格、第三方件无
  升级链」既有裁决正面冲突；定格态的确定性是授权语义的地基。拒绝——
  时效只给试跑态。
- **仅靠 plugin-dev skill 文档教育（文档补课）**：1.1 幂等陷阱与 1.3
  自律规约都是「需要 fail-loud 的问题，不是需要说明的问题」（装载面档
  §四同判语）。拒绝单独成立，skill 文档随批 1/2 同步改写。
- **把数据档并进 cordis 行深合并（koishi 式）**：装载面档已拒——统一
  注册表 + 显式 facets 比深合并诚实；数据面同理只登记不装载。
- **register 重载前内容比对（一致则跳过）**：为省一次重载引入内容指纹
  依赖与「改了没生效」的新怀疑面——比对本身就是仪式。拒绝。

## 六、开放问题

1. 重载时 in-flight 工具调用的收据口径（dispose 等待 vs 立即失败）——
   cordis fiber dispose 语义是否足够，落地批 1 时以实测定。
2. watch 回执通道复用 install 回执的邮局路径还是壳内直投——cr-543
   plugin/load-failure 遗留回报通道（装载面开放问题 2）建议一并收口，
   三者同一条「宿主↔壳插件事件」链路。
3. description 措辞词表的误报率与 install 红灯门槛——先跑 warn 面收
   数据再定阻断。
4. data 面插件与 files/<agentId>/skills/ 物化面（cr-879）的关系：技能
   已有专属物化路径，data 面插件是否只是注册表登记层（不另建装载）——
   倾向「登记归登记、物化归既有」，落地批 4 前出对比小节。

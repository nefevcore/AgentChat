# M23 设计稿：Agent 自开发插件能力（开发 → 测试 → 发布 → 免审安装闭环）

> 状态：**✅ 已实施（2026-08-29：P1a/P1b/P2/P5/P6/P3-lite/P4 落地；P7 热通道
> 后置不阻塞闭环——首期 yml 行停用恒"重启生效"）。落地索引见
> `preview/README.md` 路线图 M23 条与 `docs/src-to-preview-map.md` §6。**
> 版本史（裁决记录见 §四；正文为各轮裁决的**收敛终态**，行内（Ax/Ex/Fx/Gx/Hx）
> 仅作追溯锚点、不叙述修订过程）：
>
> | 版本 | 轮次 | 裁决系 |
> |---|---|---|
> | v1 | 方案探讨五轮 | A-D 系 |
> | v2 | 代码核查 | E 系 |
> | v3 | 实施前第三方审查（`docs/m23-review-findings.md`，H/M/L 编号出处） | F 系 |
> | v4 | 第二轮全面审核（42 条机制断言逐条对照代码） | G 系 |
> | v5 | 外部评审（闭环用户/价值链/复杂度预算/语义攻击面） | H 系 |
> | v6 | 精简规范化（零新裁决，只收敛表述） | — |
>
> 姊妹线：方案1 的 UI 批次（全局默认层等）归 **M24**，不阻塞本文。
> 核心立场：**装载即供给，选用在数据面**——per-Agent 生效永远不经装载层
> （不碰 cordis isolate/作用域）；免审流程的安全不靠人而靠无人值守补偿控制。

---

## 一、目标流程与能力全景

### 1.1 Agent 自开发闭环（五步）

```
① 开发   files/<agentId>/ 下写插件（路径类工具硬沙箱；bash/preset 例外见 §3.4）
② 测试   register_plugin(dir)——已有：interrupt 上报 + after-run 宿主半边，
         sessionOnly 装载（重启即失；requires admin）；不开 watcher（热重载
         仅 plugin/load RPC watch:true）；一轮 run 只收束于首个 toolInterrupt
         （一轮一件，工具描述写明）。grants 参数去除、与 ④ 的分工写进两侧
         工具描述（临时试跑 ② / 定型驻留 ④）、卸载侧词汇对齐 uninstall（G6）
③ 发布   git push / npm publish——已有：bash 工具 + 网络权限即可
④ 安装   install_plugin(dir)——新增：一律免审（stage → 自动 approve → 立即
         装载；安装态 = registry.json）。不暴露 grants 参数——机制上只能并集
         追加、缺省又是 manifest 全集，是语义陷阱（F14/L5）；与 ② 不合并
         （G6：参数化 permanent 是更重的陷阱——以为在测试实则永久驻留）。
         免审 = 无人审 ≠ 无门槛：requires admin，闭环仅对被授予 admin 能力的
         Agent 开放（B2 范围实质 = admin Agent 自开发自安装）。回执落账后
         sender:'event' 回触 owner 自会话，闭环无人值守（H1）
⑤ 回滚   plugin/uninstall——已有：装载回收 + 目录 .backup + UI 装载徽章
         （M22 三态 + G9 熔断第四态）。回滚 = 代码回滚（运行时副作用不随之
         回滚）；uninstall 回执列出消费方——已共享给 N 个 agent（H4）
```

全程不修改 cordis.yml、不重启（安装态由 boot 扫描 loadInstalled 在重启后自动恢复）。

### 1.2 插件贡献面清单（六面）

| 贡献面 | 注册调用 | per-Agent 归属机制 | 适配度 |
|---|---|---|---|
| 工具 | `ctx.tools.register` | `requires: ['agent:<id>']` owner tag（B4 默认私有） | ✅ 机制完备（重名抛错不对称的受害者是出厂行——保留字护栏覆盖，G1） |
| provider 薄行 | `ctx.llm.register(name, factory)` | 配置面选用（`AgentConfig.provider/model`），装载层零参与 | ✅ 最干净：懒实例化/重名抛错 |
| 事件监听 | `ctx.on(...)` | ADR-4 推论：自查 `request.agent`（agentFilter helper） | ⚠ 规约约束 |
| 预设 Agent | `ctx.agents.register(config)` | 无（全局数据）——规约：不自授 tags、不注册他人（E5） | ⚠ 规约约束 |
| UI 扩展 | `manifest.ui` → `webui.addEntry` | 免审缺省全授下 ui 自动到手，但缺省 isolated 挂载（F7） | ⚠ 规约约束 |
| 新服务 | `ctx.provide(...)` | 无——撞名 fail-closed 机械墙 | ❌ 不开放 |

skills 是目录扫描、mcp 是行 config，均非注册面；开放化是框架演进项，不在本期。

### 1.3 装载态从三层变四层

```
cordis.yml            出厂态（git 管理，永不运行时写入）
    ↓ boot 读一次
cordis.patch.yml      本机行偏好层（新增，A2）：数据根声明式 patch，
    ↓                  第一期只用 {id, disabled: true}
registry.json         安装态（动态插件；boot 扫描恢复）
    ↓
hooks[具名]           per-Agent 启用表达
```

---

## 二、设计原则

1. **装载即供给，选用在数据面**：工具归属 = owner tag；provider 归属 =
   AgentConfig 选用；事件归属 = 自查规约。装载层（cordis 作用域）零参与。
2. **免审 = 用无人值守补偿控制替代人**：Agent 本有 bash+node = 任意代码执行，
   免审只新增**常驻/全局/自启**三属性（进程内）+ **浏览器侧常驻**第四面
   （manifest.ui；F7 缺省 isolated 对冲）；对冲 = 审计、熔断、安全模式、
   代码回滚（§3.6），全部无人工。
3. **不碰 vendor**：可视化与优先度都有框架层出口（`internal/dispatch`、
   `_hooks` 读出、`internal/listener` bail、`prepend`），不 fork vendored cordis。
4. **底座暂不分级（C1）**：机械墙兜底——运行时 provide 撞名 fail-closed、
   硬卸底座级联 PENDING、事件消费方静默哑掉；Agent 可经 git 流编写底座，
   运行时替换自然撞墙并拿到可诊断错误。

---

## 三、目标设计

### 3.1 install_plugin 工具（免审安装）

**形态**：与 register_plugin 同款——工具体只上报意图（ToolResult.interrupt，
`requires: ['admin']`），`loop/after-run` 宿主半边执行（避免装载递归），结果
回传调用方会话。一轮 run 只收束于首个 toolInterrupt（一轮只能装一件，工具
描述写明，L7）。

- **回执（F14/L6、G6）**：after-run 半边经 `session.append`（owning 落盘口）
  追加 M21 中性格式（`role:'agent'` + `agent_id`）；寻址用回调自带的
  `request`（`conversationId` 已是组键），无需扩 interrupt 载荷。
  **register_plugin 同步补回执**——现状只记日志，Agent 拿不到装载成败
  （M22 B11 断点）。
- **回触（H1，闭环自驱动）**：只有回执没有推动者，"改→装→试"每循环 ≥2
  个 run 且 run 间无任何东西推动 agent 继续，闭环实为"人类陪走五步"。
  回执落账后经 `sender:'event'` 信封回触 owner 自会话（M19 D2 自会话桶；
  M20 归档 run 同款形态——"机制触发 Agent 干活"的统一出口）——install
  成功 → 回执入账 → 事件触发下一轮 → agent 直接开始测试。触发面限
  owner 自会话，不跨 agent。
- **参数**：
  - `dir`：插件目录（须含 manifest.json）。缺省约定在调用方沙箱
    `files/<agentId>/` 之下——现状 stage/load 对 sourceDir 无任何限制，
    不约束则 owner 标注可失真。显式 dir 落在数据根之外 → 回执附可见警告
    + 审计流水记原始 sourceDir（免审范围是政策不是机制：数据根外目录 =
    事实上的第三方来源，F14/L10）。
  - **不暴露 grants（F14/L5）**：免审快照 = manifest.permissions 全集。
    免审 ≠ 绕过 gates：`plugin/before-load` 的权限/契约否决权照常生效
    （契约不兼容装不上——宿主策略行保留否决面，特性）。

**服务侧复合口**：ac-plugin-registry 增 `installFromDir(sourceDir, owner,
grants?)`（grants 形参留给 market/人审流复用，免审工具面传 manifest 全集；
owner = 执行身份 call.agentId）。工程语义：

- **三态结果（E6、F6）**：`installed+loaded` / `installed+failed`（装载失败
  不影响安装，failed[] 可见、熔断接管；**失败立即计入熔断计数**——与
  loadInstalled 同源，不等重启周期）/ `rejected`（安装未成、暂存已清）。
  不用 uninstall 补偿（会把新装版本挪进 .backup）；`installed+failed`
  回执附 `backupDir`（升级失败可手工回旧版）。
- **approveStaging 可补偿分步（F6/M2）**：现状顺序"旧目录→.backup →
  staged→target → writeRegistry → 删 staging 记录"全程无 try/catch，
  writeRegistry 抛错 = 新代码就位未注册 + 旧版已进 .backup + staging 残留
  （rejectStaging 补偿只覆盖 rename 之前的形态）。重构为先写 registry
  条目（pending 标记）再动目录，或每步补偿全覆盖；**回归测试含人审
  approve 流**（共用底层，G11）。
- **同 hash 幂等（F14/L4 必做、G8）**：同 name+version 重装且 hash 一致 →
  幂等返回已装状态与上次装载结果，**不触发装载重试**（与 F4 熔断强制清零
  组合，崩溃型插件 × Agent 重试循环 = 无限装载，进程级崩溃熔断本就无效）；
  重试装载的正路 = bump version 重装。hash 不一致 → 抛错且文案教 Agent
  "下一步 bump version"。
- **原子写与串行化（F5、G10）**：registry.json tmp+rename 原子写（现状裸
  writeFileSync）+ Windows rename retry（EBUSY/EACCES/EPERM 上限 10 次
  退避，复用 include vendor 语义）；per-name 串行化（stage id = name+毫秒，
  防同名并发碰撞）；**全 registry mutation 入口 + patch 文件写共用一个全局
  串行队列**（现状 mutation 全同步、单进程无 RMW 丢更新；串行化防 F6 落地
  后跨 await 写 + 多进程共享数据根）；.backup 目录名加随机后缀（同毫秒
  碰撞）；copyPluginDir 与 hashPluginDir 排除集统一（现状只排顶层
  node_modules 的复制与排任意层的哈希不一致——深层依赖被复制却不入 hash，
  F3 复验盲区 + 未审查依赖进供应链面）。
- **保留字护栏（F13、G1）**：`ctx.tools/llm/agents` 注册重名抛错方向不对称
  ——动态插件先抢注内置名（如 provider 名 `openai`）会让**出厂行** apply
  抛错 → fiber FAILED，内置注册全体消失。对 **tools / llmProviders /
  agents 三注册面**的内置名冲突给可诊断拒绝；保留字源 = 装载管道维护的
  **各域内置名常量表**（内置名硬编码在行源码、yml 元数据不含、装载时比对
  注册面又有时序竞争——只能常量表 + 出厂行增改同步 + 一致性测试锁定）；
  `<agentId>-<name>` 命名规约是软层，机械拒绝才是硬的。

**免审范围（B2）**：自动 approve，人工不参与；范围 = admin Agent 自开发
自安装（admin 授予 = tags + hooks['security'].capabilities 双轨写，§3.2）；
第三方来源（market/git/npm 拉他人作品）是供应链问题，归 market 立项另裁。

**审计（F2/H3、G7）**：流水文件 = `<root>/plugins/audit.jsonl`，事件含
**install / uninstall / reject / load**（owner/原始 sourceDir/hash/授予快照/
时间；uninstall 删 registry 条目后卸载史不可追、回滚取证断链——必须同入
流水）；路径即定即入 denyPaths 黑名单（§3.4），registry/audit 两项注入随
P1a 先行（G11，不等 P3——窗口期内连路径类工具都能擦审计）；无轮转首期
接受（M24 候选）。

### 3.2 owner-tag per-Agent 归属（B4：默认私有，他人显式共享）

- **插件侧**：开发模板 helper `agentTool(def)` 自动注入
  `requires: ['agent:<agentId>']`；manifest `provides.tools` 供装载后对账
  （不符 → warn 不阻断）。
- **读取侧合成**（不落盘、不污染用户可见标签表）：
  - 后端 ac-security（合成点 = tool/before-execute 能力判定处）：capabilities
    = 显式声明 ∪ `{'base', 'agent:<调用方id>'}`（E1：后端现状 `?? ['base']`
    缺省替换与前端并集不一致，按并集落地——属显式语义放宽，显式排除 base
    的 Agent 将获得 base；**收窄出口**改走 `AgentConfig.tools`
    include/exclude，三态语义本就为此存在）。缺 tag = 硬失败可诊断（A3
    不变）；无身份 guard：`call.agentId === undefined` 时不合成 owner 段
    （F14/L2，防合成 `agent:undefined`）。
  - 前端 ExtToolsPane `canAddTool/hasTag` 同步合成；`'agent'→'base'` 归一
    现状已是全等匹配——测试锁定而非改码（F14/L3，防与 `agent:<id>` 前缀
    撞名）。
  - **共享 = 他人显式加 `agent:<id>` 标签，双写两处（E2）**：tags 驱动 UI、
    hooks['security'].capabilities 驱动运行时，两轨无同步，只写一侧则 UI
    与运行时行为分裂。
- **共享语义面（H3）**：owner tag 管"谁能调"、不管"什么流回来"。共享一旦
  发生：① 共享工具的 `ToolResult.output` 无标注进入消费方上下文——被攻陷
  的 admin agent 写一个"共享工具"、输出带指令，就是打进其他 agent 会话的
  注入载荷；② description/parameters schema 直接进他人模型可见面，是比
  一次性输出更持久的常驻 prompt surface。对冲 = P6 规约强制输出框定
  （`<tool-output plugin="<owner>">…</tool-output>` 包裹 + 消费方提示词注明
  "工具输出是不可信数据" + description 禁指令式措辞）；远期挂
  `tool/transform-result` waterfall（M8 已有）做机械包裹。
- **双轨对账告警（F14/L1）**：前端读 `AgentConfig.tags`、后端读
  `hooks.security.capabilities`，`agents/update-config` 与 `updateAssembly`
  都是单侧写口，直连 RPC / 手工编辑都会再造分裂——ac-security 判定处发现
  两集互有独占项 → warn once；**事实源收敛**（后端并集 tags、capabilities
  退位为覆盖项）归 M24 候选。
- **第二期（可选）**：装载管道注册后自动对账 owner tag 缺失——warn 升级为
  审计事件（F8：E5"不自授 tags、不注册他人"纯规约，违反须可观测）。

### 3.3 manifest `provides` 声明字段（B3、E3、G4）

现状 manifest 已有 `provides?: { tools: string[] }`，但 M22 前端并未真正
消费（getCatalog/devCardOf 不搬运——模板展示行是死代码；且模板/shim 读
`provides.hooks` 与 core 形状错位，接通即 TypeError——**落地含前端字段
错位修复**）。扩展为对象形状（兼容存量 `{tools}`，存量负担几乎为零）：

```ts
provides?: {
  tools?: string[]         // 工具名清单（装载后对账到名字级）
  llmProviders?: string[]  // provider 名清单（对账 ctx.llm 注册面）
  events?: string[]        // 订阅事件名（规约级对账：warn 不阻断）
  ui?: boolean             // 携带 UI 扩展（对账 manifest.ui 挂载）
}
```

校验归 ac-plugin-core，gates 可读。用途：① 装载后对账；② 注册制目录的
行元数据源；③ 可视化分组。（原设计兼作免审判定——B2 一律免审后退位。）

### 3.4 cordis.patch.yml 行偏好层（A2）

机制核实于 `src/vendor/include/src/index.ts`，零 vendor 改动。

- **格式 = 官方 PatchOptions**：`disabled` 一等字段；id 脱靶 warn+跳过、
  name 不符该条跳过（fail-open 有日志）。**作用域 = include 管理的 yml
  行树**——`ctx.plugin()` 直挂的动态行不建 Entry、不经 patch 管道（§3.6
  熔断两层化的依据）。第一期只用：
  ```yaml
  # <AGENTCHAT_DATA_ROOT>/cordis.patch.yml
  - { id: mcp, disabled: true }
  ```
- **boot 桥接**：boot.ts 内联官方 bin.js 的 16 行（Context → Loader →
  include；现状动态 import 写死 config、不内联无法注入 patches——仓内已有
  内联先例 `ac-app/src/boot-yml-main.ts`），装载前读 patch 文件（不存在/
  损坏 = warn + 空数组，fail-soft）注入 include config 的 `patches`。
  **internal/* 事件观测必须 `{global:true}` 注册**——非 global 监听器掉进
  调用方 fiber 私有钩子链，全局分发不可见（G2）。
- **owning**：归 ac-plugin-registry（与安装态同域）。增 `listPatches()/
  setPatch(id, disabled)`：读改写 patch 文件（tmp+rename 原子写 + rename
  retry，入全局串行队列）。
- **热通道（后置 P7，H2）**：经 `ctx.registry.get(Include).fibers` 取 fiber，
  `fiber.update({path: './cordis.yml', patches})` = 事务化行树变更（失败回滚
  保持旧树），停用即时生效。**首期 setPatch 只写文件 + 显式
  restart-required**；RPC 三态形状（`hot` / `written+restart-required` /
  `no-include-row`，F12/M5）现在定死、首期 `hot` 恒不返回——接口前向兼容，
  热通道落地不改契约。裁剪理由：热通道 + 写回守卫是全方案最贴 vendor 私有
  面的工程，yml 行停用的即时性首期由"重启生效"承接。
- **cordis.yml 写回守卫（F10/H5）**：热通道自身安全（include 挂 loader 内存
  根树、`Loader.write()` 为 no-op——均已核实），但 vendor loader 存在其它
  写回路径（`ctx.loader.create/remove/update` 每 API 末尾 `tree.write()`；
  yml 行 fiber 被 `fiber.update(config)` 且 `noSave=false`；行 fiber 经非
  loader 途径 dispose 自动写 `disabled: true` 落盘）——全部会把**已应用
  patch 的树数据**烧回 cordis.yml 且零告警。守卫测试"patch-set + 任意树
  操作后 cordis.yml 字节不变"锁死"出厂态永不运行时写入"不变量（防 M24
  配置弹窗、运行时加行、HMR 等未来功能隐性烧回）；**含 insert 型 patch
  场景**（烧录后下次启动 patches 再叠、insert 重复插行）。
- **反依赖图（后置 P7，F9、H2）**：从运行时 fiber 树构建（fiber 名 ×
  `fiber.inject` 键集，传递闭包；yml 行内无 inject 声明，解析 yml 只得
  空图）。fiber 名 ≠ 行 id ≠ 包名，须先做 **fiber→顶层行聚合映射**（沿
  fiber 祖先链定位挂载行；匿名 fiber 继承父名的假边在聚合时归并）；
  经 RPC 透出，UI 停用承重行时展示级联影响（"停用 ac-llm 将断链
  llm-openai/llm-deepseek/llm-glm/agent-loop/web-api/…"）——自动判定取代
  手工核心插件白名单。**已知盲区如实标注**：`ctx.get()` 软依赖不进
  fiber.inject（实例：ac-security 的沙箱基准在 workspace 行停用后静默回落
  `hooks.workdir`），UI 说明"图只反映 inject 声明的依赖"；**保护行标记**
  （F9/M9）：`security`、`plugin-gates` 是无人 inject 的叶子策略行，停用
  须二次确认 + 特殊文案，不指望依赖图。
- **RPC 与容错（F12/M6）**：`plugin/patch-list`（patches；反依赖图随 P7）、
  `plugin/patch-set`（写文件 + 三态返回，首期无 hot）；UI = 插件库「装配行」
  页签行卡片停用开关（首期恒"重启生效"提示）。未知 patch 键与 patches
  字段形态错误 warn 不阻断——现状 applyEntryPatches 把非保留键当 overrides
  直塞 entry 零告警零效果，而"文件人可读可手工急救"是本层核心卖点（校准：
  yml 自身顶层非数组在 include read() validate 即抛，静默吞的只有
  config.patches 非数组）。
- **宿主控制面防护（E4、F1/H1、G3）**：路径类工具对常规 Agent 有硬沙箱
  （files/<agentId>/），但两个例外——preset Agent 的沙箱根 = 整个数据根、
  bash 扫描是启发式纵深防御非完备沙箱。对策 = **denyPaths 黑名单运行时按
  数据根解析绝对路径注入**（注入点 = ac-security 装配 resolver 处，
  `resolverOf` 每次工具调用重建、天然吃运行时根）——裸文件名在
  `isDeniedPath` 三模式（`**/xxx` 文件名、`~/` 家目录、其余绝对前缀）下
  **永不匹配**（防线静默失效），`**/` 模式则任意目录同名文件全拦（误伤）。
  黑名单 = `cordis.patch.yml`、`plugins/registry.json`、
  `plugins/.load-health.json`、`plugins/audit.jsonl`、`.safe-mode`。
  **失效模式闭环（G3）**：① 锚点 = `workspace.root`——不能按 agent 沙箱
  基准拼（显式 `hooks.workdir` 优先级会锚错；现有软依赖窄类型只暴露
  `sandboxWorkdir`，需加宽读 root）；② workspace 不可用时 **fail-closed：
  拒装配该 resolver + 显式告警**——静默跳过 = 数据根项无声消失、回落
  workdir = 锚错基准，均为防线静默失效（F9 盲区复合形态）；③ registry +
  audit 两项注入随 P1a 先行，其余三项随 P3-lite。
- **保护强度如实呈现（F2/H2）**：denyPaths 仅覆盖路径类工具——bash 扫描
  只传 `{roots, cwd}`，denyPatterns 根本不进检查，**bash 面对以上文件
  裸奔**：一条 `echo x > .safe-mode` 即可让重启后全部动态插件拒载（自拒
  服务）；删 registry.json / patch 文件则安装态与行偏好全灭。缓解：
  `.safe-mode` 存在时 boot 显式提示（§3.6 L8）；audit.jsonl 入黑名单只挡
  路径类工具，bash 持有者仍可删（残余风险如实入 §六，B2 等价性立场内
  已接受）。

### 3.5 事件执行链可视化（A4 第 1 层：静态读出）

- **新 RPC `events/listeners`**（owning = ac-web-api 只读透出）：dump
  `ctx.events._hooks`——每事件**有序** Hook 数组（数组序 = waterfall 执行
  序），经 `hook.ctx.fiber.name` 归属 + `prepend` 标记；零分发开销、只读、
  零 vendor 改动。**归属首期裸 fiber 名如实呈现**（监听器挂服务 fiber 时
  显示类名），fiber→行聚合随 P7 升级为行名（H2）；`_hooks` 只见公开事件
  与 global 监听器，不承诺 `internal/*` 全景（G2）。events 层无公开列举
  API，`_hooks` 私有读取是唯一路径（RPC 形状测试兜底 vendor 升级）。
- **UI**：插件库「装配行」页签按事件展开执行链：
  `loop/before-run: ac-persona → ac-system-prompt → ac-datetime → ac-memory → …`。
- **第 2 层（后置可选）**：诊断行订阅 `internal/dispatch` 记录实际分发链序
  与耗时；高频，须按事件名过滤 + 配置开关。**优先度不做**：原生 `prepend`
  双档够用；远期出口 = 策略行拦截 `internal/listener` bail；魔改 vendor 已
  否决（永久 fork 负担 + 侵蚀 ADR-7 顺序无关保证）。

### 3.6 无人值守补偿控制（B2 配套）

| 控制 | 形态 | 现状 |
|---|---|---|
| 审计 | `plugins/audit.jsonl` 流水（install/uninstall/reject/load，G7）+ session 留痕 + `plugin/loaded.failed[]`；E5 违规对账升级审计事件（F8） | failed[] 已有；补流水 |
| **hash 复验（F3）** | `loadInstalled()` 入口比 `hashPluginDir(dir) !== record.hash` → 拒载记 failed[]（防 bash 篡改已装目录重启静默装载调包代码；成本 = boot 一次目录哈希；拒载文案引导"重装或 uninstall"防良性手工改动被静默熔断） | 新增 |
| **熔断** | **动态插件（首期，恰是失败计数主人群）**：`.load-health.json` 失败计数 + disabled 集，`loadInstalled()` 入口跳过并告警；成功装载清零；install（含 bump version 重装）/ uninstall 强制清该 name 记录（F4，防"修复后永远装不上"死锁）；install 期装载失败同源立即计数；同 hash 幂等重装不触发装载重试（G8）。**yml 行（后置 P7，H2）**：`{global:true}` 订阅 internal/status 计数（G2：FAILED ≠ 级联 PENDING、归属经 fiber→行聚合）+ 失败 ≥3 次写 patch disable + setPatch 再启用清计数（G9） | 新增 |
| **boot 首扫 gates 屏障（G5）** | loadInstalled 在 plugin-registry 行 apply 内异步点火（inject `['tools']` 激活极早），plugin-gates 要等 registry fiber 激活后才挂 before-load 监听——首批 boot 装载可能过**空 waterfall**（权限/契约 gate 空转）。修复 = 首扫延迟到 fiber 树稳定（或 gates 就绪屏障）；install_plugin 运行时路径不受影响 | 新增 |
| **熔断跳过态透出（G9）** | 进 disabled 集后跳过 → failed[] 不再重算 → 三态徽章退化为"未装载"（坏过被熔断与从未装载不可区分）。`plugin/loaded` 增 `skipped[]`（name/原因/计数）；徽章第四态"已熔断"（附复位入口） | 新增 |
| **安全模式** | `AGENTCHAT_SAFE_MODE=1`（env）或 `.safe-mode` 标记 → 跳过 loadInstalled（插入点 = ac-plugin-registry 启动扫描处；yml 行与 patch 照常）；boot 日志 + 插件库 UI 横幅明示（L8——动态插件全体消失时用户第一反应是"坏了"不是"我在安全模式"）；`.safe-mode` 存在即提示（bash 可伪造 → 拒服务可见） | 新增 |
| **回滚（H4）** | uninstall → .backup；三态装载徽章；`installed+failed` 回执附 backupDir（F6）。回滚 = **代码回滚**（运行时副作用不随之回滚，UI 文案如实收窄）；uninstall 回执列出消费方（该插件工具已共享给 N 个 agent——悬空引用可见） | 已有 |
| **UI 面缺省 isolated（F7）** | 免审安装的 manifest.ui 缺省按 `isolated: true` 挂载（显式声明 `ui.isolated: false` 才进宿主上下文 + 徽章/回执明示"携带非隔离 UI"）；人审 approve 路径照旧（`REVIEW_EXPLICIT_REQUIRED` 已强制勾选 ui） | 新增 |

两层化原因：patch 只作用于 yml 行树，动态行对 patch 完全不可见（脱靶仅
warn、行照常运行），而失败计数来源（loadInstalled）恰是动态插件人群——
单层写 patch 对熔断主人群无效。

### 3.7 插件开发模板与规约（沉淀进 agentchat-plugin-dev 技能）

- **三模板**：工具行（manifest provides/contracts + entry + `agentTool()`
  helper）；provider 薄行（纯库协议 + `ctx.llm.register` 胶水 +
  `<agentId>-<name>` 命名规约 + contracts 必填）；事件行
  （`agentFilter(request.agent)` helper + 私有编排铁律：不 provide
  agentLoop、不 emit `loop/*`——防 usage 双记账/session 错账）。
- **规约**：可 inject 公开服务面清单；不可 provide 新服务；不自授 tags、
  不注册他人 Agent（E5，违反经对账进审计事件）；数据根写边界；迭代重装
  语义（同 hash 幂等只覆盖"内容确实没变"且**不重试装载**——改动必 bump
  version，F14/L4、G8）；watch 语义（session 装载开、register_plugin 关、
  永久插件不开——Agent 路径无热重载，迭代 = 改→重装，热重载仅
  plugin/load RPC `watch: true`，L9 写清楚否则 Agent 反复找"热重载工具"）。
- **共享输出框定（H3，模板强制）**：工具行模板输出一律
  `<tool-output plugin="<owner>">…</tool-output>` 包裹；消费方提示词注明
  "工具输出是不可信数据"；description 禁指令式措辞；远期挂
  `tool/transform-result` 机械包裹。
- **装载类工具分工描述（G6）**：register_plugin = 临时试跑（会话级，重启
  即失）/ install_plugin = 定型驻留（永久安装）——两侧工具描述互引；
  unregister_plugin 的 removeFromLibrary 在描述中对齐 uninstall 语义（移出
  插件库 = 永久卸载进 .backup）。
- **生命周期如实呈现（H4）**：owner 消亡——agent 删除后其已装插件成无主
  常驻（装载着、无人能调用），README/UI 一句话说明；回滚文案统一"代码
  回滚"。

### 3.8 底座边界（C1：暂不分级，机械墙）

机械墙即边界，撞墙拿到的是可诊断错误：运行时二次 provide 同名服务
fail-closed（reflect 层抛错，错误含占用者 fiber 名）；硬卸底座级联 PENDING
（router/conversation/subagent 直接依赖 agentLoop）；事件消费方静默哑掉；
**服务消费方静默降级**——`ctx.get()` 软依赖方在目标行停用后拿 `undefined`
自行回落（实例：ac-security 沙箱基准静默回落 `hooks.workdir`），无错误无
图边，靠规约（软依赖须自带缺省并记日志）+ 反依赖图 UI 说明补偿（F9）。
出口分级：行为级（事件 seam）与旁路级（私有编排器 = inject llm/tools 的
普通插件）现已可用；策略级（loop 策略注册中心，C2）另立项；源码级（git
流共写）已支持。

### 3.9 「插件」UI 呈现调整（前端；方案1 的 M23 部分）

M22 结构地基（插件库四页签 / 装配行三区 / 装配页两分区 / hooks 参数弹窗）
不变，本节只做词汇对齐、分组与来源维度：

| UI 项 | 位置 | 归属 |
|---|---|---|
| 装配行页签三区重组：**插件**（行清单 + 停用 toggle）/ **工具** / **具名钩子**（"扩展目录"改名）；级联警告随 P7 | 插件库「装配行」 | **P3-lite** |
| plugin/rows 透出 `origin: 'dynamic'` + **「Agent 开发行」单列分组**（owner 徽章 + 装载态 + unload/uninstall）。判据（F11/M7）= registry.json（安装态）∪ listLoaded()（会话态）——`installed+failed` 与已 unload 的安装态不在 loaded 里，按名字只查 loaded 会漏一半；yml 行与动态插件同名时按 fiber 归属判（首期 registry 名单近似，精确归属随 P7） | 同上 | **P3-lite** |
| 装配页扩展分区**「按插件分组」**（ExtensionEntry.row 分组）+「仅显示有参数的插件」过滤开关 | AgentPane「装配」 | **P4** |
| 插件/工具/具名钩子**配置弹窗**（全局默认参数） | 插件库「装配行」 | **M24**（依赖 A1；configNs 挂点 M22 已留） |

- **两类停用语义分开表达**：yml 行停用 = 写 cordis.patch.yml（首期重启
  生效，热通道随 P7）；动态插件（含 Agent 开发行）停用 = `plugin/unload`
  （真热卸）、卸载 = uninstall（.backup）。
- **徽章如实呈现（F7/F8）**：非隔离 UI 插件徽章"携带非隔离 UI"（读会话
  流 / 以用户会话身份调全部 RPC）；admin 徽章明示"门禁挡的是进程内工具
  调用，不挡 bash 持有者"；safe-mode 生效时插件库横幅（L8）。
- **熔断态可见（G9）**：skipped[] 透出后「已安装」页签徽章第四态"已熔断"
  （附原因与复位入口）。
- **`origin: 'dynamic'` 修复 M22 盲点**：动态装载行（包名解析不到）现标
  `'internal'` 被前端插件目录过滤，Agent 开发的插件不可见；三态化后单列
  分组。
- 装配页分组/过滤不依赖 A1：per-Agent 参数面 = `hooks['名'].*`（M22 参数
  弹窗已有），A1 只影响全局默认值弹窗。

---

## 四、裁决记录

> 本节为追溯索引（细节以 §三/§五 正文为准）。v1/v2 轮原文详见早期版本与
> `docs/m23-review-findings.md`。

**v1 方案探讨（A-D 系）**：

| # | 裁决点 | 结果 |
|---|---|---|
| A1 | 全局 hooks 默认层 | ✅ 立项，ac-agents 单点合成（归 M24） |
| A2 | 全局插件启停 | cordis.patch.yml：声明式 patch + boot 桥接；热通道与反依赖图后置 P7（H2 修订） |
| A3 | requires tag 门禁 | 维持全硬门禁（缺 tag = 工具失效），不做两档化 |
| A4 | 钩子顺序 | 诉求 = 执行顺序可视化（非重排）→ §3.5；不魔改 vendor |
| B1 | 开发目录分工 | files/<agentId>/ 开发（沙箱默认）；plugins/<agentId>/<name>/ 留给用户手工开发扫描面 |
| B2 | install_plugin 免审 | 一律免审（范围 = 自开发自安装；第三方供应链另裁）+ §3.6 补偿控制 |
| B3 | manifest provides 字段 | ✅ 加（形状见 E3/G4） |
| B4 | 工具型 per-Agent 归属 | 默认私有（owner tag + 合成 `agent:<id>`），共享 = 显式 |
| C1 | 底座分级红线 | 暂不分级（机械墙兜底，§3.8） |
| C2 | loop 策略注册中心 | 另立项，不阻塞本文 |
| D1 | M23 立项 | 本文档 |

**v2 代码核查（E 系）**：

| # | 裁决点 | 结果 |
|---|---|---|
| E1 | capabilities 解析 | 后端缺省替换 / 前端并集本就不一致——按并集落地（显式放宽，P2 测试锁定） |
| E2 | 共享标签落点 | tags（UI）/ capabilities（运行时）双轨 → 共享动作双写两处 |
| E3 | provides 形状 | 扩展为 `{tools, llmProviders, events, ui}`，对账升到名字级 |
| E4 | 熔断两层化 + 控制面黑名单 | 动态插件走 .load-health disabled 集，yml 行走 patch；denyPaths 增补五个控制面文件 |
| E5 | 供给面补全 | 开放注册面 = tools/llm/agents + ui 挂载面；规约：不自授 tags、不注册他人 |
| E6 | installFromDir 工程语义 | 三态结果 + 无暂存残留；不用 uninstall 补偿；registry 原子写；同版本重装抛错（bump version 或同 hash 幂等）；per-name 串行化；结果回传会话 |

**v3 实施前审查（F 系；依据 `docs/m23-review-findings.md`，机制断言已逐条对照代码属实）**：

| # | 裁决点 | 结果 |
|---|---|---|
| F1 | denyPaths 落点 | 运行时按数据根解析绝对路径注入（非内置静态列表）；正负例双测试 |
| F2 | 保护强度如实呈现 | denyPaths 仅覆盖路径类工具，bash 面裸奔明示；audit.jsonl 定名即入黑名单；.safe-mode 存在即 boot 提示 |
| F3 | hash 复验 | loadInstalled 入口比 hash，不符拒载记 failed[] |
| F4 | 熔断生命周期 | install（含 bump version）/ uninstall 强制清熔断记录；install 期失败立即计数 |
| F5 | 文件域并发与原子性 | 全 mutation 入口 + patch 写统一串行队列；三处 tmp+rename 复用 Windows retry |
| F6 | approveStaging 可补偿 | 重构为可补偿分步（堵 writeRegistry 抛错半完成态）；失败回执附 backupDir |
| F7 | UI 缺省 isolated | 免审 manifest.ui 缺省 isolated；非隔离须显式声明 + 明示；人审路径照旧 |
| F8 | admin 边界如实呈现 | 明示"门禁挡进程内工具调用，不挡 bash 持有者"；E5 违规升级审计事件 |
| F9 | 反依赖图/执行链保真 | fiber→顶层行聚合映射；ctx.get 盲区 UI 说明补偿；保护行标记（后置 P7） |
| F10 | cordis.yml 写回守卫 | "patch-set + 任意树操作后字节不变"测试锁死出厂文件不变量 |
| F11 | origin:'dynamic' 判据 | registry.json ∪ listLoaded()；同名按 fiber 归属 |
| F12 | patch 通道容错 | setPatch 三态返回；未知键与形态错误 warn 不阻断 |
| F13 | 内置注册名保留字 | 装载管道对内置名冲突给可诊断拒绝（重名抛错不对称，受害者是出厂行） |
| F14 | 低危批收 | 免审去 grants（L5）；同 hash 幂等必做 + bump 引导（L4）；回执 session.append + register_plugin 统一（L6）；无身份 guard（L2）；'agent' 归一测试锁定（L3）；数据根外 dir 警告（L10）；tags/capabilities 对账告警、收敛归 M24（L1）；watch 语义说明（L9）；一轮一中断入工具描述（L7） |

**v4 第二轮全面审核（G 系；42 条机制断言对照代码——36 属实、4 部分属实已校准）**：

| # | 裁决点 | 结果 |
|---|---|---|
| G1 | 保留字清单来源与范围 | 各域内置名常量表（yml 元数据不含、运行时比有时序竞争）；范围含 tools/llmProviders/agents 三面 |
| G2 | yml 行熔断数据源 | `{global:true}` 订阅 internal/status（FAILED ≠ 级联 PENDING；归属经 fiber→行聚合）；随 P7 |
| G3 | denyPaths 注入 fail-closed | 锚点 workspace.root（窄类型加宽）；workspace 不可用拒装配 + 告警；registry+audit 注入随 P1a 先行 |
| G4 | provides 现状修正 | M22 目录未消费（死代码）且前端读 provides.hooks 错位、接通即 TypeError；落地含修复 |
| G5 | boot 首扫 gates 竞态 | 首批装载可能过空 waterfall——首扫延迟到 fiber 树稳定 |
| G6 | register_plugin 收敛 + 分工锁定 | grants 去除；与 install_plugin 不合并（permanent 参数是更重陷阱）；描述互引；回执寻址用 request 参数 |
| G7 | 审计流水补全 | uninstall/reject/load 同入 audit.jsonl；无轮转首期接受 |
| G8 | 同 hash 幂等不重试装载 | 返回已装状态与上次结果，不触发装载（防无限装载循环）；重试正路 = bump version |
| G9 | 熔断跳过态透出 | plugin/loaded 增 skipped[]；徽章第四态；yml 行再启用清计数 |
| G10 | 串行化前提校准 + 排除集统一 | 现状同步无单进程 RMW（真实面 = 多进程 + F6 后跨 await）；copy/hash 排除集统一；.backup 名加随机后缀 |
| G11 | 批次重排 | P1 拆 P1a/P1b；denyPaths registry+audit 随 P1a 先行；F6 回归含人审流 |

**v5 外部评审（H 系；闭环用户/价值链/复杂度预算/语义攻击面四个结构性盲区）**：

| # | 裁决点 | 结果 |
|---|---|---|
| H1 | 闭环自驱动 | 回执后 sender:'event' 回触 owner 自会话（否则闭环 = 人类陪走五步）；P1 金闭环 e2e——回执/错误文案"可独立驱动下一步"为验收项 |
| H2 | P3-lite 裁剪 | 首期 setPatch 只写文件 + 显式 restart-required（三态形状保留、hot 恒不返回）；热通道/fiber→行聚合/yml 行熔断后置 P7——首期熔断只覆盖动态插件，闭环零损失；F10 守卫保留 |
| H3 | 共享语义攻击面 | owner tag 不管"什么流回来"——共享输出 = 跨 Agent 注入载荷、description = 常驻 prompt surface；对冲 = P6 输出框定规约 + 远期 transform-result |
| H4 | 生命周期悬挂 | uninstall 回执列消费方；owner 消亡如实呈现；"一键回滚"收窄为"代码回滚"（运行时副作用不回滚） |
| H5 | 批次价值排序 | 闭环关键路径 P1→P2→P5→P6（P5 去 P3 依赖后可前移）；P3-lite/P4 治理增强；P7 后置。优先级 H1 > H3 > H2 |

---

## 五、迁移步骤（分批，每批独立可验收）

验收命令统一：`pnpm --filter ac-webui-app typecheck` +
`pnpm exec vitest run preview/webui/tests` + `pnpm preview:typecheck &&
pnpm preview:test` + `pnpm preview:smoke` / boot 手测该批功能。

> **实施顺序（H5）**：P1 → P2 → P5 → P6（闭环关键路径）；P3-lite / P4
> （治理与观测增强）；P7（后置，不阻塞闭环）。

### P1 免审安装口（后端；P1a / P1b，各天级）

**P1a 复合口与工具面**：

1. `installFromDir`：三态结果、rejectStaging 补偿、approveStaging 可补偿
   分步重构（F6，回归含人审 approve 流）、dir 缺省限 files/<owner>/ 下；
   审计流水（install/uninstall/reject/load → `plugins/audit.jsonl`，G7）。
2. `install_plugin` 工具：interrupt + after-run 宿主半边 + 回执
   （session.append + M21 格式，寻址用 request）+ **sender:'event' 回触
   owner 自会话（H1）**；register_plugin 统一补回执 + grants 去除（G6）；
   两工具描述互引；数据根外 dir 警告。
3. denyPaths 先行两项（G3/G11）：ac-security 装配处按 `workspace.root`
   注入 `plugins/registry.json` + `plugins/audit.jsonl`（fail-closed）
   ——堵 P1→P3 审计裸奔窗口。
4. 测试：无暂存残留、三态结果形状、中断通道与回执（含 register_plugin）、
   流水落账（含 uninstall/reject）、dir 缺省约束（数据根外仅警告）、
   denyPaths 先行两项正负例（真实路径拦截 + workspace 不可用 fail-closed）、
   人审 approve 流回归、事件回触（回执 → 自会话信封投递）。
5. **金闭环 e2e（H1）**：脚本化 agent 走完五步（开发→装载/安装→回执→
   回触→测试迭代），断言每条回执/错误文案**可独立驱动下一步动作**（bump
   version 引导、同 hash 幂等返回、失败三态与 backupDir）——"LLM 可自纠"
   验收。

**P1b 工程语义**：

1. per-name + 全 mutation 面串行化（F5/G10）；registry.json tmp+rename +
   Windows retry；同 hash 幂等短路（不重试装载，G8）+ bump version 引导
   文案；copy/hash 排除集统一 + .backup 名随机后缀（G10）。
2. 保留字护栏（F13/G1）：各域内置名常量表（三注册面），冲突可诊断拒绝；
   一致性测试锁定常量表与实际注册面。
3. 测试：同版本重装抛错、同 hash 幂等（含不重试语义）、approveStaging
   中途失败可恢复、registry 全 mutation 并发不丢、原子写、保留字拒绝
   （三面各一例）、常量表一致性、深层 node_modules 入 hash。

### P2 owner-tag 归属（前后端，天级）

1. ac-security capabilities 并集解析（E1）+ 无身份 guard（L2）+ 前端
   canAddTool/hasTag 同步合成；共享标签双写（E2）；'agent' 归一测试锁定
   （L3）；双轨对账告警 warn once（L1）。
2. manifest provides 扩展对象形状（E3，兼容存量；含前端字段错位修复，G4）。
3. 测试：owner 可执行 / 他人默认被拦 / 显式加 tag 放行三态；显式排除
   base 的 Agent 获 base（E1 锁定）；双轨一致性（只写 tags 运行时仍拦）；
   无身份调用路径；存量 `'agent'` tag 与 `capabilities: []` 迁移行为锁定；
   对账告警触发形态。

### P3-lite patch 行偏好层（后端为主；H2 裁剪——热通道/聚合/级联警告后置 P7）

1. boot.ts 内联官方 16 行 + patch 文件读取（fail-soft）+ 未知键/形态错误
   warn（F12/M6）。
2. `listPatches/setPatch`（原子写 + retry，入全局串行队列）；RPC 三态形状
   定死、首期 hot 恒不返回——只写文件 + 显式 restart-required（接口前向
   兼容）。
3. denyPaths 补全：`.safe-mode` / `cordis.patch.yml` /
   `plugins/.load-health.json` 三项（registry/audit 已随 P1a）；锚点与
   fail-closed 按 G3。
4. cordis.yml 写回守卫测试（F10）：patch-set + 任意树操作后字节不变；
   含 insert 型 patch 场景。
5. 前端：装配行页签三区重组 + 行卡片停用开关（首期恒"重启生效"提示）；
   `origin:'dynamic'`（F11 判据，同名首期按 registry 名单近似）+「Agent
   开发行」单列分组。
6. 测试：patch 生效（boot 路径）、脱靶 id 仅 warn、坏文件 fail-soft、
   未知键 warn、patch 并发写不丢、setPatch 首期返回 restart-required、
   dynamic 分组形状、denyPaths 正负例（真实数据根路径拦截 preset Agent +
   裸文件名写法不生效）、写回守卫。

### P4 事件执行链可视化 + 装配页插件分组（前后端，天级）

1. `events/listeners` RPC（_hooks 有序读出 + prepend 标记；归属首期裸
   fiber 名如实呈现，聚合升级随 P7）。
2. 前端执行链渲染（按事件目录分组）。
3. 装配页「按插件分组」+「仅显示有参数的插件」过滤开关。
4. 测试：RPC 形状锁定（含 dynamic 装载后顺序变化）、分组/过滤纯前端行为。

### P5 熔断与安全模式（后端，天级；H2 后无 P3 依赖，可前移至 P2 之后）

1. `.load-health.json` 失败计数 + disabled 集（首期只覆盖动态插件；
   yml 行熔断后置 P7）：loadInstalled() 入口跳过并告警；成功清零；
   install（含 bump version）/uninstall 强制清记录（F4）；install 期失败
   同源立即计数；同 hash 幂等重装不触发装载（G8）。
2. boot 首扫 gates 屏障（G5）：首扫延迟到 fiber 树稳定（或 gates 就绪
   屏障）。
3. 熔断跳过态透出（G9）：`plugin/loaded` 增 skipped[]；徽章第四态。
4. hash 复验（F3）：入口比 hash，不符拒载记 failed[]（文案引导"重装或
   uninstall"）。
5. 安全模式（`AGENTCHAT_SAFE_MODE` / `.safe-mode`）：跳过 loadInstalled；
   boot 提示 + UI 横幅（L8）。
6. 测试：计数持久化、熔断后 boot 不再重试装载、bump version 重装解锁、
   熔断清除（成功清零/手动复位/uninstall）、install 期失败即计数、同
   hash 幂等不重试、hash 复验拒载（篡改已装目录 → boot 拒载）、skipped[]
   透出与第四态徽章、boot 首扫在 gates 之后（竞态回归）、安全模式逃生。

### P6 模板与规约（文档+骨架）

1. 三种插件模板骨架 + agentchat-plugin-dev 技能更新（E5/E6/F 系规约）。
2. 共享输出框定规约（H3，模板强制）：`<tool-output>` 包裹 + 消费方提示词
   + description 写作规约。
3. 生命周期如实呈现（H4）：owner 消亡说明、uninstall 回执列消费方、回滚
   文案统一"代码回滚"。
4. README / src-to-preview-map 同步；补记 files/<agentId>/ 与
   plugins/<agentId>/ 开发分工（现未记载）。

### P7 热通道与 yml 行治理（后置，不阻塞闭环；H2 承接 P3 裁下项；**已收编进 M25**——`docs/m25-event-governance-plan.md` §3.5）

1. include 热通道（`fiber.update` 事务化行树变更；查找键
   `ctx.registry.get(Include)` 实现时验证）+ setPatch 返回 hot 态
   （F12/M5 三态补全——契约已前向保留）。
2. fiber→顶层行聚合映射（F9）→ 反依赖图透出 + 保护行标记（F9/M9）+
   承重行级联警告 + 软依赖盲区 UI 说明。
3. yml 行熔断：`{global:true}` 订阅 internal/status（G2）+ 失败 ≥3 次写
   patch + setPatch 再启用清计数（G9）。
4. P4 归属升级（裸 fiber 名 → 行名）+ P3-lite dynamic 同名判据升级
   （registry 名单近似 → 精确 fiber 归属）。
5. 测试：热更新失败显式降级态（written+restart-required）、聚合正确性
   （服务 fiber 归属到行）、承重行警告文案、yml 行熔断写 patch、再启用
   清计数。

---

## 六、M24 候选与显式缩水/风险

**M24 候选（方案1 UI 线，已裁决未排期）**：

1. A1 全局默认层：config.json 存全局 hooks + ac-agents 单点合成（注意 GET
   展开回写冻结坑——合成只在读取消费侧，写侧只存 Agent 差异层）。
2. 配置弹窗（全局默认参数；依赖 A1；configNs 挂点 M22 已留）。
3. tags/capabilities **事实源收敛**（F14/L1：后端并集 tags、capabilities
   退位为覆盖项——M23 只做对账告警，收敛涉及存量迁移）。
4. audit.jsonl 轮转/大小上限（G7：首期接受无轮转）。
5. 其余维持 M22/M23 形态（三清单组织、装载徽章含熔断第四态、排序不做）。

**显式缩水（接受，不恢复）**：

1. 免审 = 自开发流无人工防线（用户裁决；补偿控制兜底，§3.6）。
2. requires 不做两档化（A3）。
3. 钩子优先度不做（prepend 双档够用；internal/listener 策略行为远期出口）。
4. 底座运行时替换不支持（机械墙，非制度红线）。
5. 第三方插件市场（供应链人审）不在本期。
6. skills/mcp 供给面开放化不在本期。
7. 热通道/fiber→行聚合/yml 行熔断首期不做（H2：P3-lite 裁剪，后置 P7
   ——首期 yml 行停用恒"重启生效"，闭环能力零损失）。

**风险与对策**：

- **常驻化恶意代码**（prompt injection → 持久后门）：等价性上 Agent 本有
  bash+node，免审不新增能力，增量在常驻/全局/自启——审计可追、熔断防
  崩溃循环、安全模式逃生、代码回滚（H4：运行时副作用不回滚）。残余
  风险 = 用户对"Agent 代码可常驻"的显式接受（与 bash 同级的信任决策）。
- **provider 型凭据外泄**：第一期靠审计流水；manifest 不声明 network 也能
  偷偷 fetch（Node 无运行时沙箱）——声明制固有限度，已知悉。
- **patch 文件误写/损坏**：fail-soft（warn+空数组）+ 文件人可读可手工
  急救；未知键/形态错误 warn（F12/M6）。
- **`agent:<id>` 合成点漂移 + 共享标签双轨**：单测锁定三态语义与双写
  一致性（E1/E2）。
- **浏览器侧常驻（F7）**：manifest.ui 是独立于进程内代码的常驻面——可读
  会话流、以用户会话身份调全部 RPC（含 `agents/update-config`、
  `plugin/approve` 等写口）、fetch 外传。对冲 = 免审缺省 isolated 挂载 +
  非隔离徽章明示。
- **bash 面控制文件裸奔（F2）**：denyPaths 不进 bash 扫描——`.safe-mode`
  可伪造（重启拒服务）、registry/patch/audit 可删（安装态/偏好/审计全灭）。
  与 bash 等价性立场同级（有 bash 即全权，用户已显式接受）；boot 提示
  缓解 .safe-mode 静默场景。
- **admin 边界强度（F8）**：admin 门禁挡的是进程内工具调用；agent-store
  配置文件 bash 可写（tags/capabilities 双轨都可自授 admin）、被攻陷的
  admin Agent 经 `ctx.agents.register` 注册自带 admin 的新 Agent 无阻拦
  ——无硬墙，文档与徽章如实呈现，不做硬边界承诺。
- **反依赖图盲区（F9，随 P7）**：ctx.get 软依赖测不到（服务消费方静默
  降级）；匿名 fiber 假边靠聚合归并；图只反映 inject 声明，UI 说明兜底 +
  保护行标记补叶子策略行。
- **denyPaths 注入自身的软依赖暴露（G3）**：控制面黑名单锚定 workspace
  行——fail-closed 已定，但 workspace 停用期间路径类工具的数据根防护整体
  降级为 BUILTIN 列表，与 bash 面残余风险同级呈现。
- **保留字表漂移（G1）**：内置名常量表与出厂行实际注册面靠一致性测试
  锁定同步——出厂行新增注册名未更新表 = 护栏漏风（装载期无人报错，只有
  测试红灯）。
- **事件回触 = 自治触发面（H1）**：回执后回触让闭环真正无人值守——补偿
  控制全部无人工的前提更依赖其自身可靠性；触发面限 owner 自会话（不跨
  agent），且是"机制触发 Agent 干活"的既有统一出口（B2 等价性立场内，
  非新增能力面）。
- **共享语义面残余（H3）**：输出框定是模板规约（软层）——不守规约的
  共享工具输出仍可携带注入载荷；transform-result 机械包裹是远期出口，
  首期靠规约 + 消费方提示词。
- **生命周期悬挂（H4）**：共享后卸载的悬空引用（回执列消费方可见但不
  机械回收）、owner 消亡的无主常驻插件（如实呈现）、回滚只覆盖代码——
  三者均为如实呈现的接受项。

---

## 七、事实源索引

| 内容 | 文件 |
|---|---|
| patch 语义 + internal/update 热通道 + 写回 retry（F5 依据） | `src/vendor/include/src/index.ts` |
| 官方 bootstrap（16 行内联源） | `src/vendor/cordis/bin.js` |
| 事件层观测点（`_hooks` 有序 / `internal/dispatch` / `internal/listener` bail / `prepend`） | `src/vendor/cordis/src/events.ts` |
| 动态行 vs patch 管道（E4：ctx.plugin 不建 Entry、脱靶仅 warn） | `src/vendor/cordis/src/registry.ts` |
| fiber 依赖表 + 状态迁移事件（F9 反依赖图数据源；G2：internal/status 含 FAILED） | `src/vendor/cordis/src/fiber.ts` |
| 服务作用域原语（isolate/intercept/extend——论证"不用"的依据） | `src/vendor/cordis/src/{context,reflect}.ts` |
| 装载管道（interrupt 通道 / loadInstalled 无 hash 复验（F3） / watcher / failed[]） | `preview/ac-plugin-registry/src/{index,service}.ts` |
| 安装态文件域（stage / approve / registry.json / manifest；approveStaging 分步顺序（F6）） | `preview/ac-plugin-core/src/{store,manifest}.ts` |
| capabilities 双轨（E1/E2：hooks 执法、tags 驱动 UI） | `preview/ac-security/src/index.ts`、`preview/webui/src/settings/components/ExtToolsPane.vue` |
| preset Agent 沙箱 = 数据根（E4 denyPaths 依据） | `preview/ac-workspace/src/index.ts` |
| provider 注册中心形态（懒实例化/重名抛错） | `preview/ac-llm/src/service.ts` |
| M22 落地形态（四页签/三态徽章/dev-scan/failed[]） | `preview/docs/m22-ext-plugin-ui-plan.md` 及其实现 |
| deny 模式语义（F1：绝对前缀 / `**/` 文件名 / `~/` 三模式，裸文件名永不匹配） | `preview/ac-sandbox-core/src/paths.ts` |
| 工具注册重名抛错 + bash 扫描契约无 deny 面（G1/G3） | `preview/ac-tools/src/service.ts`、`preview/ac-sandbox-core/src/bash-scan.ts` |
| loader 写回路径（F10：tree.write / internal/update 落盘 / 非 loader dispose 自动 disabled） | `src/vendor/loader/src/{index,config/tree}.ts` |
| manifest.ui.isolated + 人审强制勾选 ui（F7） | `preview/ac-plugin-core/src/manifest.ts` |
| 内联 bootstrap + patches 注入先例（A2 补强） | `preview/ac-app/src/boot-yml-main.ts` |
| provides 前端消费错位（G4：读 provides.hooks、不搬运 provides） | `preview/webui/src/settings/api.ts`、`preview/webui/src/settings/components/PluginLibraryPane.vue` |
| M23 实施前审查报告（v3/F 系依据；H/M/L 编号出处） | `preview/docs/m23-review-findings.md` |

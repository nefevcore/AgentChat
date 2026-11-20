# 定时器 v3：哑触发层（timer-v3）

> 性质：域深设计——timer v3 终态规格：哑触发层 + 采集分离（source 行承载外部状态获取）
> 状态：现行 · cr-1161 2026-11-20（取代 timer-scripting.md〔cr-1147 / cr-1149〕）；核心换轨 cr-1164 / 采集层 cr-1165 已落地
> 读者：改定时域（ac-timer-core / ac-host-rows timers 行 / timer-face / Timer UI）与写 source 行的人

## 一、设计目标与动机

v2（cr-1147 探测循环）把触发逻辑代码化：条目携带判定脚本，宿主 worker 求值。上线实测暴露三个结构性病灶，均非实现疏漏，而是「触发器是代码」这一个决定的税：

| # | 病灶 | 表现 |
|---|---|---|
| 1 | 执行面税 | worker 求值 + AST 拦截（require/import）+ 仍欠着的 realm 隔离——全是为执行用户代码而生的设施 |
| 2 | 授权旁路 | code 落盘后免 run、免授权投影、免审批地周期执行；无 shell 标签的 Agent 借 timer(set) 即得宿主进程全权（tester 2026-11-17 实测 process.getBuiltinModule('fs') 畅通——AST 拦截是语法纪律，不是安全边界） |
| 3 | 不可静态解释 | 下次触发依赖脚本运行结果；list 只能说「下次探测在 X，然后看脚本」，cron 级可读性消失 |

v3 裁决：**timer 的终态不是「安全的代码执行面」，而是「没有代码执行面」**。三种定时诉求各有正确的家：

| 诉求 | v2 的解 | v3 的家 |
|---|---|---|
| 到点唤醒 | 脚本判 minute / last | 声明式触发词汇（when） |
| 条件唤醒（外部状态变化） | 脚本 fetch / fs（漏洞本体） | source 行采集 + source 触发词汇 |
| 语义判断（值不值得叫醒） | 脚本内判定 | Agent run（唤醒后全治理判定） |

对齐先例：cron / systemd timer（哑调度 + 声明式日历）、Prometheus exporter → alertmanager 规则（声明式表达式）→ responder、Home Assistant 时间触发器（一次性 timer 触发后自续）。**泛用性来自正交层的组合，不来自中间层的图灵完备。**

## 二、三段架构

```
采集层（代码，受信）            触发层（数据，哑）                判定/执行层（代码，全治理）
source rows（宿主侧行）         timers 行                          Agent run
物化 rows.jsonl + seq      →    when[] ∩ gates[] → 命中 → 投递  →  唤醒信（budget / 工具 /
emit source.updated 事件         记账 lastSeq / count               授权 / 审计 / 账本在场）
```

| 职责 | 归属 | 信任模型 |
|---|---|---|
| 获取外部状态（解密 DB、带凭据调 API、轮询） | source 行 | 用户安装的插件行（install 即授权，auth.json grantSource='install' 现成） |
| 机械变换与匹配（since-id diff、字段过滤） | 触发层声明式词汇 | 纯数据，set 时静态校验 |
| 语义判断 | Agent run | 全治理语境 |

timer 自身：**哑的事件匹配器 + 排程器**——不采集、不判定、不执行任何用户代码。

## 三、条目契约

`entries/timer.json` v3 形态（整表带 `version: 3`；`kind` 字段退役）。

时间条目示例：

```jsonc
{
  version: 3,
  entries: [{
    id: 'daily-review', label: '晨间巡检', enabled: true,
    when: [ { kind: 'daily', at: '09:00' } ],
    gates: [ { kind: 'workday' } ],
    until: { count: 5 },
    missed: 'skip',
    action: { text: '晨间巡检时间到' },
  }],
}
```

源条目示例：

```jsonc
{
  id: 'wechat-watch', label: '产品群消息监测', enabled: true,
  when: [
    { kind: 'source', source: 'wechat', view: 'news', on: 'rows-added',
      match: { field: 'chat', op: 'eq', value: '产品群' }, cooldown: '10m' },
    { kind: 'source', source: 'wechat', view: 'news', on: 'stale' },
  ],
  gates: [ { kind: 'hours', from: '08:00', to: '23:00' } ],
  missed: 'skip',
  action: { text: '微信有新消息或采集异常，请检查处理' },
}
```

触发器词汇（when 数组，**OR 语义**——任一命中即投递；多个时间触发器并存时条目 next 取各触发器 nextFire 最小值）：

| kind | 字段 | 语义 | 推导 |
|---|---|---|---|
| `once` | `at: ISO` | 单次 | 静态；missed 缺省 `catchup-once` |
| `daily` | `at: 'HH:mm'` | 每日 | 静态 |
| `weekly` | `dow: 0-6`, `at: 'HH:mm'` | 每周 | 静态 |
| `every` | `iv`, `base?`, `jitter?` | 间隔网格 | 见 §四 |
| `source` | `source`, `view`, `on`, `match?`, `cooldown?` | 源事件 | 事件驱动，无时刻 |

| 字段 | 形态 | 语义 |
|---|---|---|
| `gates` | 数组，AND | 时间门：`workday` / `holiday` / `hours{from,to}`（from > to 为跨午夜形） |
| `until` | `{count:n}` 或 `{date:ISO}` 或缺席 | 终结条件；count 按投递次数记账 |
| `missed` | `skip` 或 `catchup-once` | 停机策略；周期触发缺省 skip，once 缺省 catchup-once |
| `jitter` | `'5m'` 或缺席 | 网格刻度 ± jitter 内随机取点，每刻重抖（扰动不累积） |
| `action` | `{text, conversationId?, task?}` | 投递面，宿主安全面持有（v2 原样） |

- 门与源触发：门不命中的事件轮不投（事件丢弃，由下一物化接续）；门不命中的时间刻度直接跳过。
- `source.on` 词汇：`rows-added`（有新行，可带 match）/ `stale`（源陈旧——监控监控者）。
- `match` v1 算子：`eq / ne / gt / lt / in / contains`，单层字段（边界见 §十一）。

## 四、静态推导与 base

三裁决（2026-11-20，用户拍板）：

1. **恒 24h**：一天恒 24 小时，不做 DST / 夏令时特例；23/25h 日的偏差视为可接受噪声。
2. **base 统一形状、不开放**：所有触发器概念上有 base 属性位（缺省 `wall`），但 v1 仅 `every` 消费；daily / weekly / once 自带锚，不开放 base。
3. **once 错过循 missed 裁决**：一次性任务缺省补投一次再归档（catchup-once）。

base 三值与推导公式（owner 时区墙钟）：

| base | 语义 | nextFire 公式 |
|---|---|---|
| `wall`（缺省） | 墙钟网格 | 当日 00:00 + ⌈(now − 当日00:00)/iv⌉·iv；当日网格耗尽则次日 00:00 |
| `{at: 'HH:mm'}` 或 ISO 串 | 显式锚 | anchor + ⌈(now − anchor)/iv⌉·iv（周网格 = 锚日 + '7d'） |
| `'after-last'` | 链式（v2 语义） | max(lastFired, armAt) + iv——含记账，list 标注「链式」 |

- 缺省 `wall` 对齐 cron 心智（`*/30` 就是墙钟网格）；「每小时的 :20」= `every iv:'1h' base:{at:'00:20'}`，无需新词。
- jitter：nextFire ± random(jitter)，下一刻仍从网格推导——扰动不累积（对照：链式起算的抖动会越漂越远）。
- missed 良定义：网格刻度可数——catchup-once 补最近一个刻度后跳未来刻度；skip 直跳未来刻度。
- **断点降级为缓存**：nextAt 恒可由 entry + now 重算；persist 只剩性能优化与时钟跳变检测（重算值与 persist 值偏差过大 → lastNote 告警）。state 损坏不再丢排程语义。
- until.count 可枚举：第 k 次投递时刻 = 网格第 k 刻（wall / anchor），test 静态预览完整成立。

systemd 对应：`OnCalendar=`（墙钟网格）↔ wall / anchor；`OnUnitActiveSec=`（相对上次激活，文档标注会漂移累积）↔ after-last。

## 五、source 行契约（采集层）

source 行 = 用户安装的宿主侧行，自节奏采集外部状态并物化。**采集与探测正交**：采集节奏（行配置）与触发节奏（条目）互不绑架；采集失败只导致导出陈旧，不进 timer 错误退避链。

物化形态（宿主属主目录——**不放 `agents/<id>/files/` 下**：那是 Agent 的 write 可写域，会被用来向另一 Agent 的语境投喂伪造数据）：

```
dataRoot/exports/<source>/<view>/rows.jsonl   # 追加式，行内含单调 seq
dataRoot/exports/<source>/<view>/meta.json    # { generatedAt, seq, schema, staleAfter }
```

- **视图（view）= ACL 粒度**：哪个 Agent 看哪些 chat / 字段，是行配置里用户写的策略，在一切 Agent 视野之外；按视图物化目录。
- 读授权：per-agent inline asset（只读目录路径——授权体系现成词汇）。
- 事件：物化后 emit `source.updated { source, view, seq }`（一次物化一个事件——批量，不逐行）。事件契约住 owning 包，timers 行订阅分发。
- **pull 兜底**：源声明 fallbackPoll 节奏，timers 行兜底扫 meta.seq——push 断了（行崩溃）也有第二通道（§十一）。
- **stale 判定**：generatedAt 超过 staleAfter（源按自身 cadence 的 2 倍声明）→ 订阅该源的条目可经 `on:'stale'` 被唤醒去修。
- 原子写：tmp + rename（timers-row 同款）；JSONL 按行数 / 尺寸滚动，seq 单调；meta.schema 带版本，只增不改字段。

**fs-source（首版包含）**：watch 任意目录物化 rows + 发事件的万能适配器行——配置 `{ roots: [{ root, glob? }] }`，每文件一行 `{ path, mtime, size }`。OS cron / 任意外部工具写目录 → timer 可见，平台零执行。没有它，「任意数据源」要走插件开发全程。

R0b 三问：独立消费方（timer 条目 / 将来 webui 面板）✓；摘除良定义降级（导出停更 → 订阅条目 stale 唤醒或 dormant）✓；独立装载有意义（可选数据源是用户决策）✓。

## 六、触发层机制（timers 行内部）

- **时间触发：setTimeout 自续链**（机制层沿用 v2 资产）：nextFire 纯函数算出，触投后算下一个；远期目标如实排。
- **源触发：push 为主 + pull 兜底**：订阅表（source/view → 条目集）分发匹配；匹配器为宿主内同步纯函数，微秒级，无 worker。
- **per-entry 单链**：next = min(各时间触发器 nextFire)；源触发不挂定时器（事件驱动 + cooldown 状态）。

| 防线 | 机制 |
|---|---|
| 投递风暴 | cooldown 条目级节流：窗口内后续命中不投，但 lastSeq 照常推进（判断不丢，投递节流） |
| 兜底扫描风暴 | pull 兜底受 10s 地板约束 |
| 投递失败 | 退避 1m → 5m → 30m，连续 5 次停排 fail-loud（沿用 v2） |
| 重启 | nextAt / lastSeq 落 state.json；nextAt 可重算（缓存，§四）；源触发按 lastSeq 续读，补不补循 missed |
| 行缺席降级 | 订阅的 source/view 未安装或无读授权 → 条目 dormant（不报错，list 可见） |

- 记账（state.json，结构化——取代 scriptState）：`lastFiredAt / firedCount / lastSeq{source,view} / dormantReason?`。
- 审计行：每次投递 append 一行 `{ at, cause: 'time'|'source', trigger, seq?, matched?, target, budget }`（滚动文件；落位见 §十一）。
- 心跳沿用（诊断面存活信号，不触发任何逻辑）。

## 七、LLM 面与 UI

- `set` = 纯数据写入：schema 校验 + match 算子合法性 + 源 / 视图存在性与读授权检查。**无 dry-run**（无可执行物）。
- `test` = 静态预览：算出未来三次触发点（wall / anchor 完整、after-last 标注链式）；模拟给定事件是否命中（含 match 求值）。
- `list`：每条目 nextAt（时间触发）、事件订阅态 + 源健康（经 source 行服务）、记账、dormant 原因、链式标注。
- `cancel` 原样。
- 权限：set 降敏为普通数据写（不再是「安装持久化代码」）；源订阅受视图读授权约束（未授权视图校验拒）。
- 指南段（ac-agent-loop sections）与 TimerPane：探测循环 / 模式编辑语言 → 触发词汇分栏表单（随实现 CR 换轨）。

## 八、v2 资产清算与迁移

| 件 | 处置 |
|---|---|
| 投递面（envelope / 邮局 / budget / conversationId / task 白名单 / 记账 / 诊断面骨架） | 原样保留 |
| setTimeout 链 / 退避 / 断点持久化 / 心跳 | 保留（断点语义降级为缓存） |
| compileEntry 时间词汇 | 正交化重生为 when / gates / until / jitter（迁移编译器第二次转生，这次是数据 → 数据） |
| code / check / caps 计划 / scriptState / worker / AST 拦截 | 砍——worker 资产归 run_code；code 存量为零（timer.json.bak 先例在） |
| next（verdict 排程） | 变形为触发器静态推导 + 事件驱动 |
| a.state（脚本内存） | 变形为结构化记账；Agent 自定义记忆归 Agent 文件 / 记忆域 |
| gate / gateOnError（exec 预检） | 退役：迁移时丢弃并日志记录；语义判断归 Agent / 源侧 |

旧形态迁移映射（boot 时 timer.json 升 version:3 + bak 备份，同 v2 先例）：

| 旧形态 | v3 产物 |
|---|---|
| time HH:mm | when:[{kind:'daily', at}] |
| time 周一 09:00 | when:[{kind:'weekly', dow, at}] |
| time 定点 ISO | when:[{kind:'once', at}]（missed 缺省补投一次） |
| delay 30m | when:[{kind:'every', iv, base:'after-last'}]（显式链式保行为等价） |
| random min~max | every iv:min jitter:max−min（近似——「不炸、不丢」口径，锚点精确性不追求） |
| workday / holiday 模式 | daily + gates:[{kind:'workday'}] / [{kind:'holiday'}] |
| activeHours | gates:[{kind:'hours', from, to}] |
| repeatCount | until:{count}（与 delay 组合 = every after-last + until，语义直译） |

## 九、与代码的映射点

| 件 | 位置 | 动作 |
|---|---|---|
| 契约 + 触发器推导纯函数（nextFire / 网格 / jitter / missed）+ 迁移编译器 | packages/ac-timer-core | 换轨（TimerCheckFn 族退役） |
| timers 行（匹配器 / 订阅分发 / 记账 / 审计 / dormant） | packages/ac-host-rows/src/timers-row.ts | 换轨（探测循环 → 哑匹配） |
| timer-check-worker | packages/ac-host-rows/src/timer-check-worker.ts | 删除 |
| LLM 面 | packages/ac-host-face/src/timer-face.ts | set / test 语义换轨 |
| 指南段 | packages/ac-agent-loop/src/sections.ts | 文案换轨 |
| UI | packages/ac-client-ui-timer/client/TimerPane.vue | 表单换轨 |
| source 契约 + fs-source 行 | packages/ac-source-core（拟名） | 新建 |
| wechat-collector 示例行 | 独立插件包 | 示例采集行（非首版必含） |

## 十、实施顺序

| 批 | 内容 | 独立收益 |
|---|---|---|
| cr-1161（本条） | 设计稿 + 旧稿归档 | 方向定案 |
| 下一步 | ac-timer-core 契约 / 推导 + timers 行 + face / UI 换轨 + 迁移 | 执行面消失（三病灶全断） |
| 再下一步 | ac-source-core + fs-source + stale / pull 兜底 | 条件唤醒上线 |
| 按需 | wechat-collector 示例行 | 微信场景跑通 |

原「realm 白名单化 / caps 能力注入」预研计划随本设计作废：v3 无执行面，realm 对 timer 不再必要（run_code worker 同款内核的问题独立评估，不随本设计）。

## 十一、开放决策

| 状态 | 事项 | 倾向 |
|---|---|---|
| ☐ | match 算子集 v1 边界 | eq/ne/gt/lt/in/contains，单层字段；嵌套路径与正则不进 v1（防词汇表癌变） |
| ☐ | cooldown 缺省值 | '5m' |
| ◐ | pull 兜底节奏声明位 | 源声明 fallbackPoll，条目只 throttle（不另设条目位） |
| ☐ | hours 门跨午夜细节 | 支持 from > to 跨午夜形（activeHours 同款语义） |
| ☑ | 审计行落位 | `meta/timer/audit.jsonl`（滚动 1MB→.old 覆盖；cr-1164 实现落定） |
| ☑ | base 三裁决 | 恒 24h / 统一形状不开放 / once 循 missed（2026-11-20） |
| ☑ | 源物化面 sandbox 封禁 | exports/ 入读写双禁表 + 分层契约（cr-1165 补——「读全量行 / 写伪造行投喂」两通道封死） |
| ☑ | 视图读授权（消费侧） | InlineAsset `{kind:"source-view",source,view}` + timer set 校验 + timers 分发二道闸 + fs-tools/fs-search 读白名单（cr-1166 落定——编辑器写路径恒不豁免，物化面 Agent 侧只读） |

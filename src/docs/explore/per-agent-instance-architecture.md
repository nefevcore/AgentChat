# Per-Agent 实例架构 —— 设计探索（未裁决）

> 性质：探索草稿，非实施裁决。2026-10-13 会话沉淀（与 cell-runtime 档案同批思路、主线不同：
> 那份谈执行面外移，本份谈会话结构的视角主义重构 + 宿主退化为邮局/监护人；两者兼容——
> cell 是 activation 的物理容器，per-agent 账本是状态层）。状态：留档待议，未过任何评审。
> 仓内相关：cell-runtime-and-architecture-evolution.md（CR-316）、ac-session（writer 队列 +
> 数据根独占锁）、ac-conversation（inbox 双队列 + steer-stash durable）、ac-group（群转录
> 流扇出 cr-4）、ac-workspace（agentWorkdir / 授权目录 = workspace 信任域雏形）。

## 0. 动机与一句话

现架构：全部 Agent 共享一个 cordis host，会话集中、Agent 是数据。痛点：

| 痛点 | 现状 |
|---|---|
| 隐私/回放 | 账本集中，无 per-agent 视角的一等公民身份；群聊只有转录流是 per-viewer 的 |
| 扩展形态 | pairKey 把恰好两方烧进文件名，新拓扑（agent~device、agent~cron）要改键结构 |
| 解耦 | Agent 离开 AgentChat 无法存在——会话必经宿主，CLI 直连不可能 |
| 故障域 | 单 host，一处 in-flight run 全灭（cell 档案 §1 同款问题） |

一句话：**Agent = 自治实例（账本 + 会话状态机 + 工具面），AgentChat = 邮局 + 监护人 + 可选 UI**。
Agent 拥有 per-agent 账本（agents/<id>/sessions/<uuid>/），投递经宿主路由，激活不依赖宿主在线。

## 1. per-agent 实例与解耦

### 1.1 对象模型

```
Agent 实例 = {
  账本    agents/<id>/sessions/<uuid>/    一等事实源，单写者（实例自身或其代理 writer）
  激活    activation（无常进程/子树）：同一 agent 同时只有一个激活实例（单例锁）
  工具面  AgentConfig.tags / include / exclude + 信封展开（resolveEffectiveTools 语义不变）
  身份    注册表数据（agents/ 树）：模型引用、人格、记忆、档案——数据身份与运行身份分离
}
```

- **user = 虚拟 agent**（不变）。user 的账本 = webui 数据源：会话列表、群视图、历史回放 =
  user 账本内容，宿主代管其写入。webui 从读全局 sessions/ 改为读 user 账本。
- **锁的两层语义**：per-agent 锁 = activation 单例锁（防同 agent 双进程）；run 串行仍 per-
  conversation（ac-conversation 串行化门语义不变，activation 内多 run 并行）。现状数据根
  独占锁退役降粒度——多 agent 进程共存从此合法。

### 1.2 解耦：CLI 直连，宿主不在线也能聊

```
  agent-cli 直连形态（宿主缺席）      宿主在线形态（现状超集）
  ┌────────────┐                    ┌────────────┐
  │ agent 子树  │ ←投递/拉取→ 宿主邮局 │ agent 子树 │
  │ loop+tools+ │                    │ 同左        │
  │ session     │                    └────────────┘
  └────────────┘                    webui / 定时唤醒 / 群播 fan-out / usage / credentials
```

两形态共享同一棵子树定义（同源 boot 产物）；CLI 形态只缺宿主侧服务（webui / 定时唤醒 /
群播 fan-out / usage / credentials），会话能力完整。

- CLI 激活 = agent 子树独立进程：cordis 树可裁剪先例已有（MINIMAL_CORE_ENTRY_IDS 截树、
  bootTree 程序化组合），不新发明机制。
- CLI 形态下投递：进程内直调 deliver；跨进程对端经宿主邮局（宿主缺席时消息滞留收件箱 durable）。
- 宿主与 CLI 对同一 agent 的激活互斥（activation 单例锁，跨形态生效）。

### 1.3 消息投递与防自激

- 投递 = 邮局语义：宿主路由 → per-agent durable 收件箱 → 激活后消费。agent 进程死、未激活，
  消息不丢（steer-stash durable 同款纪律）。
- 防自激 budget（MAX_AUTO_WAKES 同款）随消息信封携带（类 TTL / hop-count）——账本分裂后
  per-conversation 计数器无处安放，字段进信封是分布式正解。

## 2. sessions 架构

### 2.1 统一会话形态

```
agents/<id>/sessions/<uuid>/
  header.json      participants（端点集合，含自身）+ 形态标记（user/agent/group/… 开放词汇）
  messages.jsonl   行协议不变：role + agent_id + content（viewer 投影已内建于行协议）
  journal/         partials.jsonl（run 期间台账）+ subcalls.jsonl（子调用档案）——机制照搬
  inbox/           durable 收件箱（投递未消费消息；activation 消费后清）
```

- **uuid 全局共享**：a 侧与 b 侧同一 uuid，否则投递 / #会话 引用 / 跨方定位全部要翻译层。
- **uuid 不编码拓扑**：participants 进 header 元数据，pairKey 退役。全部形态统一为
  agent ~ 端点（端点 = user / agent / group / subagent / 未来 device、cron、workflow…）：
  架构单一、形态可扩展——新拓扑零改键结构。
- **uuid 签发权（2026-10-13 裁决，OPEN-1）**：**发送方签发 + 邮局登记校验制**。
  首条消息的发送方生成 UUIDv7（时间有序——会话列表排序 / 文件局部性友好），随首消息
  投递，uuid 从第一天起就在双方持久化路径里，零往返零回写；续聊在投递前即有稳定键。
  理由链：邮局签发与 §1 宿主可缺席（CLI 直连）内在矛盾——签发必须是不需要许可的动作；
  uuid = 会话出生证明，第一条记录写在发送方账本，按写权=所有权归发送方（§2.2 同则延伸）。
  邮局角色 = 登记 / 一致性校验：首次见 (uuid, participants) 登记，再见校验，不一致
  fail-loud（防身份冒用）；纯直连期间双方账本各自为真，邮局在场时对账。「发送方」实例化：
  webui → 宿主代 user 签发 · CLI 直连 → agent 进程 · 群 → 创建者 · subagent spawn → 父 ·
  存量迁移 → 脚本 hash(pairKey) 确定性代签（幂等，脚本即事实发送方）。已排除：接收方签发
  （时序最劣）；hash(participants) 确定性派生（与同 participants 多会话能力冲突，加序号
  即回中心化）。双方同时互发 = 两会话并存（特性非故障，回复按信封 uuid 路由不串）。首条
  消息原子性：生成 → 写本地账本 → 投递（at-least-once + requestId 幂等），任意点崩溃
  无孤儿。

### 2.2 本体消解：双写不是 bug，是视角

a 账本与 b 账本不是同一份数据的两个副本，是两个视角，互不需要共识，只需要投递语义。
先例：Matrix federation（每 homeserver 持房间事件自己的副本，房间无单一事实源）、Email/SMS。

- 写权 = 账本所有权：a 的账本只有 a 的进程能写；b 发消息 = 投递进 a 的收件箱，a 侧写入。
  每账本单写者队列——ac-session writer/journal/settlement 机制实例 ×N，不发明新科学。
- 群从对象降级为端点：group = multicast 地址表，扇出 = 逐成员投递写各自账本。群转录流
  own/peer 投影从群特例推广为全形态通例——最大的一块现状复用。
- 仲裁无客观记录 → 弱需求（本地单机产品）；要对抗否认，消息带哈希链即可（双方账本互存
  对方发言副本，互为证据）。
- **投影分层（2026-10-13 裁决）**：账本分两层——run 内部记录（思考 / 工具调用参数与结果）
  与终稿（对外发言文本）。字量大头是前者（agentic 会话的存储主体），**归产生方独占**：
  agent 的思考与工具调用只存 agent 自己的账本，对外投递的只有终稿（peer = 包装后的终稿
  文本）。同一条投影规则的两面：思考/工具归产生方 = per-agent 可回放性的来源，同时就是
  不重复存储的机制——回放性与经济性不是两个诉求，是一个投影规则的两侧。可见性是读侧
  投影的事：webui 要给 user 展示工具卡/思考 = 经宿主只读 agent 账本投影，不是写侧复制；
  未来「agent 思考对 user 私有」同理只改读侧规则，存储布局不动。
- **写入时点与职责对称（2026-10-13 裁决，OPEN-2）**：写入职责跟着通信原语走，不跟主体
  身份走——**send()：写自己账本（own 发言）+ 投递；receive()：写自己账本（对端来函 peer
  包装）+ 激活 run，run 内部与终稿全部写自己账本；终稿回复 = 一次普通 send（终稿已在
  账本，send 只投递）；对端收回复 = 一次普通 receive**。没有中心写者，每账本的写者恒为
  本端点的原语调用；「回复」不是特殊事件。双通道同构（邮局投递 / CLI 直连走同一对原语）。
  user 端点无进程 → 必须有壳：webui 形态 = 宿主进程内极薄 user 壳（send/receive 各代持一次
  写入）；CLI 直连形态 = agent 子树内的 user 端点桩。**user 账本的写者 = 当下与 user 通信
  的 agent 实例（的 user 端点桩）——每会话本地写者，非全局唯一写者**。残余 → OPEN-2a：
  webui 与 CLI 同时活跃（两个壳并发写 user 账本）的仲裁——候选：user 账本也走单写者
  队列合并（邮箱合并语义）或 activation 锁扩展到 user 端点。

### 2.3 代价与开放问题

| 代价 | 处置 |
|---|---|
| 存储膨胀（1v1） | **远小于 2x（2026-10-13 修正）**：重复的只有对话终稿层；字量大头（思考 / 工具调用与结果）归产生方独占（§2.2 投影分层）。agentic 会话中终稿通常是个位数百分比占比。群聊现状已是 N+1 份（本体+N 转录）、新模型 N 份反而少一份；群转录流现行经济学（cr-4 扇出不复制各成员 run 内部）即先证 |
| journal / compaction / 归档 per-agent 实例化 | 机制照搬，工程 ×N 实例 |
| 新成员入群无历史（极端沉默权） | 要历史 = 从老成员账本投影回填（一次性导入语义）；隐私上甚至是 feature |
| 跨 agent 能力改写 | session-query（多根搜索或收敛为 agent 只搜自己）、backup/archive 枚举 agents/*/sessions/ |
| webui 读面迁移 | user 账本 = webui 唯一数据源（会话列表 / 群视图 / 回放） |
| webui 群视图合并 | **无需合并（2026-10-13 裁决）**：user 虚拟 ≠ 无账本——user 是群成员，扇出天然把每条发言投进 user 账本（own/peer 投影通例适用），webui 群视图 = 读一份账本的单读者单投影，不存在 N 方合并步骤。推论：可见性 = 成员资格（user 不在场的群在 user 账本中不存在 = 正确的不可见）。残余：全知视角（审计/调试）唯一正当消费者是宿主——邮局经手全部投递，需要时留投递台账（运营日志，非会话账本）；N 方合并只在多宿主联邦才是真问题（远期） |
| 与现状单向兼容 | 存量 sessions/<pairKey>/ 迁移：一次性脚本 + 恒等门测试（仓里 migrate 三件先例） |
| 消息丢失模型 | 投递 at-least-once + 接收方幂等（requestId 准入去重，cr-250 机制复用） |

## 3. 模块热插拔与宿主自进化

**动机（2026-10-13 补）**：本节的存在理由不是工程美学，是 RSI——Agent 在会话中可直接重启
系统并观察变化，无需人类介入推进宿主端（AgentChat）自进化。解耦（§1）是它的使能条件：
宿主重启从「全场死亡」变为「邮局暂时关门」——agent 进程与账本独立存活，宿主重启只是会话
里的一次可观察事件。

### 3.1 能力阶梯（现状盘点）

动态能力进出的正解不是换代码，是换注册项（数据）。三层阶梯：

| 层 | 动作 | 粒度 | 生命周期 | 现状 |
|---|---|---|---|---|
| L0 注册表面 | defs.set/delete（tools 服务） | 单工具 / 单 provider | fiber 归属 effect | 已实现 |
| L1 插件实例 | ctx.plugin / fiber.dispose | fiber（插件实例） | fiber 树 LIFO | 已实现 |
| L2 代码热换 | 动态 import + ?t= bust / hmr loadCache 驱逐 | 模块图子集 | reload + 回滚 | 部分实现 |

### 3.2 五步闭环（对朴素三步走的修正）

朴素三步（backup → 卸载 → 装载）中，cordis 已把 2、3 焊成原子：Entry.update / fiber.update
是事务化的 dispose+start（失败自动 restore 旧 fiber），reloadFiles 带模块级回滚——不存在
「卸了没装上」的中间态。真正缺的是前后各一步：

| 步 | 内容 | 形态 | 现状 |
|---|---|---|---|
| 0. 版本指纹 | 我现在跑的是什么 | git commit + dirty 标记 + 行集内容 hash（cordis.yml ∪ patch） | 缺（cell 档案 §5 点名） |
| 1. 快照 | 失败可退 | **快照链（last known good）**：只在验证过健康的状态拍（boot 成功 + 冒烟过）；覆盖面三层——代码（git/backupDir）+ 结构状态（cordis.patch.yml / registry.json / 熔断计数）+ agent 包（AgentConfig + 动态插件版本）。结构回滚 = 行 disable（patch+熔断，已自动化）是快照链的第一道闸 | 部分 |
| 2+3. 换装 | 卸载→装载 | cordis 事务原子（Entry.update / reloadFiles） | 已实现 |
| 4. 观察回执 | 变化已生效/失败 | **双向**：成功 = 新宿主 boot 后向存活 agent 注入指纹 + 行状态 + 熔断态（context-injected 机制复用）；失败 = 回退快照后注入「升级失败，已回退至 <指纹> + 原因」——agent 下次会话从账本读到回退史 | 缺 |
| 5. 验收/回滚判定 | 新版本好不好 | agent 自判（会话续跑 + bench 门，cell 档案 §8 同款） | 缺 |

裁决：**backup 减负**——自进化不要求每次变更前全量快照；supervisor 只守一件事：结构回滚
机制本身（patch 文件 + 熔断）不可被热插拔触碰。内容回滚是 agent 的活，走普通工具调用。

### 3.3 相互恢复环（mutual recovery，2026-10-13 改判：成环）

相互重启**成环**是设计意图，不是事故。环的处置语义是 **rollback 不是 retry**——这使环收敛：
每次回退指向 last known good，路径有限步终结（retry 环才不收敛：坏版本被反复拉起）。

```
边 1（宿主 → agent）：agent 升级坏 → 宿主拉起失败 → 回退 per-agent 快照（AgentConfig +
                      动态插件版本）→ 拉起旧版 → 注入「升级失败，已回退至 <指纹>」
边 2（agent → 宿主）：宿主自进化坏 → agent 发现邮局失联/健康探测失败 → 回退宿主快照
                      （git/backupDir + 结构状态）→ 拉起 → 收新宿主观察回执
```

- **安全性结构前提**：两侧死亡不互相传染（per-agent 进程 + 独立账本——宿主死 agent 活，
  反之亦然）。同时死 = 环两边均无执行者 → 落保底（用户手点 / supervisor.mjs 冷启动），
  不属环的职责。
- **权限面论证**：单机本地产品，能改 AgentChat 代码的 agent 必有 full/dev 档——该档位
  本就能跑任意 shell，任何「禁止拉起宿主」的软闸一行 spawn 即绕。防的是 base 档误操作，
  从不假装防 full 档。故「agent 拉起宿主」无需新权限概念，是既有权限面内的普通操作；
  唯一保留 = 并发拉起仲裁（数据根独占锁 fail-loud，非权限是并发，机制已有）。
- 保底：supervisor.mjs 为第三方冷启动通道（进程层脚本，不经组合根，现状已如此）——
  环失效时的最后手段，与环并存不冲突。

### 3.4 逃生门 = 快照链（形态改判：清单 → 两原子）

逃生门不采「承重件禁区清单」形态（清单会漂移、会挡正当迭代、要人工维护），采**快照链**形态。
快照成为合格逃生门的四个性质：

1. **快照点 = last known good**：只在验证过健康的状态拍（boot 成功 + 冒烟过）——不是任意
   时刻备份，是健康检查点；否则回退也白回。
2. **覆盖面分层**：代码（git/backupDir）+ 结构状态（cordis.patch.yml / registry.json /
   熔断计数——回退代码不回退结构会出现新代码读旧结构、该 disable 的行又被启用）+
   agent 包（per-agent 快照）。
3. **配套纪律 = 盘上格式 additive-only**：回退即「旧代码读新数据」——行协议 / 配置格式只加
   不改，旧版读新版数据必须不炸（cell 档案 §6 宪法层同款）。
4. **最小守护件 = 两个原子**：快照链本身 + 回退通道（拉起/重装机制）不可被迭代改掉，
   物理外置于变更面（快照目录 + supervisor 拉起脚本）。清单从一串承重件缩减为这两条——
   「进化器不能进化逃生门」精神不变，形态从枚举变为原子外置。

### 3.5 待定项（诚实清点）

- 亚插件粒度热换：fiber 是生命周期原子、注册表是热换原子——比 fiber 细的热换，唯一出路是
  薄壳行（稳定）+ 注册表条目（易变）；「薄壳行内能力各自开子 fiber + 动态 import」需要行结构
  大改（行内共享状态被迫出走），收益待评估——待定。
- vendor 改动面：本架构不要求改 cordis 核心；可能要动 vendors 的两处——include 行对
  per-agent 子树的挂载路径解析（多级子树）、hmr root 数组按 workspace 过滤——均待定，
  先以最小 spike 验证。
- 触发形态：watcher 自动 / reload_modules 工具 / market 装载——已有形态照用。
- **亚插件粒度热换（2026-10-13 改判：非框架缺口，属主侧模式选择）**：cordis 源码勘察
  （fiber.effect / DisposableList / Fiber 构造器）证实三层注册表嵌套——ctx.registry
  （callback→runtime）→ runtime.fibers（DisposableList）→ fiber._disposables（DisposableList：
  有序 + O(1) 按值删 + push 返回 remover）。子 fiber 的 dispose 本身是父 fiber effect 表的
  一个条目（插件树 = 注册表套注册表物化）；effect 执行期子注册经 collect 移交形成 effect
  树（getEffects() 可取诊断树）。「拔」半边原生闭合：dispose 单个 effect 条目 = 调 wrapper
  disposer，O(1)，不重启 fiber。「装/换」半边三个精确缺口全在属主侧：① effect 无名寻址
  （label 仅诊断，键 = 插入序号 + 对象身份）——按名替换需属主持有 disposer；② 无「重执行
  第 N 个 effect」——effect 是闭包不是数据，重注册 = 属主重调注册函数；③ ESM 绑定——新代码
  仍需动态 import + 缓存驱逐。模式 = dispose 旧条目 → 动态 import（?t= bust）→ register
  新条目，零新原语、零 vendor 改动；剩余裁决只是行要不要长成「薄壳 + 能力模块 + 持有
  disposer / 暴露 reload 入口」形态。

## 4. cordis 的角色（关键设计）

cordis 是当前非常契合的工具、必要时可改动 vendors——在仓库语境里的精确含义：

1. 核心 API 恰好就是本架构需要的形状：ctx.plugin() / registry.delete() = 运行时插拔原语，
   fiber 树 + effect LIFO = 所有权模型，isolate / intercept = per-agent 作用域，Reflect 服务
   模型 = 服务晚绑定。per-agent 子树 boot、activation 单例、跨进程投递全建在这上面，不发明新框架。
2. vendor 不需要大动：多 agent 子树 = 多 EntryTree 挂 root 下（零改动）；include 行已支持多级
   子树；hmr 行 root 数组可按 workspace 过滤（一行 config 改动）。
3. 必要时可动 vendors 的清单（穷举）：① include 行多级子树挂载路径解析（若采用宿主树
   include 每一 agent 子树形态）；② hmr root 过滤（若采用 hmr 行 per-cell 单实例形态）。
   两处均为生态行改动，不触 cordis 核心三红线（fiber 状态机 / registry 键控 / effect LIFO）。
4. agent 子树与宿主树的边界：agent 子树内不 boot 承重行（ac-security / plugin-gates /
   durable-interaction / usage / credentials）——门禁链不出控制面，工具执行恒回宿主（代理
   stub + RPC），agent 子树内只跑纯计算工具。解锁 CLI 直连的代价是 agent 子树要带最小安全面。

## 5. 落地路径（每步独立可验收）

1. 会话形态统一 spike：群转录流机制推广到 1v1（a、b 各持 own/peer 视角账本，投递写对方）+
   user 账本喂 webui 群视图。不依赖进程模型，单宿主内验证语义。验收：单宿主内 1v1 双视角
   账本 + webui 群视图跑通。
2. activation 单例锁 + agent 子树 CLI 形态：最小 agent 子树（L2 loop + L1 + session）独立
   boot + 直连对话。验收：宿主不在线，agent-cli 可与 agent 完成多轮会话；同 agent 双方
   抢锁互斥。
3. 宿主邮局化：投递面经宿主路由 + per-agent durable 收件箱；跨进程对话跑通。验收：跨进程
   1v1 与群播 fan-out。

## 6. 本档案纪律

- 探索档案（explore/）：非裁决、未评审；立项时迁 src/docs/ 正式目录并过评审。
- 触发再讨论的问题清单：新成员入群回填、MCP 服务器归属（agent 子树 vs 宿主）、subagent 树
  （子树中的子树：spawn 会话的账本归属与工具面继承）。（webui 群视图合并已于 2026-10-13
  裁决出局：user 虚拟端点照常记账，群视图 = user 账本单投影，见 §2.3。）

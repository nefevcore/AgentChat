# 行集设计 · 裁决簿

> 性质：host-shell-row-manifest.md（设计规格）的裁决与论据档案——推导过程、
> 定向理由、判例、账目修正史、批次演进索引。正文只陈述终态，「为什么」住本簿。
> 2026-10-15 建立（v3 设计 / 裁决分离）。条目 = 篇名 + 裁决日；正文按篇名引用。

# 〈行资格判例〉（2026-10-15，v2 立）

R0b 三问的原理：行的资格 = 插槽-插头原则 + 机制归位表的推论——立行是例外不是缺省。
判例五则：
1. **activation 锁**：boot 步骤非行——进程内时序属编排代码；「行序表达依赖」
   是架构红线，锁先于账本同理。
2. **指纹**：两侧同算法 ⇒ 唯一自然形态 = 共享纯库；宿主消费点 = guardian verify
   节拍，壳消费点 = boot stdout 自报。设双行逼出双实现漂移，与两形态同根断言
   （R-7）相悖。
3. **授权投影**：纯函数；门 = 工具调用 waterfall，tools 行注册即得。「无门禁壳」
   非合法降级——门禁是壳必备件。
4. **群拓扑**：multicast 地址表是数据；扇出是邮局职责；编辑是 webui 卡片。三去处
   各有其主，行消失。
5. **Agent 在场性**：活注册表把「配置是什么」（静态）与「谁在场」（动态）捏在
   一起——两轴分离后配置轴 = 数据根文件文集，在场轴 = guardian 可达表。宿主管理
   agent = 编辑 + 派生 + 投递 + 监护，无一需要活注册表（「Agent 是数据不是插件」
   的兑现形态）。

# 〈新增件资格判定〉（2026-10-15，v2 立）

v1 的 12 项新增标记逐项过 R0b 三问，8 项改判非行：activation-lock → boot 编排；
fingerprint ×2 → ac-fingerprint-core + guardian 节拍 + boot 自报；agents-readonly →
ac-agents-core（与 credentials 直读同构同判，v1 内部矛盾修正）；user-stub →
conversation 行内（激活仪式化，R-2）；usage-report → ledger 行内（journal 计量 =
账本邻域）；snapshot-chain → backup 行内（分轴不分行）；security-exec →
ac-auth-core + tools 门。立行者 4：邮局 / 监护 / 授权注册表 / 账本（各为独立
关切 + 各有消费面）。

# 〈timer 归属〉（2026-10-15 定向）

**timer 基座不进壳树。** 壳内禀定时（心跳 / run 超时 / 防自激监测）= unref 本地
原语（boot 侧工具函数，绑 fiber dispose、不钉事件循环）；持久定时唤醒恒宿主
timers 投递信。理由三条，任一即否决：
1. vendored cordis-timer 无 unref（ctx.effect 绑 fiber 生命周期但活跃 interval 钉住
   事件循环）→ idle-exit（D2/S2）失效或退化为监护强杀；
2. 壳内到点直调 run = 唤醒双源，侵蚀「唤醒 = 投递信」（R-1/R-2 与 budget 防自激
   闭环）——便利面一旦存在就会被用，补丁式便捷累积腐化；
3. ctx.interval 纯内存态，壳被收割 / 崩溃即任务蒸发；宿主 timers 落盘，重拉照常
   触发——持久性放宿主、壳做无状态执行端。

# 〈jobs 归属〉（2026-10-15 定向）

**宿主不设 jobs 基座。** 归属判据 = worker 进程父级 × 通知消费面，三场景：
1. 壳内 job（pwsh 超时 handoff、run_code worker——worker = 壳子进程）→ 壳 jobs 行，
   完成 = 进程内事件直投本壳 inbox（sender:'event'、budget 递减，与现状 deliver
   同构，不经邮局）；
2. 跨壳 job（子 agent → 父会话）→ 邮局信（普通 message，跨进程边界走投递原语）；
3. 宿主自有异步（backup / archive 定时）→ timers + 宿主 async，无注册表面。
伴生语义：壳死 = 其 job 随之蒸发（生命周期归属 activation，与「账本永存、进程
生灭」分层一致）→ idle-exit 判定加第四条件「无在途 job」（协议规格 D2）；
job-wakeup 三投递策略随迁壳 jobs（digest 窗口聚合 / killedBy='owner' 跳过 /
sub owner 不唤醒）；webui 观测 = 壳 started/settled 自报快照信 → 宿主聚合镜像
（只观测，usage 同构）。

# 〈webui 读投影〉（2026-10-15 定向历史读与流式；2026-10-16 定向 user 账本聚合）

三拆：
1. **历史读**：宿主文件直读（JSONL 追加式天然支持增量 tail）+ fs watch；不设常驻
   读服务行（= ac-session 宿主侧复活，镜像追平 / 崩溃恢复全套复杂度，与 D4 写权 =
   所有权相悖）。残留仅 watch 选型 / 列表索引等实现细节。
2. **流式增量**：run 进行中的 token 经**宿主转发**（壳 → ipc → 宿主 ws-bridge →
   webui），不设壳直连端点。四论据：① 单一安全边界（N 壳 = N 个带工具执行能力的
   端点对浏览器可达 vs 单出口单认证——A1 加固同构）；② 连接风暴吸收（壳 15min 生灭
   + 按需重拉，浏览器恒持一条连接、壳生灭对前端不可见）；③ 远程形态免费复用
   （relay 本就经宿主出，壳直连在远程形态不成立）；④ webui = 宿主自有表面（R0a）
   已裁。开销不构成约束：并发活跃流是稀有态（idle-exit），单流 &lt; 25 KB/s、
   现实峰值 ~1 Mbit/s vs 通道 GB/s 级；合并窗口（30-50ms）是保险旋钮非结构风险。
   流式帧 = **瞬态旁带**（非信封，协议规格 B3）：不入发件箱——半截流重复播放比
   丢弃更糟，客户端从账本收束态对齐；生命周期 = run。
3. **user 账本聚合**：**形态二——user 独立账本，仅终稿层（own/peer 投影分层）**。
   字量大头（思考 / 工具调用与结果）归产生方独占，重复的只有终稿层（agentic 会话
   个位数 %；群聊 N+1 → N 反而少一份——母档案出局条既有结论）。八形态比对淘汰：
   全量抄写（撞投影分层出局条 + steps 跨树批量写破 per-账本单写者）；读侧聚合
   （N 方合并复活——出局条论据依赖 user 账本在场；D2 为 user 破例 own 无处写；
   可见性索引本身即物化账本）；缓存降格（user 删会话后从 agent 账本重建 = 数据
   复活，删除日志等于重建账本；对称保留语义——user 的对话记录是 user 的数据，
   非 agent 数据的缓存）；台账切片（违两形态同根；投递序 ≠ 会话序）；常驻聚合行
   （#1 已裁死）；借成员账本（user 视图存亡系于 agent 保留策略）。写者循 R-2
   已裁语义（webui = 宿主 user 壳，单进程天然串行；CLI = agent 子树端点桩，
   R-2a 队列）。webui 需 user 视角展开对方思考 / 工具内容时，按 run 键关联
   agent 账本文件直读带出——取值逻辑细节，不另立承载。

# 〈装配期派生〉（2026-10-15 定向）

**壳行集 = 装配期派生清单，cordis.yml 降格为行全集目录 + 宿主树装配。** 推导器
= ac-rowset-core 纯库（宿主 boot 现算，argv 传引用；CLI 直连形态本地派生——两
形态同根断言要求推导同构）；AgentConfig 入指纹输入（行集变 = 指纹变 = 该重启壳，
R-7 闭环）。裁剪两级：行级 = 装配期（派生清单）；行内工具级 / 授权级 / 会话级 =
运行时门（tools 门 ∩ auth 投影；conv-settings 会话开关——会话粒度 &lt; 进程粒度）。
per-agent 软门（enabled 键 / agentGate facet / event-policy 停用）壳内退役，「不装
即无」取代「装了但门着」；宿主树保留全局治理门。语义变化：软门热切换 → 装配冷
生效（S5「换版本 = 重启壳」同族；idle-exit 让壳短命 + 200ms 冷启动）。动态插件
（install_plugin = 授权动作）→ 壳行集条目注入：第三方代码进 agent 自己的壳进程，
零宿主驻留（S2）——隔离从自律规约变物理。

# 〈tag 目录静态化〉（2026-10-15 定向）

**ac-tag-registry 退役。** 定性修正：它不是「简化的 ac-config」——config 是 state
（用户想要什么，输入），tag-registry 是 view（系统有什么可配，投影）。catalog
三源（RESERVED 词表 / 各包 tagDeclarations / 工具 defs.requiredTags）本质全是
静态元数据，「运行时现算」只是采集手段，依赖「宿主进程恰好在跑」的隐形前提——
新架构下编辑面必须在壳 idle-exit 死掉时也能配 tags，前提失效。去向：catalog →
ac-rowset-core 静态目录投影（per-agent 化——目录质量升级：只出现该 agent 行集
内的词）；启动断言 → boot 编排纯函数；TagDeclaration 类型随迁；tags/catalog RPC
数据源切换，AgentPane 消费面不变。运行期真需现算时 defs 本身是事实源，无需第二
聚合服务。

# 〈注册表解体〉（2026-10-15 定向）

**ac-agents 活注册表退役，per-agent 管理转向配置文集。** 现状 ctx.agents 把
配置轴（静态）与在场轴（动态）捏在一起；两轴分离后配置轴 = agents/&lt;id&gt;/
文件文集（文件即注册：宿主编辑面写、壳 per-run 直读、邮局存在性 = 文件系统探查、
显示名读配置），在场轴 = guardian 可达表——活注册表无剩余消费者。三机制解体：
register → 文件即注册（预设行 / agent-store 两个注册方消失）；物化 → 拆
create-from-template（编辑面从模板写文集，skip-if-present = 用户数据优先的文件版
语义）+ transient boot（宿主从模板合成 argv 传临时壳，账本住 sessions/&lt;uuid&gt;/
不落 agents/ 树）；reassign 热更 → 被〈装配期派生〉R7-8 裁向覆盖（模型变了本来
就该重启壳）。ac-agent-presets 目录静态化（包元数据声明）归并 agents 编辑面行；preset-builtin 残留 ◐（静态声明面承载方式）随之消解（2026-10-16）：内置模板 = 包目录下的静态 Agent 配置文件集，编辑面 create-from-template 直读，无需独立承载机制。
ac-agents 本体拆三瓣：词汇纯函数 + AgentConfig 契约 + settingsOf 纯函数化 →
ac-agents-core；注册表服务退役；widenToolsForGating 去 ctx 化（defs 作入参）。

# 〈骨架归并 webui 本体〉（2026-10-16 定向）

**ui 骨架六件（theme / renderer / tool / conversation / settings / layout）
并入 webui 本体，phase:'base' 封印批次机制随归并退役。** 勘察：六件宿主半边
= 零行为 declareClient 桩（各 2-3 KB；视图资产 109 文件 ~1.1 MB 全在 client/
半边，conversation 843 KB 为大头）——行资格三问不过：良定义降级 ✗（base 件
卸载 = 整页重载，M27.2 §3.2 自裁「基础件不可动态回收」——桩是大迁徙脚手架，
非终态设计）；webui = 宿主自有表面（R0a-2），骨架是地基非可摘能力域，「域卡片
回落」语义对骨架无意义。四案比对：C 维持 = 6 行行政成本；A 并包 = base 集合
边界二次裁决 + 六件内部依赖（conversation × renderer 边界正是 M28 拆分成果）
重新粘合；B 并入 = 资产迁 src/webui/，phase 机制无残余消费者（域行装载冷生效
已裁〈装配期派生〉）。**扩展面压力测试定案**：第三方自定义四车道（令牌 /
席位贡献 / 新席位声明 / 换骨架）——①②③车道住 slot 系统（SlotCore +
SlotRegistry + declareClient 通道），与骨架物理形态正交；④车道对第三方在新
架构恒死（S2 第三方零宿主驻留），行级换骨架只对仓内开发有意义 = 改 webui 内部
模块等价。C 多付成本买不到任何第三方能力。迁移工程序沿 M27.2 纪律（件件视觉
门全绿再迁）。

**webui 表面单包化（同日终态补充定向）**：勘察确认「webui 表面」散在四处
物理位置——src/webui/（前端壳 137 文件 852 KB）、ac-webui/（服务行）、骨架
六包、ac-webui-extensions（M30 D7 退役残留词汇锚点）。裁决：**一个表面一个
物理实体**——终态 ac-webui 单包：src/ 服务半边（路由 + service + boot graph
下发）+ client/ 前端半边（main.ts + runtime 胶水 + isolated-runtime + 骨架
六件资产 + slotCatalog）。src/webui/ 目录消融、ac-webui-extensions 消融入
client/；骨架归并落点与双址残余同时钉死。webui-kit / ac-client-runtime /
ac-client-slots 不属 webui 表面（域行 + 第三方共享的前端基座，性质同 Vue
本身）。R7-9 通道执行端落点随之落定（ac-webui/client/ runtime 拉图装载）
——**包是常量（表面），内容是变量（域行 / 第三方经通道进）**。行集与对账
零变化。

# 〈插件 client 通道〉（2026-10-16 立项定向）

**用户插件完全自定义 UI = 主线能力；项目 ui 行同走此通道——唯一通道，不为
第一方开特权路径。** 机制骨架：client 半边 = manifest **数据**声明（entry /
platform / 席位贡献拓扑），第三方零宿主代码（S2：注入 = plugin-registry 读
manifest 数据进 boot graph，非执行第三方 apply）；资产静态服务已建（ac-webui
/ui-plugin/:name/* 路由）；安装 / 卸载 = manifest 出现 / 消失 → 前端 boot
graph diff 热装载（phase 机制退役后单一动态语义——与〈骨架归并〉协同）。自定
义阶梯：① 令牌 / theme；② 席位贡献（tool-card / dock / settings 节——现行
域行主车道）；③ 新席位 + 拓扑贡献（layout 视角 / 席位拓扑贡献开放度——「完全
自定义」达标线）；④ 独立面板 / 整页。**项目收敛方向**：ac-client-ui-* 桩行
退役——领域包 manifest 声明 client（D19「行包自带 client/ 半边」的 manifest
数据化形态），ui 域行随通道建成逐批退出宿主树（R1 ui 组行数届时改写；无后端
行件如 ui-run-nodes 以纯前端包形态同通道）。待设计 ◐：manifest schema、注入
与安装语义、拓扑贡献开放度、存量 25 域行收敛批次——设计档案另立（R7-9）。

# 〈ui 树定调〉（2026-10-16，cr-478）

webui 大讨论收束（骨架解构四轮 + 工作区语境重估），全文住 ui-tree.md。要点：
① ui 树 = 第三棵装配树（与宿主树/壳树四要素同构：行集/boot/注入/降级 + 版本切换
第五要素；信任/生命周期/写权三处显式异构）；② 骨架 = 协议持有者（layout 拓扑契约、
theme 词汇契约、renderer 渲染协议）——conversation/settings/tool 转模块、renderer 剥
markdown 管线成 markdown-render 模块、theme 契约化（data-theme 预留 + 完备性规则）、
layout 拆拓扑契约/形态壳（变体层）；③ 模块判定按功能模块非后端有无——一份 manifest
三树投影；④ workspace 七面核查收口：③⑤⑥ 重组 ac-files 模块（修正 cr-474 前议的
「并入 webui」——按模块判据），② 纯库化入 ac-sandbox-core，⑦ 能力语境面 = 壳行运行
时读面；⑤ 工作区 = 第三输入源（per-conversation，永不进指纹——单例锁与装配期指纹
互斥的推论）。R7-5 / R7-9 待钉面细化至 ui-tree.md §5-7。

# 〈账目与修正史〉

- ui 族账目：v1 记 27，yml 实数 31（25 域行 + 骨架 6）——v2 修正。
- 恒等式算误：cr-446 曾把 tag-registry 同时计入退役与归并（48+35≠82）；cr-449
  纠正为退役 3 / 归并 11 = 82 = 47 + 35。
- v1 → v2 差异：壳树新增 7 → 1（ledger）；宿主新增 5 → 3；12 项新增标记 8 项
  改判非行。
- 「并后宿主 42」算误（cr-474 修正）：R1 组件和（3+3+3+5+4+3+1+25 =
  47）本不含骨架（ui 25 = 31 − 6，对账 −6 已生效），并入不改行数；42 无成立
  读法（A 形态应 +1 = 48、维持 = 53）。

# 〈批次演进索引〉

- cr-439（2026-10-15）：v2 重写——R0b 行资格测试，立行 12 → 4，归并 17 退役 3。
- cr-441：协议规格 A4 inbox 边界 + F-8 budget 链式语义（防自激必要性推演落地）。
- cr-445：装配期行集派生（ac-rowset-core + R7-6 两级定向 + R7-8 生效路径）。
- cr-446：tag-registry 退役归并。
- cr-449：agents 活注册表解体 + presets 目录静态化；恒等式算误修正。
- cr-451：R7 待钉清理（timer 定向 + 定时纪律回填 R3）。
- cr-453：jobs 归属三场景定向 + idle-exit 第四条件。
- cr-455：流式增量定向宿主转发 + 协议规格 B3 旁带帧。
- 本批：v3 设计 / 裁决分离重写（本簿建立）。
- cr-470：preset-builtin 静态声明面承载 ◐ 消解（补〈注册表解体〉尾句，清单同步摘 ◐）。
- cr-471：user 账本聚合定向形态二（R7-3 收口，〈webui 读投影〉三拆齐）。
- cr-474：R7-4 骨架归并 webui 本体定向（B）+ 插件 client 通道立项（主线能力 +
  项目桩行唯一通道收敛）；「并后宿主 42」算误修正。
- cr-476：webui 表面单包化（〈骨架归并〉双址残余收口；extensions 消融）。
- cr-478：ui 树定调 + 工作区语境 + workspace 七面收口 + 骨架 3+4 解构（ui-tree.md 立；清单 R7-5 收口）。

## 本档案纪律

- 探索档案（explore/）：裁决簿随正文同批演进——新定向先入簿（论据全文），正文
  只改终态行与状态板。
- 引用规则：母档案依据写 R-n / D-n / S-n；本簿条目按篇名引用。
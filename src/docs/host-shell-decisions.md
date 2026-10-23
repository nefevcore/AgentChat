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

# 〈tag 机制解体〉（2026-10-16 定向，cr-484）

**tag 机制全链退役（方案 A）。** 导火索：R7-6 重工具行按需 boot 议题发现
1:1 行词（sap-adt / harness / issue-report / dev）在壳模式下与行集开关语义重合，
提出「放弃 tag」；深查后定性升级为职能过载——现状 AgentConfig.tags + 工具
requiredTags 的全局扁平词汇同扛七职能（行装载信号 / 跨行捆绑 / 行内档位 / 授权
资产引用 / 双闸声明面 / tier 档位词 / owner 私有词），per-agent 壳 + install =
授权动作两裁决联手后，无一职能仍需全局扁平词汇承载。方案比对：A 全解体（七职能
归位）/ B 中间态（1:1 行词退役、横切词保留）/ C 维持草稿（双闸不变）——裁 A：
B 留下一层继续过载的词汇；C 接受七职能过载。与既有裁决关系：不推翻任何一篇——
〈tag 目录静态化〉退役的是聚合行，本篇退役词汇本身（承其未尽，非否定）；E 节
「tags 不动」是复用清单平移项非专项裁决，本篇为其上位修订。

**七职能归位：**① 行装载信号 → 行集派生（AgentConfig 引用行 = 装即声明，行集
谓词：点名工具 ∨ 引用行名）；② 跨行捆绑（fs / infra）→ 行集派生内消解（引用
fs-tools 或 fs-search 均装载两行）；③ 行内档位（web+observe AND 地板 / collab
admin 子集）→ 行自身词汇（settings 具名扩展 X1 / 行 config，行 owner 自治）；
④ 授权资产引用（AssetRef.tag）→ 行引用资产（install = 授权动作同语义，静态行
补齐同款 AssetRef.row）；⑤ 声明面双闸 → 行集 ∧ 授权投影（C1 换词汇不换强度：
全局授予只对装了该行的 agent 生效，双闸形状不变）；⑥ tier 词（full-access /
sandbox-access）→ 权限档位轴词汇，非 tag（本来就不进 requiredTags，正交轴）；
⑦ owner 私有词（agent:<id>）→ 行集隔离物理覆盖（install 是 per-agent 授权动作，
装进 owner 自己的壳；共享 = 他人各自 install）。

**连锁消解：** R7-6 消解（装载信号 = 行引用，无特例；「默认胖瘦」降格为默认预设
模板含哪些行的产品题）；requiredTags 全链退役（「装了即可见」即语义，base 等价词
随之消亡；mode 词断言消解）；resolveToolNames tag: 展开改轨为行展开（M15 词形
修订）；UI 徽章 / canAddTool / tagExclusive 改读行集与授权投影。遗留子项两枚 ◐：
a. 行内档位词统一形态（web observe/manipulate、collab admin——settings X1 vs 行
config，倾向 settings）；b. 现状 192 处 requiredTags 迁移批次（行内档位词改挂行
config，删除工具 requiredTags）。

# 〈patch 机制退役〉（2026-10-16 定向，cr-485）

**patch 机制整体退役，两树同形 boot。** 议题源：R7-7（patch 归属：宿主专属 vs
两树各持）。初判 A（宿主专属）的两条支柱被「壳可独立拉起，为什么 boot 要是
cordis.patch.yml」一问拆穿：①「宿主树唯一合法运行时写入口」把机制当必需——宿主
树要的只是停用行能力，loader patch 只是现状实现；宿主树 = 固定第一方行集（47 行
无第三方，S2），全部可变性 = 减去用户停用行，与壳行集派生同构；②「急救通道需要
patch 层」实为需要**带外可写**（级联死后仍可改）——偏好文件人可读手编 + RPC 写
文件，带外性质不变（webui 本身死 → 手工编辑 = 现状真盲区处置不变）。现状反证：
cordis.patch.yml 消费者仅两宿主启动器 + 测试；boot.ts 内联官方 bin.js 的唯一理由
就是注入 patches（M23 A2）——机制退役后宿主 boot 可回官方路径。B（两树各持）在
〈装配期派生〉已死：壳行集双来源无解。

**终态：boot 形态全域单一 = 清单驱动装配。** 宿主：数据根一份宿主行集偏好文件
（形状沿用 {id, disabled}，人可读手编）→ ac-rowset-core 派生宿主清单 → 装配；壳：
argv 派生清单 → 装配。cordis.patch.yml / loader patches 注入 / 热通道
（setPatch 动态装卸）/ patch-rpc 形态（plugin/patch-list·patch-set·patch-reset）
全退役。急救能力保留：带外行位不变（级联存活设计），写目标 = 宿主行集偏好文件，
恒冷生效——宿主重启走 guardian 重启入口（壳进程独立存活、数据全在文件，宿主重启
变便宜 = 新架构红利）。代价：停用宿主行从热变冷（重启一次）——宿主行变更低频，
接受。「行集唯一来源 = 派生」从壳推广到全域；与 R-7 两形态同根同族（宿主与壳
同形 boot 是该断言在装配面的下半句）。遗留 ◐ 一枚：宿主行集偏好文件的 schema
细节（是否兼当 CLI 直连形态的宿主清单源）随 ac-rowset-core 设计落。

# 〈D10 会话查询收敛〉（2026-10-19，cr-544 立）

**裁决**：session-query 收敛为 **agent 只搜自己**——工具面只有本 agent 自己的账本
（`agents/<id>/sessions/<uuid>/`，影子 = 物化域）；不提供跨 agent / user 账本的检索
能力（跨 agent 历史分析改走文件只读，与 webui 读面同义）。

**树归属**：host → shell（R0a 判据 1）。旧 R1 记「数据服务·多根只读搜索」与判据 1
冲突：grep_history / read_history 是**工具**，工具只能由壳内 agent-loop 执行——宿主
进程无 loop，注册的 ctx.tools 永不被调用。行集总数 81 不变（宿主 47→46 / 壳 34→35）。

**否决的备选**（拆分为宿主「多根只读搜索服务」行 + 壳工具行，R5 判据 7）：壳→宿主
请求面在新架构只有信封（单向投递）与 B3 旁带帧（单向），跨进程请求-应答需新增通道；
而 D4 读面本可文件直读、工具语义又只需自己的账本——新增通道的工程与协议成本不成立。

**回放语义**（与主线 session.history 恒等）：`summary.md` 概要头部以 system 消息置首；
viewer 投影 = `agent_id === 本 agent → assistant`，其余 → user（对端行带 `name` = 对端
端点 id——只搜自己 ≠ 只见自己的发言，本域账本里对端的话也是本会话事实）；
context/event 机制行不入回放（台账面，非会话发言）。

**会话键面**：`conversation_id` 参数保留，但只在本 agent 账本内解析（词法闸禁路径分隔/
遍历）；本域无该会话 = fail-loud（明确报「只搜自己」），不静默空集。

# 〈D11 归档全壳内〉（2026-10-19，cr-546 立）

**裁决**（用户裁定，三选一取 A）：归档全链（阈值检测 / 整理 run / 归档重建 / 超时
兜底）住**壳**，宿主零 archive 职责；timer 的 archive-all 机制任务改**批量唤醒信**
（宿主只发信，判定与执行全在壳内自决——A13「宿主自有异步 → timers + 宿主 async，
无注册表面」与 D10 先例同承）。

**树归属**：host → shell。两判据叠加：① 整理 run = LLM 编排 + 工具执行，只能住壳
进程（R0a 判据 1，与 D10 session-query 同构——宿主无 loop）；② 归档重建 = 写归属
agent 的账本，D4「写权 = 账本所有权」——账本写者恒为归属 agent 的壳（会话账本归
尾段 agent，pair 会话两壳各写自己域的镜像账本，归档各自执行）。行集总数 81 不变
（宿主 46→45 / 壳 35→36——archive 从宿主数据服务组移壳域服务组）。

**否决的备选**（B：宿主枚举行 + 壳内整理）：宿主保留 archiveAll 枚举判定（直读
agents/*/sessions/ 估算达阈 → 拉壳投递），整理归档住壳。否决理由：估算逻辑宿主化
引入跨进程口径耦合面——宿主侧估算须与壳内回放注入形状口径双向对齐（replayView
过滤 / 概要头 / viewer 投影），单边演进即漂移；而全壳内形态判定与执行同进程同口径，
宿主彻底不持 agent 定义知识（会话归属 / 预算 / 回放口径），与 D10「宿主不持 agent
知识」同一收敛轴。C（全宿主）不可行：整理 run 必须住壳。

**唤醒信形态**：archive-all 信 = 对角线 uuid（`<target>~<target>` 确定性键）+
sender = target 自身（自会话语义）+ budget 1 + `payload.mechTask = 'archive-all'`
（机制信分发键——壳 boot 收信面识别并路由 archiveAll；virtual / 无 model 的 agent
不投）。批量归档枚举内化为壳内 archiveAll（本域 sessions/ 逐桶阈值判定）。

**整理 run 语义**（主线 meta[ARCHIVE_REVIEW] 三不语义平移）：不落账（settle 走
机制变体——journal-settled 落 journal、messages 不落行）、不记 usage、不进上下文
视图；与用户 run 共串行化门（busy 排队）；maxSteps 128 硬闸 + 超时 abort + 步级
观测三闸照搬。单 agent 壳无双侧 done 协议（主线双侧整理的对桶在 D4 视角主义下 =
两壳两账本，各自归档各自执行）。

**pending 标记协议退化**：主线 pending/done marker + 周期扫描兜底是跨参与者协议
（双侧 done 全齐才归档）；壳内单写者事件驱动下无此形态——整理 run 由行内 await
串联（触发 → 整理 → 重建），崩溃中断 = 重启后阈值检测自然重触发（幂等），idle-exit
不收割 busy 会话。标记文件不迁移（观测面残留在主线归档段目录）。

# 〈D12 会话覆盖写权归宿主〉（2026-10-22，cr-565 立）

**裁决**：`conv-settings`（会话级覆盖：模型 / 工具档 / 实验键）行**移入宿主树**——
写者单源 = 宿主 web RPC（输入框模型菜单、设置面板、`singles/update` 的模型覆盖）；
壳侧改由数据根垫片 `ConvSettingsShim` 提供只读 `get` / `registerKey` / `listKeys`
（策略同 credentials 垫片 R-11 ③：物理单副本两侧共用，写口只在一侧）。行集总数 82
不变（宿主 45→46 / 壳 37→36——从壳域服务组移宿主数据服务组）。

**判据**：① 写入的发起方**恒是用户动作**（webui 输入框 / 设置面板）——旧架构单进程
时写口自然在 web-api，新架构的 web-api 面住宿主，故写权随动作面走（D4「写权 = 所有权」
的同一推论：谁发起、谁落盘）；② 读面两侧都要：壳内 run 装配与 `harness-tools` 的
`harnessTier` 注册面只读不写，垫片足够（与 agents / agentStore / credentials / workspace
四垫片同构）；③ 否决「写面走壳控制帧」：读面（`conv-settings/get` 挂载即取）会因此
每次都要拉起壳进程，而键目录（`conv-settings/keys`）的宿主侧子集本可静态返回。

**模型覆盖链路**（本次修复的实质）：选择 → `conv-settings/set`（1v1 键 = pairKey(viewer,
agent)）/ `singles/update`（独立会话键 = sid，同源落 conv-settings——preview 无 singles
session.json，不存在主线「防双源」语境）→ deliver 合并点（显式入参 > 存盘覆盖）→
**信封 `model` 字段**随信投递 → 壳内 run 装配按 `name@model` 拆 provider/model、裸名不带
provider（`splitModelRef` 单源）。随信封而非壳内查表：排队 / inbox 重放的信仍按投递时刻
的覆盖跑，语义确定；传参语义与主线 deliver 合并点（P6/D4）一致。

**未落地面**（诚实记账）：`singles/update` 仅支持 `model`——agent 切换 / 标题 / 工作区
属单会话元数据面（preview 无 session.json），当前 fail-loud 报错；`harnessTier` 等壳内
扩展键在宿主键目录中不可见，前端「实验性」菜单不提供（写入面缺席，非数据丢失）。

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
- cr-484：tag 机制解体（方案 A）——requiredTags/tags 全链退役、七职能归位、双闸换轨；R7-6 消解。
- cr-485：R7-7 收口——patch 机制整体退役，两树同形 boot（清单驱动装配全域单一）；行集唯一来源 = 派生推广全域。
- cr-546：D11 归档全壳内（archive 改树入壳——timer archive-all 改批量唤醒信）。
- cr-565：D12 会话覆盖写权归宿主（conv-settings 改树入宿主 + 壳只读垫片；模型覆盖经
  deliver 合并点随信封换轨到壳内 run 装配）。

## 本档案纪律

- 探索档案（explore/）：裁决簿随正文同批演进——新定向先入簿（论据全文），正文
  只改终态行与状态板。
- 引用规则：母档案依据写 R-n / D-n / S-n；本簿条目按篇名引用。
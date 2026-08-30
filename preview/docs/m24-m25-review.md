# M24 / M25 设计稿审查报告（三审）

> 审查对象:`docs/m24-global-defaults-plan.md`(**v6**)、`docs/m25-event-governance-plan.md`(**v4**)。
> 审查方法:二审建议(B1-B3/C1-C5/D1-D6)逐项落实核对 + v6/v4 新增事实声明逐条
> 代码实证(两条独立核查通道:M24 消费面 16 组 / M25 vendor+preview 24 组,行号级证据)
> + 跨文档一致性与新裁条款自身的可行性问题审查。
> 结论先行:**二审修订全部有效落实,v6/v4 新增事实声明实证全部属实**(并自纠二审
> 报告一处实测错误,见 N7);两稿达到可实施状态。三审新发现中严重度 2 项
> (N1 清扫触发归属、N2 @scope 清单不穷尽)、低严重度 6 项——均为一句话级修文,
> 不阻塞排期。

---

## 一、总评

| 维度 | 评价 |
|---|---|
| 二审落实 | ✅ B1-B3/C1-C5/D1-D6 + grep 排除项共 12 项全部落进 v6/v4 正文(逐项核对见 §二) |
| v6/v4 新增声明准确率 | M24 侧 16 组全属实;M25 侧 24 组中 21 组属实、3 组措辞/归属微瑕(均不影响结论) |
| v4 重裁的机械前提 | ✅ loader 并发创建(group.ts:71 `Promise.allSettled`)、裸动态 import(tree.ts:157-159)、fiber 微任务检查点(fiber.ts:650)、`EntryTree.await()` 收敛点存在(tree.ts:46-64)——"行序 ≠ 激活序"四支柱全部实证 |
| M24 消费点清单完备性 | ✅ B2 三缺口补全后,全量复扫(`.hooks`/`'hooks'`/`hooks:` 两轮)**后端清单外消费点 = 0** |
| 跨文档一致性 | ✅ README:15/24 与两稿 :3 逐字一致;X1↔P1 排期互引、X2 交壳/P2 交数据、倒排双读兜底、C1 双向认领——两稿互述无冲突 |
| 主要风险 | N1(M25 P2 清扫触发无人认领);N2(@scope 清单漏 8 个已声明事件,含 1 个判定式边界案例) |

---

## 二、二审建议落实核对(12/12 落实)

| 编号 | 要求 | v6/v4 落点 | 判定 |
|---|---|---|---|
| B1 | 重裁 boot 顺序条款(推荐"拦截+boot 末清扫"),行位断言改清扫/拓扑断言 | M25 v4 头注 :6-9 撤销重裁;§3.4 :171-185 拦截+boot 末一次性清扫+三重防线;P2 测试 :254-255 清扫断言替代行位断言 | ✅(机械前提三审再证,见 §一) |
| B2 | 消费点补三缺口 + collab-tools 归类"读+写" | M24 §2.2 :104-109;P1 :199 含 collab-tools 写面换新键 | ✅ 实证:index.ts:42(PROFILE_ALLOWED_FIELDS 含 'hooks')/:404/:414-421(两处浅合并写回)/:315(hooks_keys);清单外后端消费点复扫 = 0 |
| B3 | 白名源头指向 ac-web-api(CONFIG_KEY_PREFIXES) | §2.3 :157-158 + §五 :242 | ✅ 实证:index.ts:137 七成员、:145-146 fail-closed、现不含 'settings' |
| C1 | agentGate↔settingsOf 升级归属互引 | M24 :112-113 ↔ M25 :138-139 | ✅ 双向认领 |
| C2 | events.disabled 键格式定死、P3 不迁移 | M25 :187-190 键 = owner 原文 P2 起即定;§3.5 :219-220 聚合只改呈现+双命中 | ✅ |
| C3 | 生产源后裁触发条件 + 生产形态行为写明 | M24 :130-133 内置组为空+UI 注明+触发条件 | ✅ |
| C4 | RPC 兼容窗说明 | M24 :71 同批原子切换、无兼容窗、越权面显式接受 | ✅ |
| C5 | 迁移纪律措辞修正 | M24 :83-84 幂等+marker+dry-run+恒等门;自认"既有脚本无备份逻辑,不引为先例" | ✅(实证备份 0 命中;四要素分布见 N5) |
| D1 | "(新)"标注改写 | M25 :95-97 存在性注记:十个读取器全不存在,唯 before-step 通道随 §3.1 新增 | ✅ 实证:全 preview `agentOf` 仅 ac-web-api:401 agentOfPair |
| D2 | 末参函数启发式锁定 | M25 :122-124 + P1 目录锁定测试 | ✅ 维持 |
| D3 | 替代注册实现注记 | M25 :201-203 | ✅ 实证:events.ts:295 bind 先于 bail、:296-297 真值吞注册、vendor 消费者 :140-146 返回数字 |
| D4 | 零监听器事件以声明目录为准 | M25 :209-210 | ✅ 实证:ac-web-api:1067 `.filter(h=>h?.ctx)`、:1073 空链不显 |
| D5 | webui 前端面补索引 | M24 :87-90 + §五 :254 | ✅ 实证:useSettings.ts:110/:333/:350、shims/protocol.ts:252/:264、roster.ts:27、PluginLibraryPane.vue:419-420 |
| D6 | before-step JSDoc 同步 | M25 P1 :242-243 | ✅ 实证现状 events.ts:49-53 未提 agent |
| 二审低危5 | P1 grep 排除项 | M24 :200-203 | ✅(排除项理由一处瑕疵,见 N3) |

---

## 三、三审新发现

### N1【中·M25 §3.4/P2】boot 末清扫的触发接线归属未指定

v4 重裁指认了收敛点候选("include `EntryTree.await()` 语义 / loader 空闲")
且入口实证存在(tree.ts:46-64:`async await()` 聚合各 entry `_initTask || fiber.inertia`
+ `Promise.allSettled`,失败抛原错/AggregateError)。但**谁在何时调用清扫**无任何
批次认领:ac-event-policy 是普通行,行内无法感知"boot 已收敛"——`reflect.notify(['loader'])`
是反射缓存失效机制,非稳定公开信号。候选接线:

- **组合根显式调用(推荐)**:`ac-app/src/boot.ts` 已有组合根职责先例(内联 bin.js 16 行
  + cordis.patch.yml 注入)——在 `await ctx.loader.create(...)` 收敛后显式调用策略
  服务清扫口(或 emit 一个 boot-settled 事件);
- 程序化组合根路径另议:`bootTree`(ac-app/src/index.ts:146-156)是**串行** `await fiber`
  且无 loader——测试路径须直调清扫口(P2 测试本就直读 `_hooks`,天然兼容)。

建议 P2 批次补一句认领;否则实施者会在"策略行如何知道 boot 结束"上自由发挥。

### N2【中·M25 §二.1/P1】@scope 二分清单不穷尽——漏 8 个已声明事件,含 1 个判定式边界案例

全 preview 事件目录枚举(15 域、42 个已声明事件)对照 §二.1 两清单:

- run 域 5 组(loop/tool/router/llm/conversation)✅、host 域 8 组(config/changed、
  plugin/*、webui/*、ws/connection-*、archive/completed、job/settled、agents/updated、
  durable-interaction/*)✅;
- **未列入两清单**:`group/created·deleted·renamed·member-added·member-removed·
  message-posted`(ac-group/src/events.ts:17-48,6 个)、`singles/updated`
  (ac-singles/src/events.ts:18)、`ws/ack`(ac-web-server/src/events.ts:34——
  "ws/connection-*" 通配盖不住它)。

其中 **`group/message-posted` 是判定式的边界案例**:发射点 ac-group/src/service.ts:600
的 `post()` 双语境可达——用户经 `group/send` RPC(宿主上下文,答不出 Agent)与 Agent
群内回帖投递(发生在该 Agent 的执行里)。"能答出唯一 Agent 为 run 域"对该事件给不出
稳定答案,单一 `@scope` 标注需要裁决(建议按 host 归——保守端:无读取器即不可门控,
与"读取器存在性 = 结构性编码"对齐;JSDoc 注明双语境)。

P1 批次"各 owning 包事件目录补 @scope 标注"若无全量包清单,ac-group/ac-singles/
ac-web-server 三个 owning 包会被漏掉(读取器五包清单是显式的,@scope 清单是隐式的)。
建议 §二.1 补全两清单或加一句"以全部 owning 包 events.ts 为准,清单仅示例"。

### N3【低·M24 P1】grep 排除项理由写错:templates/ 在 preview 内,不在外

M24 :202-203 写".dsh 技能与 templates/ 在 preview/ 外(typecheck 扫不到)".实证:
`templates/event-row/index.ts` 等在 **preview/templates/**(区内);真实原因是
`preview/tsconfig.json` include 仅 `**/src/**/*.ts` + `**/tests/**/*.ts`,
templates/ 不在扫描面。操作性结论(扫不到、人工同步)维持,理由须改写
(.dsh 技能确在 preview 外,两句应分述)。

### N4【低·M24 §五】两处索引精度

- ALLOWED_FIELDS 实际在 `ac-agent-admin/src/service.ts:28-42`('hooks' 恰在 :39),
  非 §五 :245 所写 index.ts;
- ac-agent-store src 现状 `hooks` 零命中(通用持久化不感知词汇)——它是"迁移/双读
  落点"而非"hooks 键所在",索引措辞宜区分。

### N5【低·M24 §2.1】"纪律沿用 migrate-* 实际形态"高估了先例的均匀性

实证:幂等 ✓ 两个脚本都有;marker(`.migrated-src`)仅 migrate-workspace;--dry-run
与迁移恒等门测试仅 migrate-session-neutral(ac-session/tests/migrate-neutral.test.ts);
unify-group-storage.ts 四者皆无(直接 rmSync)。**无单脚本全取四要素**——新脚本的
四要素规格本文已写全,无正确性风险,仅"沿用实际形态"宜改"取既有脚本纪律之并集",
防实施者去抄一个并不存在的完整先例。

### N6【低·M25 §3.4】策略行自身被重载的逃逸窗未声明

internal/* 恒放行防了自锁,但 ac-event-policy 自身 reload/重挂期间 `internal/listener`
无消费者、注册逃逸,且此后无 boot 末清扫兜底(boot 已过)。yml 行 patch 停用走
restartRequired,窗口极窄(dev/HMR 场景);建议补一句"策略行 reload 后追加一次清扫"
或显式声明该行不支持热重载。

### N7【二审报告自纠】"全 preview 只有 ac-timer inject 'config'"存在实测反例

二审 B1 证据句(本文件上一版 :40-41)经 48 处 inject 声明全枚举复核:
`ac-web-api/src/index.ts:86-104` 的**多行 inject 数组** :98 同样含 `'config'`
(单行 grep 漏检多行数组)。**B1 结论不受影响**——核心证据是 ac-session 等
监听器注册行零 inject 声明、与任何 config 依赖行之间无顺序契约;多一个 inject
'config' 的行反而进一步印证 inject 面稀疏、行序无激活语义。v4 重裁的成立性
不受牵连,仅证据句须修正(已在本版更正)。

### N8【低·M24 P1/P4】webui 前端改名的批次归属宜显式化

P1 显式列举的工作项全在后端,而 RPC 线格式 + ALLOWED_FIELDS 在 P1 原子切换后,
webui 装配保存(`patch.hooks`)即 **fail-closed 硬错**直至前端改名落地——shims 是
手写类型,typecheck 不会替它报错。"全链改名"与 grep 验收(未排除 webui)隐含前端
在 P1,但 P4 标题"目录与装配前端"易诱导误读。建议 P1 显式列入 §五 前端改名面,
否则违背 §三"每批独立可验收"的自设标准。

---

## 四、事实核对汇总(v6/v4 新增声明,简表)

**M24 v6(16 组全属实)**:①collab-tools 写面三处(:42/:404/:414-421/:315)✅;
②workspace admin.hooks 写(:91,选项 :27/:36)+ sandboxWorkdir 读(:211)✅;
③agent-admin 白名单(service.ts:28-42 + :301 拒未知键)✅;④CONFIG_KEY_PREFIXES
七成员/不含 settings/fail-closed(:137/:143-148)✅;⑤rowMetaOf(:313-342)✅;
⑥EXTENSION_CATALOG 11 条、fields 7 条(skill/persona/system-prompt/memory/security/
web-tools/archive)、configNs 0 使用(:373/:379-391)、targets 全有(:369)✅;
⑦ac-config 无白名单全量读写(service.ts:33/:93/:101/:124-129)✅;⑧deepMerge 对象
递归/数组整体覆盖/source 键优先(ac-config-merge:19-38)✅;⑨ac-singles 读点
service.ts:164/:172、只写哈希不写 hooks(:141-146/:200-209)✅;⑩plugin-registry
security 读(service.ts:592)✅;⑪web-api archive 读(:763-764)✅;⑫agent-presets
构造写(:60-64/:79-86)✅;⑬扩展八包读点各一处全实证(persona:93/memory:85/
skill:61/datetime:54/security:102/system-prompt:324/archive:220/web-tools:104)✅;
⑭迁移脚本无备份(备份|backup 0 命中)✅(纪律分布见 N5);⑮cordis.yml 无
ac-plugin-market/ac-event-policy/ac-gate-core 三行 ✅;⑯README:15/24 口径 ✅。

**M25 v4(24 组:21 属实,3 组微瑕)**:并发模型 4 组全属实(group.ts:71/tree.ts:157-159/
tree.ts:46-64/fiber.ts:650——微瑕 1:字面"首行"是同步簿记,首 await 在 :650,语义
成立);events 机制 4 组全属实(events.ts:295-299/:349 vs :296/:140-146/this=注册方
Context 经 reflect tracker);include 事务化属实(微瑕 2:回滚实体在 loader group.ts:
85-104,include 侧仅入口);preview 现状 11 组属实(LoopStepCall 仅 messages/
LoopStepTransform 有 agent、meta.agent 注入 :387-392、发射点 request.agent 在作用域、
before-step 消费者 0、JSDoc 未提 agent、agentOf 仅 agentOfPair、F10 守卫
patch-layer.test.ts:118-147 字节不变、provides.events string[](manifest.ts:45)、
events/listeners 过滤/裸名/空链(:1065/:1069/:1067/:1073)、events/descriptions 零存在、
@scope 零存在、模板 agentFilter(preview/templates/event-row/index.ts:25/:32/:38)、
internal/listener seam 零占用、cordis.yml 头注 :5-6、ac-session 零 inject + boot
4 监听器(:328/:342/:349/:407)、patch 域 disabled 字段(patch.ts:24-28/:42/:91));
微瑕 3:setPatch 三态实为 'hot'|'written'|'no-include-row'(hot 恒不返回的保留字
——与 §3.5 "setPatch 返回 hot 态"的补全对象表述一致,installed/failed 是
installFromDir 的安装三态,勿混)。

---

## 五、结论与排期建议

1. **两稿可排期实施**。二审全部修文落实,v4 重裁的机械前提与 v6 补全清单均经
   行号级实证;三审无高严重度发现。
2. **修文随下一版**(均为一句话级):
   - M25 v5:N1 清扫触发归属一句(推荐组合根 boot.ts 认领 + bootTree 测试直调);
     N2 @scope 清单补全(或改"以全部 owning 包为准")+ group/message-posted 边界
     裁决(建议 host + 注明双语境);N6 策略行 reload 逃逸窗一句。
   - M24 v7:N3 排除项理由改写;N4 两处索引精度;N5 "实际形态"→"纪律之并集";
     N8 P1 显式列入 webui 前端改名面。
3. **排期不变式复核**(三审再证):X1 先于 M25 P1;X2 交壳/P2 交数据;倒排双读
   兜底双向成立;C1 升级归属双向认领——两稿交叉依赖口径无冲突。

---

## 附:历轮审查范围

- 一审(并入 v5/v3 修订):v4/v2 稿全文审查,产出 B/C/D 编号体系与事实核对方法。
- 二审(v5/v3 → v6/v4):B1 行序前提推翻、B2 消费点三缺口、B3 白名源头错位、
  C1-C5、D1-D6(本文件上一版;其中 B1 证据句"只有 ac-timer inject 'config'"
  经三审自纠为 N7,结论不受影响)。
- 三审(本版,v6/v4):落实核对 + 新增声明实证 + 新裁条款自身审查,产出 N1-N8。

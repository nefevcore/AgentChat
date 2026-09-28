# 变更登记目录（CR log）

> 一切变更（含日常 bugfix）动手前**先在此追加一行**，再动代码。
> 规约背景见 `epoch-marking-convention.md`（cr-1 起 CR 制度建立）。

## 登记格式

```
【cr-序号 yyyy-mm-dd 一句话描述】
```

- cr 号为正整数、单调递增、永不复用（不固定位数，前导零禁止）；日期 = 登记当日真实日期。
- 描述一句话说清改了什么；细节写对应设计文档或 CHANGELOG，目录行保持一行。
- 一次会话内的一组关联小改可合并为一条 CR。

## 目录

- 【cr-1 2026-09-27 日期语义重定义：批次代号退役、存量月份标记 blame 分层还原为真实日期（史前/不可考 → `-00`）、外部归档目录改名、规约重写并建立 CR 登记】
- 【cr-2 2026-09-27 cr 号位数约定修订：三位改「正整数单调递增、不固定位数、前导零禁止」】
- 【cr-3 2026-09-27 CR 目录自 epoch-marking-convention.md §三迁出为独立文件 cr-log.md】
- 【cr-4 2026-09-27 记忆时间线与群聊转录流重构：记忆桶寻址改 Agent 人格单时间线（timeline.md + checkpoint/delta 注入协议 + memory_write/memory_grep 工具）+ 群聊派生视图改成员私有转录流；memoryOwner 全链与派生窗全族退役（计划 src/docs/memory-timeline-plan.md）；追加裁决：迁移前置检查 infra 等价授予——有存量记忆的 infra Agent 自动补 memory 标签（一次性，预设豁免）；条目 log 形态前缀 [date] 由工具铸造 + [tags] 段为正文通道（tags 参数移除）；memory_write 增 date 参数（事实发生日回填）；迁移提示词改指路形态（不内嵌旧桶，Agent 自读 ./memory 整理）]
- 【cr-5 2026-09-27 PTC 程序化失效事故：根因 = DeepSeek 越面结构化幻觉直调（推理端不校验 tool_calls 函数名，editor~user 750K 经典直调历史浸泡下模型无视 run_code 单 schema 请求面、模仿历史直调面外工具；执行面无请求面闸门致全部放行——llm-req/resp 两侧探针实锤）。修复 = loop 请求面硬闸：request.tools 已定义时面外调用不执行、回填「面内可用工具 + 程序化正确入口」引导纠错（模型 ReAct 自愈回落 run_code）；request.tools 未定义不判定。诊断探针六处全部移除，闸门落 src/ac-agent-loop/service.ts 执行点（原探针③位置），单测锁定】
- 【cr-6 2026-09-27 fix(preview): 文件预览双滚动条——body/code-wrap 嵌套 overflow:auto 收归 body 单滚动容器（面板与 Modal 双形态）；markdown/html 预览 iframe 补 display:block 消 inline 基线底隙（~7px descender 撑出 body 纵向溢出 = 双滚动条第二根因）】
- 【cr-7 2026-09-28 dev:demo（boot-yml-main.ts）数据根无条件锚定 workspace/test（同 smoke.ts 语义）：脚本曾尊重宿主继承的 AGENTCHAT_DATA_ROOT，e2e 段把 helper~user 演示会话写进真实数据根（2026-09-15 污染实例）；同步清理真实根内测试残留（helper~user 会话、pending-a~a~a、空 files 桶）】
- 【cr-8 2026-09-27 patch 层加固方案立项（src/docs/patch-layer-hardening-plan.md）：setPatchEntry 改 AST 保注释编辑（yaml@^2，findLast 对齐 include last-wins，损坏文件 throw）+ setPatch 前置装配树校验（未知 id fail-loud 不落盘）；裁决不采纳 DSH overridden 四态/统一锁域/Agent 启停工具入口三项】
- 【cr-9 2026-10-09 browser eval 序列化语义优化（run_code 编排实测复盘驱动）：eval 返回未调用 function（IIFE 漏写括号）/未 await 的 Promise 从静默 {} 改为带修复指引的明确报错；eval 结果保留 JSON 类型（数字/布尔/对象直出，去字符串化）；wait 动作内部 Promise 改经 evalExpr awaitPromise 通道；工具 description 补各动作返回字段契约；run_code 失败时 log 末尾行并进 error 诊断】
- 【cr-10 2026-09-28 run_code 输出预算缺省 32KB→64KB：全量实战复盘定标（489 会话 19008 次落地调用，截断率 0.5% 且 75% 走 return 通道；超限 p50≈45.8K、64K 档消除 71% 事件，正常返回 93%<16K 故提额不伤常态；触发后 30% 被残留数据吞噬、68% 被迫改分段读多烧一轮）。tool.ts DEFAULTS 与 index.ts 行配置缺省/工具参数描述同步】
- 【cr-11 2026-09-28 patch 层加固实施（cr-8 方案落地）：setPatchEntry 改 eemeli/yaml AST 编辑（保注释/保条目序/新条目 flow 风格；findLast 对齐 include last-wins；损坏文件 throw 拒绝覆盖）+ setPatch 前置装配树校验（include 在位且 id 不在 enumerateDisablableEntryIds → throw 不落盘，对齐 DSH 先校验再落盘；落地核对保留为兜底）】
- 【cr-12 2026-09-28 portb-e2e 测试对齐 cr-4 记忆时间线契约：memory.set 桶写口退役 → memory.write 单时间线（预设软停用断言改锁 <memory-guide> 缺席 + 工具轮直写视角不注入）+ workspace root 补隔离（preset workdir 回落数据根，防 timeline.md 落真实根）】
- 【cr-13 2026-09-28 webui 运行基线收口（真机 M3 §1.1 实录根因）：产物未声明最低运行环境——vite build.target 不设 = 只降语法不补运行时 API，cordis 打包进的 Object.hasOwn 在真机 WebView 92 上「is not a function」炸掉装配（白屏）。落地三处同一份基线：① public/legacy-runtime.js 垫片（classic script 先于 module，补 Object.hasOwn / Array findLast·findLastIndex·toSorted·toReversed·toSpliced / AbortSignal.timeout）；② vite build.target=chrome92 声明语法基线；③ scripts/check-webview-baseline.mjs 构建期守门（垫片在位与顺序 + 产物超基线 API 命中即 fail），接入 webui:build（守门含 API 面与语法面两条判据；垫片覆盖度从垫片源码 feature-detect 自动判定，杜绝「声明垫了却实际没垫」漂移）。同轮第二层：cordis 的 class static block（Chrome 94）esbuild **不降级只警告** → 真机 SyntaxError 整块 chunk 不执行，故 esbuild.supported['class-static-blocks']=false 授意降级。遗留：CSS 侧 color-mix()（Chrome 111）大量无兜底声明，非阻断待后续收口】
- 【cr-14 2026-09-28 真机 X25519 兜底实现（真机 M3 §1.3 首配闪退根因）：Redmi K20/Android API 30 的 JCA 对 X25519/XDH/X25519DH 三个算法名**全无**（连 BC provider 也没有——Android 裁剪版 BouncyCastle 不带 XDH），API 33+ Conscrypt 才有，模拟器长期掩盖。新增 mobile/transport/.../X25519Pure.kt（RFC 7748 Montgomery ladder，BigInteger 直译伪代码；握手为每链路一次性低频运算，可读性优先，常数时间性由 JCA 路径承担）；Noise.kt dh() 改「探测优先 JCA、缺席落纯实现」，删无调用方的 X25519Platform.require()；X25519PureTest 5 例锚定 RFC 7748 §5.2×2 + §6.1 DH 交互 + JCA/纯实现一致性 + basepoint 生成路径。次生坑：BigInteger.TWO 是 JDK 9+ 常量，Android API 30 core-libart 无 → NoSuchFieldError（JVM 单测绿、真机崩），全部换 valueOf(2)】
- 【cr-15 2026-09-28 真机验证基建（M3 真机轮配套，均为验证/开发面，不动产品语义）：① MainActivity 开 WebView CDP 调试口（BuildConfig.DEBUG 门控，chrome://inspect 可用）+ debug 构建跳过生物锁（无人在场的自动化验证不被指纹门挡住，release 语义全保留）；② network_security_config 放行局域网明文（adb reverse 通道长时不稳，真机实测约 25s 后断链——清单 §4.2 预言成真，改 PC 局域网 IP 直连验证）；③ scripts/remote-loopback-host.ts 加 LOOPBACK_AUTO_RECONNECT env（缺省仍 false 一次性语义）；④ ac-relay-server main.ts 加限额 env 口（RELAY_MAX_CONN_PER_IP/RELAY_JOIN_BURST/RELAY_JOIN_RATE，本地联调双端同 IP 挤兑时放宽，生产缺省不变）+ RELAY_DEBUG=1 连接生命周期诊断日志（哑中继刻意不打日志，排障时是盲区）】
- 【cr-16 2026-09-28 KK 重连时序竞态修复（M3 真机 §3.3 根因落地）：哑中继只转发实时帧——发起方 m1 早于响应方进房即丢失，双方各自超时后按同款退避（1s 起 60s 顶 ±20% 抖动）错开、反复错过（RELAY_DEBUG 日志实录：设备 join 即发 m1 时宿主未进房）。三处修复对齐 scripts/remote-loopback-client.ts 的既有裁决（M3.1 Kotlin 移植漏了重试层）：① RelayClient.reconnect 加 handshakeTimeoutMs 参数（缺省 KK_HANDSHAKE_TIMEOUT_MS=3s 短窗，m2 不到快速失败）；② RemoteSession.tryReconnect 改 10 轮整链重试（每轮新 dial/新握手/新临时密钥，3s 超时 + 4s 间隔 ≈8.5 join/min 不触 relay 频控，覆盖对端 60s 退避窗）；③ RemoteLinkService 构造器补「启动即连」（有 relay 且有已配对设备时 void connect()——响应方不先进房则发起方重试再多也握不上）。新增 RelayReconnectTimeoutTest（ktor 最小 relay 夹具：join 后永不回 m2，锁「短超时快速失败」契约，防回退 15s 长挂）】
- 【cr-18 2026-10-09 桌面端 Windows NSIS 安装向导高 DPI 模糊修复：安装器 exe 无 DPI awareness 声明 → 系统 150% 缩放下整窗位图拉伸模糊（本机 2560x1440@144dpi 实证：DPI-unaware 窗口 755x543 被 DWM 位图放大）；修复 = desktop/build/installer.nsh 写 ManifestDPIAware true（NSIS 编译期指令嵌 manifest）+ package.json nsis.include 挂载，安装向导/卸载向导自声明 DPI-aware 由系统按矢量渲染】
- 【cr-29 2026-10-14 池凭据/字段三连修（用户反馈「覆盖保存清空 API 地址和 apikey」）：① 改名迁移——config/set·config/save 池域提取前置 diff，掩码条目无凭据且旧名凭据在库时 pool:<旧>→pool:<新> 搬迁（连接指纹匹配优先、消失旧名唯一兜底、多候选 fail-safe 不迁；llm/searchpool 双域同源）；② 保存守门——PoolManager/SearchPoolManager 编辑已存条目时 Key 掩码→空或 base_url 将被清空（含误触提供方下拉换模板）先 ConfirmDialog 确认再保存；③ 防覆盖守门——useSettings 新增 poolsLoaded 标记，LlmPoolsHost/SearchPoolsHost saveNow 在池元数据未加载成功时拒绝整域覆盖（加载失败 pools 停留初始 {}，此时一次保存会清光后端现有连接；与 saveGlobal 空 config 防御对称）】

# AgentChat 重启体系设计

> 面向：开发者 · 状态：**L1.5 主动模块重载已实现**（§2）；Phase 1 协议加固已实现（78/退避熔断/信号接线/幂等守卫）；L2.5 与 supervisor 加固其余部分为提案（§10 决策点）
> 本文为 supervised-mode.md 的整体重写；关键代码事实索引见附录 B。

---

## 1. 设计总览

### 1.1 核心模型

一切变更尽量在进程内消化，进程边界只做最后防线：

- **配置 / 装配 / 行 / 源码 / 状态重置** → L0–L2.5 进程内解决，会话、WS 连接、`.runtime` 单例门全程不断；
- **框架与内核自身、env/依赖、堆、崩溃、假死** → L3（supervisor + 退出码 42）。

决策原则：**能低不高**——每层只处理自己层的问题，上层是下层的兜底。

### 1.2 重启阶梯

| 层级 | 触发 | 机制 | 状态 |
| --- | --- | --- | --- |
| **L0** 装配热更新 | Agent 配置/工具/钩子变更 | `PluginManager.saveAssembly` | ✅ 已有 |
| **L1** fiber 重载 | 插件行 config 变更（config-only） | loader `internal/update` → patchContext → fiber restart | ✅ 已有 |
| **L1.5** 主动模块重载 | dev 改源码后宣告完成（`reload_modules`，任意写法含 bash） | `ctx.hmr.reloadFiles` + 水位线发现 + 中断-续跑-补丁（§2） | ✅ 已实现 |
| **L2** 树热重组合 | 补丁层 / 市场插件装删 | `watchPatchLayers` → `composeLayers` → `reapply` | ✅ 已有 |
| **L2.5** 整树重启 | wiring/行序变更、应用层状态可疑、「重启试试」 | `root.update([])` → `root.update(data)`（§3） | 📋 提案（D1） |
| **L3** 进程重启 | 框架/内核文件、env、依赖、崩溃、树假死 | supervisor + 退出码 42（§5） | ⚠️ 骨架在，缺策略与握手 |

被动文件监视 HMR（chokidar watch 触发重载）**明确不采用**（dev/prod 均不），理由见 §2.2。

### 1.3 变更决策矩阵

| 变更 | 走哪层 | 说明 |
| --- | --- | --- |
| Agent 配置 / hooks / tools 清单 | L0 | 零中断 |
| 插件行 config / 市场插件装删 | L2 | `reapply` 事务性行增删 |
| 插件源码（dev，任意工具写入） | **L1.5** | 宣告 + 机械发现（§2.3），本 run 下一 step 生效（§2.4） |
| 框架/内核文件（vendor cordis、boot 内核） | L3（42） | externals，重载机器拒绝（§2.7） |
| 接线/行序/wiring、应用层状态可疑 | L2.5 | 整树换血 + 事务回滚（§3） |
| `.env` / 环境变量 / 凭据 | L3 | dotenv 模块加载期固化 |
| node_modules 升级 / node 参数 | L3 | 进程外状态 |
| 内存泄漏 / 句柄累积 | L3（定期卫生重启） | 只有进程边界能回收堆 |
| uncaughtException | L2.5 先行，短窗复发升 L3 | §5.7 |
| 启动期配置错误 | L3 但**不重拉**（退出码 78） | §5.2 |

### 1.4 角色结论

supervised（supervisor + 42 协议）在 **dev 与 prod 均为最后防线**：dev 源码主通道是 `reload_modules`，42 只兜框架/内核文件与重载机器假死；prod 兜崩溃、env/依赖、堆、树假死。协议不变；加固目标是「用到时更可靠」而非「更常用」。

---

## 2. L1.5 主动模块重载（已拍板）

### 2.1 设计原则：何时靠宣告，何物靠机械发现

partial-write 问题（半写文件触发重载）的本质是 watcher 在**猜**写完没有。本方案把两个问题拆开：

- **何时重载** —— 写者宣告完成：agent 调 `reload_modules` 工具（`requires: dev`）；
- **重载什么** —— 机械发现：水位线扫描 + loadCache 求交（§2.3），**不信任**调用方自报清单。

多文件关联修改（重命名导出 + 改用方）天然是一个事务：改完 A+B+C 后宣告一次。

### 2.2 被动 watch 为什么被否决

- 编辑器/工具写文件非原子，watcher 在半写状态即可触发——fiber 拿到语法错误或语义不完整的模块，轻则重载风暴，重则带病运行；
- 防抖（默认 `debounce: 100`）只缓解不消除：关联修改在窗口内仍会以中间态触发；
- 触发点从「猜」改为「宣告」后，防抖、写静止检测（`awaitWriteFinish`）、多文件事务窗口等补偿机制一概不需要。

若未来重启被动 watch，前置条件三条缺一不可：`awaitWriteFinish` + 重载前语法门 + 多文件事务窗口。

### 2.3 变更集发现：水位线扫描

**问题**：agent 不仅用 fs/edit 写文件，也常用 **bash**（sed / heredoc / git checkout / 格式化器 / 代码生成器）——shell 管道触碰的文件集对 agent 不透明，自报清单会漏报（改动不生效且无感知）或多报（无谓重载）。

**方案**：

```
watermark = 上次成功重载的时刻（初始化 = 进程启动）

reload_modules(files?[])            # files 为可选显式补充（取并集）
  1. 扫描源码根（复用组合 root 配置）：mtime ≥ watermark 的文件
  2. 映射 file:// URL，与 loadCache 求交（只关心已加载模块）
  3. 过滤 externals（框架文件命中 → 拒绝并提示走 system_restart）
  4. 交集 ∪ 显式 files → stash → partialReload 机器
  5. 成功后 watermark = now
  6. 重载清单 / 失败原因反馈 agent（扩展 describeInterrupt 或续跑消息）——避免静默重载
```

性质：
- **写法无关**：fs/edit、bash、格式化器、codegen、人手改——一律覆盖（「何物」从文件系统算出，不是问出来的）；
- **bash 完成语义成立**：bash 工具返回 = 命令结束 = 写入完成（agent 视角同步）；`cmd &` 后台写记录为已知边界；
- **新文件无需单独处理**：父模块缓存被清除后，重导入时自然拉取最新；
- mtime 粒度 / 时钟偏移在 dev 场景可接受。

### 2.4 即时生效：中断-续跑-补丁（现成机制）

工具/装配在 run 开始时已烘焙进 `ctx.tools`——原地换模块后，本 run 后续 step 仍用旧闭包。因此不走原地生效，走仓库现成的语义化中断链路：

```
reload_modules 执行体
  → throw ToolInterrupt({ type:'reload-requested', scope:'modules' })
  → loop.ts:378-388  resolveInterrupt(ctx, reason) → 装配层 interruptHandler
  → agents/config.ts:160-176  handler：执行重载 → 返回 { action:'continue',
       patch:{ tools: assembly.resolveTools(config),   // 重新烘焙
               systemPrompt } }
  → loop 应用补丁 → continue → 同一 run 继续，下一 step 用新闭包
```

先例（这条路今天就在跑）：
- `register_plugin` / `unregister_plugin`：`dev/src/plugin-tools.ts:109-112,146`（持久化 presets → self reload → 本次立即重烘焙）；
- `reload`（配置）工具同模式：`dev/src/tools.ts:258`；
- 引擎测试锁定语义：`loop.test.ts:250`「执行热重载后继续推理（不戛然而止）」。

集成要点：`ReloadScope` 联合类型加 `'modules'`；handler 内**先 `reloadFiles` 后 `resolveTools`**——顺序反了烘出的还是旧闭包。

### 2.5 重载机器能力面（vendored hmr）

| 事实 | 证据 |
| --- | --- |
| watcher 与机器可分离：`root: []` 关 watch 保活服务 | `vendor/hmr/src/index.ts:277-280`（root 空 → ready 立即 resolve） |
| 触发面极小：`onChange` = stash + `partialReload()`（private） | `index.ts:265-267, 400`；暴露 `reloadFiles` 约 10 行 vendored patch |
| 依赖图分析：变更扩散到依赖方 | `analyzeChanges` `index.ts:345-398` |
| 双缓存清除带备份（ESM loadCache + CJS require.cache） | `index.ts:461-489` |
| 重导入失败自动回滚旧模块 | `index.ts:493-545` |
| fiber 保留 loader 行链接（行不丢） | `index.ts:502-508` |
| 框架文件（externals）命中走 `loader.exit()`（全量退出） | `index.ts:260`——主动 API 应改为拒绝并导向 42 |
| 服务要求 `--expose-internals`（无则构造抛错） | `index.ts:120-122` |

### 2.6 失败语义：回滚而非崩溃

新代码导入失败 → 双缓存恢复旧模块 → 旧树继续跑，agent 收到错误反馈后可修复重试。对比 42：进程重启撞上坏代码 → 新进程起不来 → supervisor 退避循环 → **停机**。L1.5 的失败面严格更小。

### 2.7 边界与代价

- **框架/内核文件不覆盖**（externals：vendor cordis、boot 内核、组合引擎）→ 永远 42；
- 保留 `--expose-internals`（supervisor / bin 启动参数）；
- vendored patch 维护成本（约 10 行 + externals 拒绝语义）；
- 模块身份边缘：新旧模块短暂并存期 `instanceof` 可能失配；模块级单例（如 undici 池）重复创建——逐步收敛进 fiber 生命周期；
- 水位线 mtime 粒度边界。

### 2.8 实现清单

1. vendored patch：`ctx.hmr.reloadFiles(urls)`（externals 过滤 + 拒绝提示）；
2. 水位线扫描器（§2.3 流程）；
3. `reload_modules(files?)` 工具（requires dev）+ `ToolInterrupt(scope:'modules')`；
4. `ReloadScope` 加 `'modules'`；`agents/config.ts` handler 分支（先模块后烘焙）；
5. `composition.base.yml` hmr 行：`disabled: true` → 启用 + `root: []`（现「开发期在用户补丁层翻转」注释作废）；
6. `reload` 工具的源码变更警告（`dev/src/tools.ts:245-253`）从「请改用 system_restart」改为「请改用 reload_modules（框架文件除外）」。

---

## 3. L2.5 整树重启（提案 → D1）

### 3.1 动机

「重启试试」类需求（状态可疑、wiring/行序变化）目前只能 42：断 WS、断会话、`.runtime` 换手。loader 的行级事务原语足以支撑进程内整树换血。

### 3.2 事务原语（代码事实）

| 语义 | 证据 |
| --- | --- |
| 未变更行零扰动：options deepEqual 无 diff → 直接 return，不重启 fiber | `vendor/loader/src/config/entry.ts:157-160` |
| config 变更（非 name/inject/group）→ 原地 patch；name/inject/group 变 → dispose + 重建 | `entry.ts:194` |
| 整组更新是事务：新行先建，任一失败 → 回滚（删新行 + 重建旧行 + data 复位） | `vendor/loader/src/config/group.ts:70-105` |
| 全树清空/重建 = `update([])` / `update(fullData)` | `group.ts:59-106`（`reapply` 即此调用） |

安全对比：42 失败 = 新进程起不来 = 停机；树重启失败 = loader 回滚 = **旧树还在跑**（`loader-boot.ts` 的「组合树热更新失败（保留旧树）」今天已依赖此性质）。

### 3.3 内核/树分裂

reboot 原语不能住在它要重启的树里（鸡生蛋）。显式承认一个极小内核：

```
内核（刻意不是插件、极小）                     树（一切皆插件）
├─ 组合引擎（composition / composeLayers）     ├─ boot-core / workspace / archive …
├─ watchPatchLayers + reapply                  ├─ timer / subagent / server-l4
├─ rebootTree()（update([]) → update(data)）   ├─ webui / http-host / market 行
├─ kernel 服务面（ctx.kernel.reboot/…）        └─ @agentchat/restart（策略客户端）
└─ supervisor 协议（42/0/78 + IPC）
```

机制在内核，策略在树：root Context provide `kernel` 服务，`@agentchat/restart` inject。树活着 → 工具发起；树坏了 → supervisor 心跳兜底。先例：`ctx.cmdlineArgs`（`loader-boot.ts onContext`）。

### 3.4 会话排空两阶段

`gracefulShutdown` 拆成两段，reboot 只用前段：

- **排空（drain）**：`enterShutdownMode → enqueueResumeForActiveSessions → abort → waitRunningDrained(10s)`——状态迁移语义（先落盘恢复点再中止），fiber 表达不了，保留在 shutdown.ts；
- **退出（exit）**：`process.exit(code)`——仅 42/0 路径使用。

reboot 后 `flushPendingMessages` 重投恢复，全部现成件。

### 3.5 传输行钉住

full reboot 默认 keep 集合含 webui/http-host 行（排除在强制 dispose 外）：WS 不断线、端口不 flap、可广播「重启中」事件。keep 是 reboot 参数而非硬编码（钉住行自身故障 → keep 为空的 L2.5，或 42）；传输仍是插件行，不破坏「一切皆插件」。

### 3.6 边界

整树重启重走 fiber 生命周期但**模块不重载**——不含源码语义（源码走 §2）；对 prod 是特性（快、无编译抖动）。`.runtime` 门不换手（进程仍是 owner）。

---

## 4. system_restart 工具：scope 三档

`system_restart({ scope, reason })`：

| scope | 语义 | 门控 |
| --- | --- | --- |
| `assembly`（默认，现状） | PluginManager 热重载 | 无 |
| `tree`（新增，依赖 D1） | L2.5 整树重启 | **无需 supervisor**——非托管模式也可用 |
| `process` | 42 退出 | `isSupervised()`（保留，正确设计） |

工具描述随 scope 改写；「修改了 src/ 下核心代码」的旧指引改为 scope 引导。

---

## 5. L3 supervisor：兜底监护规格

### 5.1 命运隔离铁律

supervisor 不 import 任何 `@agentchat/*` / cordis，不读业务配置，不 watch 文件，不做业务日志。只做三件事：spawn、按协议处置退出、转发停止意图。现状（纯 `child_process` + `fs`）正确。

### 5.2 退出码协议

| 退出码 | 语义 | supervisor 行为 |
| --- | --- | --- |
| `0` | 正常退出 | 一并退出 |
| `42`（EXIT_RESTART） | 主动请求重拉 | 固定小延迟（~1.5s 端口释放）后重拉，**不计退避** |
| `78`（EX_CONFIG，新增） | 启动期配置/组合失败（不会自愈） | **不重拉**，非 0 退出并打印 worker 输出尾部 |
| 其他非 0 | 运行期崩溃 | 指数退避重拉，超限熔断 |

现状问题：`loader-boot.ts:176-179` 启动失败 `exitCode=1` → 被当崩溃 → 每 1.5s 无限重拉死循环。78/1 区分原则：失败发生在**组合树就绪信号（ready）之前** = 配置类。

### 5.3 退避与熔断

```
base=1.5s  factor=2  cap=60s  jitter=±20%
bootOk=30s（存活超此值退避归零）
crashWindow=10min 内 crashLimit=5 → 熔断退出（附最后一次 worker 输出尾部）
readyTimeout=120s（就绪超时 → 杀掉重拉）
```

### 5.4 IPC 握手与 Windows 事实

**Windows 事实**：`child.kill('SIGTERM')` 是硬终止（TerminateProcess 语义），子进程 JS 层 `process.on('SIGTERM')` **不会执行**；共享控制台 Ctrl+C 则父子双达。`supervisor.ts:129-132` 的「kill() = SIGTERM → 优雅退出」假设仅在 POSIX 成立——**定向优雅关闭必须走 IPC**。

spawn 加 `stdio: [..., 'ipc']`，三条消息：

```
worker → supervisor:  { t:'ready', port, profile }   // 此后失败不再归 78
worker → supervisor:  { t:'beat' }                   // 10s 周期（假死检测）
supervisor → worker:  { t:'shutdown', reason }       // 优雅停止意图
```

- ready 前退出 → 启动失败处置；ready 超时 → 重拉；
- 3 个 beat 未达 → IPC shutdown → 预算内不退 → 强杀重拉（树假死的配套兜底）；
- 信号路径降级兜底：POSIX 转发 SIGTERM；Windows 定向只走 IPC；控制台 Ctrl+C 双达靠 worker 幂等守卫（§5.6）。

### 5.5 关闭预算与强杀升级

```
shutdown 意图 → 等待 exit，预算 20s（> worker drain 10s + 余量）
耗尽 → POSIX: SIGKILL；Windows: taskkill /T /F（子 Agent/timer 子进程整树收尸）
```

现状转发信号后无限等待——极端卡死会让 supervisor 永挂。

### 5.6 worker 与 cordis 生命周期对齐

- **资源清理归 fiber**（服务器/watcher/子进程/定时器挂 `ctx.effect` / Service dispose）→ L1/L2/L2.5 重启天然干净；
- **业务语义归 shutdown.ts**（§3.4 排空链）；`webui.stop / archive.dispose` 等纯资源条目逐步下沉 fiber，`ShutdownDeps` 清单单调缩短；
- `gracefulShutdown` 加 in-flight 幂等守卫（Ctrl+C 双达 / IPC+信号并发只跑一次）。

### 5.7 worker fail-fast 阶梯

- `bootstrap.ts:53-59` 无条件吞 uncaughtException 与监护哲学冲突 → 升级阶梯：首次 → L2.5 tree reboot；短窗复发 → 42。非托管模式维持吞掉续跑；
- `unhandledRejection` 维持吞；
- `system_restart(process)` 的 `isSupervised()` 门控保留。

### 5.8 `.runtime` 单例门协同

- 门由 worker 持有（supervisor 不碰）；崩溃残留靠 `acquireRuntime` stale-pid 自动清理——此性质需回归测试（杀 -9 → 重拉 → 新 worker 成功获门）；
- 42 路径已闭环：`releaseRuntime` + continue-trigger 入队 + `flushPendingMessages` + WS ~2s 重连。

### 5.9 可观测性与测试

- 每次监护决策一行结构化日志（原因/延迟/第几次/存活时长），可透出 WebUI；
- prod stdio 可 `pipe`（崩溃尾部留存）；dev 保持 inherit；
- 测试：supervisor 类化（策略状态机 + spawn 适配器注入），fake child 单测协议矩阵（0/42/崩溃退避/78/ready 超时/心跳丢失/强杀升级），20 行假 worker e2e。

---

## 6. 进程重启不可替代集（42 的领地）

| 场景 | 原因 |
| --- | --- |
| 框架/内核文件变更（vendor cordis、boot 内核、组合引擎） | externals，重载机器拒绝（§2.5/2.7） |
| env / .env / 凭据注入 | dotenv 模块加载期固化（长期解法：env 读取服务化） |
| node_modules 升级 / node 参数 | 进程外状态 |
| vendored cordis 核心 | 不能重启正在执行你的运行时 |
| boot 内核自身 | 内核不可自举换血 |
| 堆泄漏 / native 句柄 | 树重启不刷新堆 → 定期卫生重启兜底 |
| 树/机器假死（事件循环卡死） | reboot 原语同样卡死 → supervisor 心跳丢失 |

---

## 7. supervised 插件化边界

拆成三问：

| 部分 | 可否插件化 | 原因 |
| --- | --- | --- |
| 策略（退避/熔断/健康判定/重启排期） | ✅ | 纯数据/逻辑，无命运耦合 |
| 激活（用户装上即生效） | ✅（watchdog 模式） | 组合行插入即启用 |
| 机制（spawn/死亡检测/退出码处置/强杀） | ❌ | 定义性事件是「宿主进程死亡」，插件与宿主共命运——逻辑矛盾而非工程局限（任何运行时都有非插件基底） |

**watchdog 变体**（激活插件化的诚实形态）：插件行激活时 spawn 零依赖 `watchdog.mjs`（detached + unref，内核侧工件），本地 socket 存活检测（进程死 → OS 关 socket，双平台确定性）+ INTENT{restart|stop} 意图协议 + `restart-spec.json` 重生。代际反转只发生一次（第 0 代 app 是 watchdog 父，之后归位为子）。先例：Electron crashpad、pm2 God daemon。代价：孤儿 watchdog 治理、token 鉴权（本地 socket 防伪造）、与外部管理器互斥（pm2/Tauri 托管时行弃权）。

**结论**：机制永远住内核侧；插件化的正确对象是激活面与策略面。协议（42/0/78 + IPC）保持可移植——`bin` 直启、Tauri sidecar、watchdog 三者互换，worker 零改动。

---

## 8. 现状 gap 清单

| 优先级 | gap | 证据 | 影响 |
| --- | --- | --- | --- |
| **P0** | 启动失败 exit 1 无限重拉 | `loader-boot.ts:176-179` + `supervisor.ts:114-117` 固定 1.5s | 补丁层写错一个字段 → 死循环 |
| **P0** | dev/Loader 路径无 SIGINT/SIGTERM 接线 | 仅 `bootstrap.ts:252-253`（dist 直启）注册 | dev Ctrl+C 硬退出，会话可能不落盘 |
| P1 | L1.5 未实现（本文主增量） | §2.8 清单 | dev 源码循环仍靠 42 |
| P1 | Windows 定向 kill 非优雅 | `supervisor.ts:129-132` | 停止不受 graceful 保护 |
| P1 | 无 ready/心跳/假死检测、无强杀升级 | `supervisor.ts` 全文 | 卡死永不恢复 / supervisor 永挂 |
| P1 | L2.5 不存在 | §3 | 「重启试试」只能 42 |
| P2 | 发布入口不经 supervisor | `bin/agentchat.js` web 直 spawn | 产品形态无监护 |
| P2 | uncaughtException 无条件吞 | `bootstrap.ts:53-59` | 放弃自愈 |
| P2 | ShutdownDeps 手工清单未收敛 fiber | `shutdown.ts` | 新增域漏接线风险 |
| P2 | `resolveEntry` dist 路径与构建布局不符 | `supervisor.ts:44` | 死代码 |
| P2 | supervisor 无测试、未类化 | 无 test 文件 | 复用受阻 |

---

## 9. 分阶段落地路径

| Phase | 内容 | 消除 | 规模 |
| --- | --- | --- | --- |
| **1 · 协议加固** | 78 退出码（ready 前失败）；退避+熔断；统一 worker 信号接线；gracefulShutdown 幂等守卫 | P0×2 | 半天 |
| **1.5 · 主动 HMR** | §2.8 全部清单 | P1-1 | 1 天（含测试） |
| **2 · 整树重启** | gracefulShutdown 两阶段拆分；rebootTree + ctx.kernel + keep 参数；system_restart scope 三档 | P1-4 | 1-2 天 |
| **3 · IPC 握手** | ready/beat/shutdown；超时与心跳处置；强杀升级 | P1-2/3 | 中 |
| **4 · 接线复用** | supervisor 类化+测试；`--supervised` 旗标 / Tauri sidecar / watchdog；uncaught 阶梯；ShutdownDeps 下沉；resolveEntry 清理 | P2 全部 | 中大 |

Phase 1 与 1.5 无相互依赖可并行；Phase 1 在 1.5 落地前是 dev 循环的唯一保障，优先做。

---

## 10. 待决策点

| # | 决策点 | 选项 | 建议 |
| --- | --- | --- | --- |
| D1 | L2.5 整树重启采纳？ | 采纳 / 维持 42 单层 | 采纳（回滚比停机安全） |
| D2 | reboot keep 集合默认值 | 钉传输行 / 全量 dispose | 钉传输行（keep 为参数） |
| D3 | system_restart 默认 scope | assembly / tree | assembly 起步 |
| D4 | 启动失败退出码 | 78 / 其他专用通道 | 78（sysexits 惯例） |
| D5 | uncaughtException 策略 | 全吞 / 直接 42 / tree 先行再 42 | tree 先行再 42 |
| D6 | watchdog 插件化 | 本期 / 延后 | 延后 Phase 4 |
| D7 | 发布入口监护 | `--supervised` 旗标 / 默认全监护 | 旗标起步 |

已拍板（不再列入）：被动 watch HMR 弃用；主动 HMR（L1.5）采纳为 dev 源码主通道。

---

## 附录 A：协议速查

```
环境变量   AGENTCHAT_SUPERVISED=1（supervisor 注入；isSupervised() 全层可读）
退出码     0 正常退出 · 42 请求重拉 · 78 启动配置失败(不重拉) · 其他 崩溃(退避重拉)
IPC        ready{port,profile} · beat(10s) · shutdown{reason}
时序       restartDelay 1.5s · backoff 1.5s·2^n cap 60s · bootOk 30s
           readyTimeout 120s · heartbeat 10s×3 · graceful 预算 20s → 强杀
L1.5       宣告完成(reload_modules) + 水位线发现 + ToolInterrupt(scope:'modules')
           → continue + patch → 本 run 下一 step 生效；失败回滚旧模块
reboot     root.update([]) → root.update(data) · keep 默认含传输行 · 不重载模块
铁律       supervisor 零业务依赖 · 不碰 .runtime · 机制在内核/策略在树 · 能低不高
```

## 附录 B：关键代码事实索引

| 事实 | 位置 |
| --- | --- |
| supervisor 退出码处置（42/0/崩溃固定 1.5s 重拉） | `boot/src/supervisor.ts:101-118` |
| Windows 信号假设错误 | `supervisor.ts:129-132` |
| dist 路径死代码 | `supervisor.ts:44` |
| `EXIT_RESTART=42` / graceful 链 / `requestRestart` | `boot/src/shutdown.ts:30,70-174` |
| uncaught/unhandled 吞 | `boot/src/bootstrap.ts:53-59` |
| 信号接线仅 dist 路径 | `bootstrap.ts:252-253` |
| 启动失败 `exitCode=1` | `boot/src/loader-boot.ts:176-179` |
| 中断-续跑-补丁 | `agent-loop/src/loop.ts:378-388` |
| reloadHandler（continue + patch） | `agents/src/config.ts:160-176` |
| register_plugin 先例 | `dev/src/plugin-tools.ts:109-112,146` |
| reload 警告指向 system_restart | `dev/src/tools.ts:245-253,258` |
| 「继续推理不戛然而止」测试 | `agent-loop/tests/loop.test.ts:250` |
| hmr `root:[]` 保机器 / 触发面 / 回滚 / externals | `vendor/hmr/src/index.ts:277-280, 265-267, 493-545, 260` |
| hmr 需 `--expose-internals` | `vendor/hmr/src/index.ts:120-122` |
| hmr 行 `disabled:true` + 过时注释 | `boot/src/composition.base.yml:30-47` |
| 行 deepEqual 短路 / replace 判定 | `vendor/loader/src/config/entry.ts:157-160,194` |
| 整组事务回滚 | `vendor/loader/src/config/group.ts:59-106` |
| internals 优雅降级 | `vendor/loader/src/internal.ts:120-131` + `config/tree.ts:154-160` |

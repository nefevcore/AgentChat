# 宿主服务通道（会话管道与服务通信解耦）

> 性质：域深设计——邮局协议扩服务帧通道，宿主控制/汇报通信迁出会话信封管道。
> 状态：现行 · cr-1175 2026-11-20
> 读者：改 `ac-post-office` / `ac-envelope-core` / 宿主收信面 / 壳侧行发送点的人；发版迁移执行者。

## 一、动机：一次类别错误的事故兑现

2026-11-20 现场（cr-1163 排查中实锤）：两会话调用 `restart_host` 均无「宿主已重启」注入。根因链：

1. 壳内工具把重启请求封装为**会话信封** `to: 'host'`（`packages/ac-shell-rows/src/restart.ts`），经邮局投递；
2. 宿主侧靠虚构 local 端点 `host`（`HostInbox`）收信——`to` 只是「可达表里叫这个名字的端点」；
3. 数据根存在用户创建的同名 Agent `host`；其壳被拉活时编排面 `markReachable('host', <pipe>)` **覆写**可达表项，宿主端点被劫持；
4. 此后所有 `to:'host'` 信封投进 agent `host` 的壳，按会话信消费（开桶、空 run、蒸发）——`agents/host/sessions/` 下 7 个 `restart-host-*` 污染桶为证；
5. 覆写可被**投递自身触发**：可达 miss → `ensureHook('host')` → 拉起同名 agent 壳——自激闭环。

结构性诊断：`to` 的语义是**会话参与者寻址**；宿主是基础设施进程，不是任何会话的参与者。控制指令穿会话信封是类别错误，三层代价全部兑现：路由层撞名劫持、登记层被迫伪造「host 域子会话键」骗过 participants 校验（cr-641 补丁为证）、落账层错投即静默污染。

## 二、现状盘点：寄生在会话管道上的六类通信

| 通信 | 发送点 | 原信封形态 | 语义本质 | 本案归宿 |
|---|---|---|---|---|
| restart_host 请求 | `ac-shell-rows/src/restart.ts` | message / budget 1 | 服务调用（要回执） | `host.restart` |
| restart-shell 重拉请求 | `apps/shell/boot.ts`（退出前） | message / budget 0 | 服务调用（尽力面） | `host.respawn-shell` |
| usage 计量自报 | `ac-ledger`（壳侧行） | receipt / budget 0 | 高频数据流（可丢） | `usage.report` |
| 标题落盘请求 | `ac-shell-rows/src/auto-title.ts` | message / budget 0 | 单向汇报 | `title.set` |
| 插件装卸请求 | `ac-shell-rows/src/plugin-dev.ts` | message / budget 1 | 服务调用（要回执） | `plugin.request` |
| grant 授权信 | `ac-shell-rows`（ask-grant） | message | 服务调用（要回执） | `grant.apply` |

共同寄生模式：壳内 `IpcClient` 直连邮局 socket → 伪装信封 → 宿主 `HostInbox` 虚构端点接住。`to:'user'` 不迁——`user` 是虚拟端点但**是真会话参与者**（终稿回信是会话语义），其正常是架构正确的偶然（无人建同名 agent），防御由 §五批 4 承担。

## 三、裁决

| # | 裁决 | 依据 |
|---|---|---|
| D1 | 会话信封回归纯会话语义——`to` 永远是会话端点；机制/控制/汇报通信**永不**走信封 | 根因是类别错误，隔板式修补（postClass 字段）治标不治本 |
| D2 | 邮局 socket 扩**服务帧**通道（第二协议位），与信封帧同口不同形 | 复用既有 IPC 传输与连接池；manage 通道 ctrl 帧已有先例（`{ctrl:'system', op:'shutdown'}`） |
| D3 | 服务通信按语义分两档：**request/response**（要回执）与 **report**（fire-and-forget 可丢） | restart/plugin/grant 需确认；usage 高频不可拥塞 run |
| D4 | 服务动词独立命名空间，注册面 `registerService(verb, handler)`——**不进可达表、不进 registry、永不触发 ensureHook** | 掐断劫持与自激链的三重根 |
| D5 | `HostInbox` 退役；迁移窗内留转发 shim（旧信封 → 新服务面 + W 日志），删除随下一次发版 | 版本混布窗口内旧壳仍发旧信封，硬删会复现污染 |
| D6 | agent 命名保留字校验（`host`、`user`、`@` 前缀）在创建面与拉壳面双闸落地 | `user` 端点的安全目前靠「没人撞」——校验缺位是真缺陷 |

## 四、协议设计

### 4.1 帧形（`ac-post-office` 传输层）

```ts
type ServiceFrame =
  | { svc: string; reqId: string; payload: unknown }          // request——期望 ServiceAck
  | { svc: string; payload: unknown };                         // report——单发即忘
type ServiceAck = { reqId: string; ok: true; result?: unknown } | { reqId: string; ok: false; error: string };
```

协议位区分：信封帧必含 `uuid`/`kind`；服务帧必含 `svc`。`IpcClient` 扩 `serviceCall(verb, payload, ms)`（request 档，超时即失败）与 `serviceReport(verb, payload)`（report 档，不等回执）；`IpcServer` 收帧按 `svc` 键分派，非本域帧原样直过（与信封收面同容错口径）。

### 4.2 动词词汇（owner 声明，`ac-post-office` 导出常量表——纯数据）

| verb | 档 | payload 要点 | 回执 |
|---|---|---|---|
| `host.restart` | request | `{ conversationId }` | `{ accepted: true }`（送达确认；完成通知仍走 §4.3 机制信） |
| `host.respawn-shell` | report | `{ agentId }` | 无（marker 落盘已兜底） |
| `usage.report` | report | 原 UsageReportPayload 原样 | 无 |
| `title.set` | request | 原 TitleRequestPayload 原样 | `{ applied: true }` + 前端 live 通知（§4.5，Q3 裁决） |
| `plugin.request` | request | 原 PluginRequestPayload | 原 PluginReceiptPayload |
| `grant.apply` | request | 原 GrantPayload | 原 GrantReceiptPayload |

### 4.3 宿主收面（`HostServiceDesk`，`ac-host-rows`）

boot 在邮局 listen 后装配；各行动词经 `desk.register(verb, handler)` 注册（usage 行 / plugin-registry 行 / auth 行 / boot 自有 `host.restart`·`host.respawn-shell`·`title.set`）。**重启完成通知不迁**：仍是宿主 boot 后向发起会话投机制信（`lane:'next-turn'`）——通知的收件方是会话，会话管道是它的正确归宿；本设计只迁「壳 → 宿主」的指令半边。

### 4.4 失败语义

| 档 | 失败面 | 行为 |
|---|---|---|
| request | 连接失败/超时/`ok:false` | 调用方收错（工具回执呈现「送达失败」——restart_host 既有文案语义不变） |
| report | 连接失败 | stderr 诊断一行即丢（usage 本就是尽力面；title 失败回落派生面） |

两档都**不落盘、不重试、不进 outbox**——outbox 是会话 at-least-once 面，服务帧永不进入。

### 4.5 前端 live 通知原则（D7，Q3 裁决 2026-11-20）

涉及前端 live 更新的服务动词，宿主处理完成即向前端推一次 live 帧（WS 广播），**发一次即忘**——不追踪前端是否在线/收到（at-most-once），完整性由既有回落通道兜底（前端刷新 = 重读盘面/索引）。适用：`title.set`（标题落盘即推，前端不用等刷新）；后续同类动词（如会话设置写盘类）依此原则纳入。回报语义：request 档的回执照常返回调用方（壳侧工具可观测成败），live 帧是面向前端的旁路通知，两者独立。

## 五、迁移计划（批次）

| 批 | 内容 | 验收 |
|---|---|---|
| 1 ✅ | `ac-post-office`：ServiceFrame 编解码 + client/server 扩展 + `HostServiceDesk` + 单测 | 帧往返 / 未知 verb 容错 / report 不等待（service-desk.test 6 例绿） |
| 2 ✅ | 六类发送点迁帧 + 宿主 handler 同批迁移（每 verb 一小步） | 各域既有单测绿（61 文件 392 用例）+ 定向真机（待运行时验证） |
| 3a ✅ | `HostInbox` 改转发 shim（旧信封 → desk + W 日志「旧协议帧」） | 同名 agent 在场时 restart_host 真机通过（待运行时验证） |
| 3b ✅ | 删 shim 与 `registerLocal('host')` + 四个 make*Envelope 请求构造器（全树新代码代后执行，2026-11-21） | `grep "to: 'host'"` 全仓零命中 ✅（src + tests） |
| 4 ✅ 代码面 | agent 命名保留字校验：创建面拒绝 + `ensureAgent` 拒拉 + **清理存量 agent `host`**（Q1 裁决：删除 `agents/host/`，7 个污染桶一并清——**删除待用户确认**） | 双闸单测 ✅ + `agents/host/` 不存在（待确认后执行） |
| 5 ✅ | 文档回勾：session-design / host-shell-decisions / migration-chain | 引用同步 ✅ |

## 六、验收清单（全案）

- [x] 同名 agent `host` 劫持不再可能（Q1 清理改变了「在场」前提，等价验收）：保留字三闸
      （创建面 / ensureAgent / createFromTemplate）拒斥 + 服务帧不经可达表——`host.restart`
      送达宿主不依赖端点寻址（真机探针 + 单测双证）。**2026-11-21 全链实机兑现**：送达确认
      → 宿主换代（pid 9904）→ 机制信注入原会话
- [x] usage 流：e2e 全链（真子进程壳 → 服务帧 → 聚合入账）绿；report 档无回执等待不拥塞 run
- [x] plugin/grant：request 档回执往返 + 拒收线（plugin-request-row / auth-registry-row 单测）
- [x] `ensureAgent('host')` 被拒（保留字闸）；可达表 `host` 项已随批 3b 消失（registerLocal('host')
      唯一调用者 HostInbox 已删——邮局纯信封形态不再有 host 端点）
- [x] 事故污染数据清理：`agents/host/` 整目录已删（2026-11-21 用户确认执行，7 个污染桶一并清）

## 七、裁决记录（2026-11-20 用户拍板）

| # | 议题 | 裁决 |
|---|---|---|
| Q1 | 存量 agent `host` 处置 | **清理**——批 4 删除 `agents/host/`（7 个污染桶一并清） |
| Q2 | 服务帧鉴权面 | 暂不需要——本机命名管道信任边界内，随 remote-relay 演进再议 |
| Q3 | `title.set` 档位 | **升 request 档**，并推广为 D7 通用原则（§4.5）——涉及前端 live 更新的服务动词，处理完成即发一次 live 通知（发一次即忘，回落通道兜底） |

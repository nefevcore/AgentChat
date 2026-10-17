# 协议规格 · 信封 / 锁 / 监护（工程规格草稿）

> 性质：工程规格草稿（preview 开工输入），非裁决。2026-10-14；2026-10-15 补
> A4（inbox 边界）与 F-8（budget 链式语义）。依据：per-agent 档案
> D2/D4（投递原语与行协议）、R-1/R-3（uuid 签发与确认）、R-7（指纹）、R-4（授权信）；
> shell-model S2（文件锁 / 监护）、R10 迁移（R-10）。配套：host-shell-row-manifest.md。
> 现状先例复用：cr-250 requestId 准入短路、MAX_AUTO_WAKES = 3、supervisor 42/78/0、
> ac-ws-protocol 帧结构。

# A. 信封（envelope）——一切投递的统一载体

## A1. 字段规格（v1）

```ts
interface Envelope {
  // —— 身份（R-1：发送方签发，UUIDv7 时间有序）——
  uuid: string;          // 会话身份键：首条消息发送方生成，随首消息投递，之后不变
  requestId: string;     // 投递幂等键：每封独立生成（UUIDv4 即可）；同键重发 = 接收方去重
  sender: EndpointId;    // 发送方端点：user | <agentId> | host | <childId>
  to: EndpointId;        // 接收方端点（扇出时为多播地址，邮局展开）
  // —— 会话（D4：participants 进 header，不进信封）——
  kind: 'message' | 'grant' | 'revoke' | 'receipt';
  //   message = 普通发言 / 任务信 / 终稿回复（回复不是特殊事件，R-2）
  //   grant/revoke = 授权状态变更信（域外唯一动作类，R-4/D3 修订）
  //   receipt = 观察回执（指纹 + 快照对位，R-7 五步闭环步 4）
  budget: number;        // 防自激预算：收到本信后至多可自动唤醒 run 的次数（D2：类 TTL）
  //   语义：每次自动唤醒 -1，0 = 不再触发 run（只落账不激活，不入 inbox——A4）；
  //   user 直发消息不减 budget（user 是预算之源）。缺省 = MAX_AUTO_WAKES 同源值 3
  //   （现状常量语义平移）。◐ 链式传播待钉（F-8）：配额挂 uuid 因果链而非信封
  //   独立——若每跳新配额，agent↔agent 互答循环每封都合法，防自激失效
  hop?: number;          // 邮局中继跳数（直投 = 0；每经一次发件箱滞留中继 +1）——诊断用，
  //   不参与裁决（budget 才是防自激的承重字段）
  payload: unknown;      // 按 kind 分型：message = 行协议消息体；grant = 授权变更单；
  //                        receipt = 指纹 + 快照元数据
}
type EndpointId = string; // 开放词汇：user / agent id / host / group 地址 / child id
```

## A2. 确认状态机（R-3 落账即确认）

```
信封生命周期：send → [通道] → acquire → delivered(落账) → acked → settled

acquire   接收方收到信封，requestId 入准入表（内存）
delivered 消息行落盘本端账本（journal/partials 台账）——**此刻即 ack**，ack 信封可回
acked     投递方收到 ack（或超时窗口内未见重复投递即视为达）
settled   本端 run 若被触发且收束（settlement 事件）——投递方无需等待（R-3 边界注记：
          落账即确认不保证触发 run；「账本有行但 run 未跑」窗口由 inbox 未消费标记兜底）
```

重投：投递方未收 ack 超时（缺省 30s 量级，R-3）重发同 requestId 信封；接收方去重
（重复即丢 + 补发 ack）——传输层重投与 run 期间到达消息的 inbox steer/next-turn 排队
**正交**（两层职责分离）。

## A3. uuid 与 requestId 的分工（一字之差）

- **uuid = 会话身份**（一次会话一个，永不重发）；
- **requestId = 投递幂等**（每封一个，重发不变）。
- 双方同时互发首条 = 两个 uuid 并存（特性非故障，回复按信封 uuid 路由不串，R-1）。

## A4. inbox 边界（消费面定义，2026-10-15 补）

inbox = **会触发 run 的信**的排队面（双队列语义承接现状：next-step = steer 注入
活跃 run；next-turn = 跨 run 队列）。分类维度 = 消费时机（何时消费），与信封
kind（是什么信）正交——**不设更多队列类型**。不进 inbox 的信：

- **receipt**：ledger 落账 + 经验流 / 快照链异步消费——不触发 run（指纹对拍与
  授权回执是结构化数据，无 LLM 消费价值；进队列只会占 budget、打断对话节奏）；
- **budget=0 的信**：只落账不激活、不入队（账本可查；user 直发新消息即重置
  满额——无人在场时收敛恰是期望行为）；
- **控制面动作**（abort / 收割 / 拉起）：能力调用（guardian 经 transportHint
  直连），非消息——进 inbox 排队等消费 = 停不下来；
- **grant/revoke 的生效**：不经 inbox——每 run 前重读授权投影（E 节最终一致），
  信封只在 grant 事务中当载体（对端 = 宿主 auth-registry，非 agent inbox）。

# B. 通道（transport）

## B1. 三通道与选用规则（D2）

| 通道 | 何时用 | 实现 |
|---|---|---|
| 邮局中继（宿主） | 缺省：宿主在场且对端经邮局注册 | 宿主 post-office 行：本机 unix socket / named pipe |
| 对端直投 | 宿主缺席（CLI 直连形态）或邮局不可用降级 | agent 间 unix socket（CLI 侧监听） |
| 发件箱滞留 | 对端不可达 | outbox/ 目录落盘，通道恢复后转投（durable，at-least-once） |

降级不改变语义只改变路径（D2）——三通道共用 A 节信封与确认状态机。

## B2. 帧格式（跨进程边界）

跨进程通道复用 ac-ws-protocol 帧结构（JSON 帧 + 消息路由表已验），本地 ipc 通道
（unix socket / named pipe）帧 = 同构 JSON + 长度前缀。**协议一套、通道多种**（M4 后
transport 单模式）。

## B3. 流式旁带（2026-10-15 定向，R7-3）

run 进行中的流式 token 帧 = ipc 连接上的**瞬态旁带**，非信封：无 uuid /
requestId / budget 语义（不幂等、不确认、不入发件箱——outbox 转投半截流是
重复播放，比丢弃更糟；正确语义 = 壳死即丢，客户端从账本收束态对齐——账本
兜底本来就在）。生命周期 = run 生命周期；路由 = 经宿主转发至 webui（单安全
边界 + 连接风暴吸收，裁决簿〈webui 读投影〉）。与 A4 receipt 不进 inbox 同族：不是
所有字节流都配当信件。

# C. activation 文件锁（S2 后果 4）

## C1. 锁规格

```
锁文件：agents/<agentId>/activation.lock
内容：JSON { pid, bootId, acquiredAt, transportHint }
  pid            持锁进程 OS pid（诊断 / 监护对账）
  bootId         本次 activation 的 UUIDv7（= 本次壳进程生命周期标识，日志关联键）
  acquiredAt     ISO 时间戳
  transportHint  壳监听地址（unix socket 路径 / named pipe 名）——邮局/监护直连用
获取：O_EXCL 创建 + 写入；已存在 → 读内容：pid 活 → fail-loud 拒绝（单例语义）；
      pid 死 → 陈锁，原子接管（rename 旧锁为 activation.lock.stale-<bootId> 后重建）
释放：进程正常退出（any exit）→ 节点进程启动时注册 exit handler 删除锁文件。
      **物理兜底：进程崩溃（SIGKILL / native crash）不跑 handler——由 OS 保证的文件
      存在性 + pid 探活判定陈锁，接管方负责清理**（锁的生命周期 = 进程生命周期，
      S2：崩溃即放锁）
```

## C2. 锁与账本写权的关系

锁 = activation 单例（谁在跑）；账本写权 = 账本所有权（谁在写）。持锁是写账本的必要
非充分条件——ledger 行在锁获取后才 boot（boot 编排序，非行序——activation-lock 是壳 boot 编排步骤非行，行集清单 v3 R0b/R4），
失锁（进程退出）即停写。跨壳迁移：现任收束 → 进程退出（锁随进程释放）→ 新壳获取
（P2-② 迁移语义）。

# D. 宿主监护信号（S2 监护职责）

> 2026-10-16 补充（cr-485）：宿主自身 boot 同形 = 清单驱动装配（宿主行集偏好文件 →
> ac-rowset-core 派生宿主清单；cordis.patch.yml / loader patches 退役）——两树同形
> boot，行集唯一来源 = 派生全域单一。见裁决簿〈patch 机制退役〉。

## D1. 信号面（宿主 guardian 行 ↔ agent 壳，stdio）

宿主拉起壳进程时经 argv 传递：数据根锚定、agentId、授权投影引用、行集清单引用（ac-rowset-core 派生）、（CLI 形态反向：
agent 拉宿主同款参数集）。壳在 stdout 按 TSV 输出生命周期信号（一行一事件）：

```
# boot 节拍（拉起 → 可用三节拍）
boot.lock.acquired     <bootId> <isoTs>            锁获取成功
boot.rows.ready        <bootId> <行数>             行集全部就位（= R-8 冒烟基结构态）
boot.ready             <bootId> <transportHint>    壳可用（transport 监听开启）——宿主收到
                                                    才把该 agent 标记为可达
# 运行期
run.started            <runId> <conversationId>    run 开始（健康监视粒度）
run.settled            <runId> <finish>            run 收束（finish: ok | interrupted | error）
guardian.ping          <isoTs>                     心跳（周期可配，缺省 30s；缺省 3 拍丢失
                                                    = 判死，宿主走拉起三节拍）
# 指纹自报（R-7）
fingerprint.root       <merkleRoot>                壳根（与宿主计算对拍——两形态同根断言）
```

stderr = 日志通道（宿主聚合进日志目录）。退出码沿用 supervisor 语义：42 = 请求重拉、
78 = 配置/组合失败（不重拉）、0 = 正常退出（idle-exit 收割走 0）。

## D2. 拉起三节拍与退避

```
节拍 1  spawn：宿主 guardian 起 node 壳进程（argv 带锚定参数）
节拍 2  adopt：boot.ready 到达 → 注册进可达表（之前该 agent 通信走发件箱滞留）
节拍 3  verify：fingerprint.root 到达 → 与宿主侧对该 agent 子树定义的期望根对拍——
         不一致 = 定义漂移 = fail-loud 事件（R-7 检验断言）
崩溃退避：连续 crash 计数（缺省阈值 3 次内 60s）→ 熔断：不再自动拉起，
         授权信通知 user（ask 形态），人工干预后清除计数
idle-exit：壳内长闲（缺省 15min 无 run / 无 inbox 待消费 / 无在途交互 /
         无在途 job——壳子进程 job 随进程蒸发，活跃 job 阻止收割）→ 进程退出
         （退出码 0），来件由宿主按需重拉（+200ms 冷启动，会话粒度生灭）
```

# E. 授权信（grant / revoke，R-4 / D3 修订）

```
payload（grant）: { asset: 凭据引用 | 插件行 id | MCP 服务器名 | 能力标签,
                   scope: per-agent | global, action: 'grant' | 'revoke',
                   priorFingerprint: 授权注册表指纹（变更前） }
流转：agent → 邮局 → 宿主 auth-registry 行（域外动作，durable 收件箱滞留，宿主在场
      处理）→ 回执信（kind: receipt，含新注册表指纹）进 agent 经验流。
生效时点：授权变更在**下一次读取**生效（最终一致，D3 代价 3）——壳每 run 前重读授权
投影，在线吊销最坏延迟 = 当前 run 收束 + 下次重读。
```

# F. 待钉参数表（◐ 动工时钉，全部带缺省建议）

| 参数 | 缺省建议 | 钉的时点 |
|---|---|---|
| ack 超时 / 重投间隔 | 30s / 指数退避上限 5 次 | 邮局 spike |
| budget 缺省值 | 3（MAX_AUTO_WAKES 同源） | 壳树 boot |
| 心跳周期 / 判死拍数 | 30s / 3 拍 | 监护 spike |
| idle-exit 阈值 | 15min | 监护 spike |
| 崩溃熔断阈值 | 60s 内 3 次 | 监护 spike |
| unix socket / named pipe 命名规则 | <dataRoot>/ipc/<agentId>.sock | 通道 spike |
| 锁 stale 清理保留 | stale-<bootId> 保留 1 个 | 壳树 boot |
| budget 链式传播 | 回复信封携带链剩余值（配额挂 uuid 因果链）；user 直发重置满额 | 邮局 spike（A1 注记：每跳新配额则 agent 互答循环防不住——现状串行化门按会话计数即链式，语义平移非新设计） |

# G. 与现状的关系（复用清单）

- requestId 幂等：cr-250 准入短路机制照搬，格式进信封标准化；
- 防自激：MAX_AUTO_WAKES=3 语义平移为 budget 字段（R-2a/D2 已裁「随信封携带」）；
- 退出码：42/78/0 原样沿用（supervisor-core 常量直接复用）；
- 帧结构：ac-ws-protocol JSON 帧；ipc 通道加长度前缀；
- durable 收件箱：inbox/ 目录机制（steer-stash 同构）。

## 本档案纪律

- 探索档案（explore/）：规格草稿；字段名与缺省值在 preview 实现时可能微调，语义
  （状态机 / 锁生命周期 / 三节拍）以裁决档案为准。正式立项时随两母档案迁 src/docs/。
- 引用规则：裁决依据写 R-n / D-n / S-n；待钉参数写 ◐。

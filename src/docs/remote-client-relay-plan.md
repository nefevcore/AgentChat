# 本地多端远程接入方案研究（remote-client relay plan）

> 研究动机：用户需要一个本地化多端方案——**AgentChat 宿主（harness）只跑在
> 自己的核心端（PC），绝不部署到云端**；其他端（安卓等）作为客户端经
> 中转服务器对接核心端。中转服务器要求"仅对接、不存储、不探测"，
> 并有网络攻击防护。本文分析该方案并给出推荐架构与落地设计。
>
> **文档定位（2026-10-06 文档治理合并）**：本文是该域（远程接入 + 移动端）的**唯一总文档**——
> 架构现状、已完成裁决史、仍开放项、移动端 UI 范式、交接与运维索引全部收在这一处。
> 合并来源三份（原件已移入 `src/docs/archive/`，映射与判定见 §10）：
> `remote-link-remaining-plan.md`（M1-M4 交接实况）、`remote-deliver-sender-ruling.md`
> （cr-78 单裁决）、`mobile-ui-paradigm-plan.md`（移动端 UI 范式）。
> **裁决链保留**：被取代的旧方案不删结论、只标注裁决过程（谁取代谁、为什么）；
> 历史裁决是记录不是待办，勿顺手恢复。
> 事实源纪律：本文以源码为准（`src/README.md` 为轨道事实源 > 各包源码 > 本文）；
> 与源码冲突处以源码为准并回改本文。

---

## 0. 需求还原与第一刀概念澄清

用户描述的是："以单端为核心，其他端通过服务器中转作为客户端操作核心端"。

**这里要先切一刀：这不是"数据同步"（sync），是"远程操作"（remote control）。**

- 数据同步（Syncthing/网盘模式）：多端各有副本，双向合并 → 冲突地狱。会话
  状态、Agent 记忆、记忆归档是持续演化的事件流，多主副本合并没有好结局。
- 远程操作（本方案）：**唯一真相源在核心端**（会话账本 ac-session、记忆、
  凭据全在 PC 的 data root），远程端只是一个"带加密信道的瘦客户端"，
  断线后重连按锚点拉取增量即可。

这个选择恰好是对的——AgentChat 的架构（事件积累 + 回放、文件即真相源）
天然支持"唯一真相源 + 派生视图"。**"同步"语义由核心端持久化账本免费获得，
中转服务器无需存储任何东西**（这是后文"不存储"设计的第一理据）。

## 1. 现状盘点：远程客户端所需的能力面已经存在

新轨道（src/）对"外部客户端"已经是完全面向服务的形式：

| 已有能力 | 位置 | 对远程化的意义 |
|---|---|---|
| HTTP API + WS RPC（registerRpc 表） | `ac-web-server` | 客户端的完整命令面（发消息/查历史/管理） |
| WS 事件桥（emit 面 → 帧） | `ac-ws-bridge` | 客户端的实时流（llm/delta-*、loop/*、router/*） |
| 单页 WebUI（纯静态产物） | `src/webui/dist` | 瘦客户端本体已经是一个浏览器 App |
| 显式暴露参数 | `WebServerRowOptions.allowedOrigins/allowedHosts` | 非回环绑定 + Origin/Host 校验的官方开口 |
| 会话账本 + 回放 | `ac-session` | 断线重连后增量拉取的锚点基础 |
| elevation 只升不降机制 | security-access-tier 体系 | 远程设备权限降级的现成挂点（agent 信封"恒剥除"同款思路） |

**当前的安全哲学**：`web-server` 默认只绑 127.0.0.1，无任何 token/鉴权——
"回环即信任边界"。这对本地单机是对的，但意味着：

> ⚠️ **任何远程化方案的第一前提：先补设备级认证与权限分档。**
> 现有 RPC 面对连上来的 WS 是全权的（含保存配置、装卸插件、带提权的
> deliver）。远程链路等于把全权控制面伸到手机上，手机丢失 = 核心端沦陷。
> 这不是传输层加密能解决的，是授权问题（见 §4.4）。

结论：**缺的不是客户端能力，是一条"安全延伸到远程"的传输与授权层。**

### 1.1 复核（2026-10-06）：本节所说"缺什么"已经补齐

上表能力面之外，本域实现件已全部落地（逐项源码核对）：

| 实现件 | 位置 | 状态 |
|---|---|---|
| Noise 原语库（XK/KK + AEAD + SAS） | `src/ac-noise-core/` | 落地（M1） |
| 核心端远程行（身份 / 设备注册表 / 配对状态机 / 连接管理 / RPC 转发） | `src/ac-remote-link/`（`service.ts`、`relay-connection.ts`、`identity.ts`、`device-registry.ts`、`http-bridge.ts`） | 落地（M1/P1） |
| 哑中继服务器 + 下载配额门 | `src/ac-relay-server/`（`index.ts`、`main.ts`、`download-gate.ts`） | 上线（M2，公网 `wss://47.110.63.135:8443`） |
| 设备页 + 配对二维码 | `src/ac-client-ui-remote/client/`（`RemoteDevices.vue`、`PairingQr.vue`） | 落地（P1；桌面视觉走查待用户确认） |
| 远程事件面并入桥接目录 | `src/ac-wire-format/src/bridge-events.ts` L193-196（`remote/device-paired` 等四事件）+ `index.ts` L38 `DIRECT_EVENT_PREFIXES` 含 `remote/` | 落地（cr-108） |
| 移动端壳（同一份 webui dist 双形态） | `src/ac-client-ui-layout/client/`（`MobileTabBar.vue`、`MobileMoreSheet.vue`、`AppFrame.vue`、`uiStore.ts`、`historyFlag.ts`）+ `src/webui-kit/src/base/Sheet.vue` | 落地（cr-29/30/31/32，见附录 A） |
| 本地全链路验证双件套 | `scripts/remote-loopback-host.ts` / `scripts/remote-loopback-client.ts`（各自独立自包含；最早的 `remote-loopback.ts` 原型已随 cr-285 退役） | 常备 |

两处与本节原始判断的差异（以源码为现状）：

1. **设备级认证已补**：Noise XK 配对 + 设备注册表 + 一键吊销均在位；但默认信任面未变——
   `web-server` 仍默认只绑 127.0.0.1，远程面走**出站** relay 链路，核心端不开新监听口；
2. **权限分档走了相反的路**：原设想的 scopes 逐方法白名单（M1 的 `SCOPE_ALLOWED_METHODS`）
   经 cr-105（2026-10-02 用户裁决）**退役**——“配对是本人扫码建立的信任，逐方法白名单是自我限制”。
   现行边界只剩两道：`deliver` 类 RPC 强制 `sender='user'` 改写 + elevation 剥除（cr-78，附录 B）；
   scopes 字段保留但仅余 `read`（下行事件过滤）语义（`src/ac-remote-link/src/service.ts` L745-750）。

## 2. 信任与威胁模型

### 2.1 资产清单（按泄露代价排序）

1. LLM API keys（存 core 端，AES-256-GCM）——最贵的直接资产
2. 全部会话历史与 Agent 记忆（等于全部隐私）
3. 核心端文件系统（Agent 工具可执行 bash/文件读写——远程命令面直达宿主）
4. 控制面（增删 Agent、装卸插件 = 在你机器上装代码）

用户"承担不起云端部署"的直觉即源于此：云端 harness = 1~4 全数上移。

### 2.2 攻击者位置 × 能看到什么

| 攻击者位置 | 本方案（E2E 加密中继） | 裸 VPS 部署 |
|---|---|---|
| 中继服务器运营者/入侵者 | **只有密文** + 元数据（在线时段、流量大小、两端 IP） | 全部明文 + 全部资产 |
| 中继被接管（MITM） | 密码学上无法解密/注入（握手绑定身份密钥） | 天然全权 |
| 网络路径窃听（咖啡店 WiFi） | 密文（wss + E2E 双层） | 密文（只有 TLS 层） |
| 手机丢失/被入侵 | 拿到远程设备凭据 → **可吊销**；权限分档限制爆炸半径 | 同左（但无吊销设计就完了） |
| 局域网其他设备 | 不可达（核心端不出公网、不监听 LAN） | 不适用 |

### 2.3 核心洞察："不存储不探测"必须是密码学性质，不是运营承诺

一台普通中继服务器在技术上**当然可以**记录转发内容（"不探测"无法从外部
验证）。所以设计目标不是"相信服务器不偷看"，而是：

> **让中继在数学上看不懂。** 端到端加密（E2E）之后，中继转发的每一帧
> 都是密文，"存储"变得无利可图，"探测"只能得到元数据。

配套三条工程保证（让承诺可验证而非可相信）：
- 中继**无持久化存储**（房间表在内存，重启即清空——安全特性，不是缺陷）；
- 中继**对房间存在性无反馈信道**（join 失败统一错误码，扫描探测无回声，见 §4.3）；
- 中继代码**开源 + 自部署**（单二进制 <500 行，任何用户可审计后自己跑）。

## 3. 方案对比与推荐

### 方案 A：Tailscale / 自建 headscale（❌ 已否决——多 App 不满足单 App 约束）

拓扑：手机与 PC 都装 Tailscale 客户端，组一个私网（WireGuard mesh），
浏览器直接访问 `http://agentchat-pc:3830`（tailnet 内设备名）。

- **为什么它满足"不存储不探测"**：协调服务器只存设备公钥目录、帮助
  NAT 打洞；数据面是 WireGuard E2E，即使流量经 DERP 中继，中继只见密文。
  信任模型与自建哑中继同级，而代码量为零。
- **手机端体验**：Tailscale App 常驻 + 浏览器/PWA 访问，多一步开关。
- **国内可用性**：直连成功率看网络环境；官方 DERP 延迟不稳定时可自选
  节点或自建 DERP（derper，现成 Go 单二进制）。
- **完全自主变体**：headscale（开源自建控制面）+ derper（自建中继）+
  Tailscale 客户端——服务器侧全是现成开源软件，不用写一行中继代码。
  代价是多维护一台协调服务器（低负载、低敏感——只存公钥目录）。

适用：**自己一个人用、接受装一个额外 App、不想写服务器代码**。
工程量：≈ 0（只有 web-server 绑定 tailnet IP + allowedHosts 配置 + §4.4 的
token 授权层）。

> **2026-09-15 用户裁决否决**：安卓侧只允许一个 AgentChat App，
> Tailscale 常驻 App 不可接受。本节保留作决策记录，不再进入路线。

### 方案 B：自建哑中继 + 单 App 安卓端（✅ 唯一路线，§4 详设）

拓扑：PC 与手机都**出站**连接自建 relay（一台最低配 VPS），relay 按
房间把一端的密文帧转发给另一端；E2E 加密 + 扫码配对。

- 优点：手机端**零额外 App**（浏览器直连 relay + WebCrypto 解密，纯 PWA
  可达）；信任模型完全自主可控；协议为自己产品量身定制（配对、吊销、
  权限分档都可做进协议）。
- 代价：要写并维护中继服务器（<500 行）+ 核心端 `ac-remote-link` 行 +
  手机端传输层；一台 VPS 的钱和运维（证书续期、进程守护）。
- 这是**体验与控制力的上限方案**，也是对用户原始设想最忠实的实现。

### 方案 C：frp（stcp 模式）——现成折中，不满足严格模型

frps 跑在 VPS，core 端 frpc 出站注册，手机端 frpc visitor 出站接入，
共享 sk 才能建映射。但：**隧道 TLS 在 frps 终结，frps 全程可见明文**；
sk 只是授权不是加密。等价于"把明文控制面交给中继运营者"——与
"不探测"目标直接冲突。仅当"中继运营者=自己且接受非 E2E"时可作
快速过渡，不推荐为终态。

### 否决清单

| 方案 | 否决理由 |
|---|---|
| Cloudflare Tunnel（cloudflared） | 免费零 VPS 很诱人，但 TLS 在 CF 边缘终结、CF 可见明文——"探测面"是企业的商业基础设施；与目标冲突（除非其上再叠自研 E2E，那就回到了方案 B） |
| VPS 上裸跑 AgentChat 开 3830 | 正是用户否决的"云端 harness"：四类资产全上云，且现有 RPC 面无鉴权 |
| 局域网直连（绑 0.0.0.0 + 访问 PC IP） | 现有 `allowedOrigins/allowedHosts` 参数支持，但**零鉴权 + 明文 HTTP**：同网段任何设备全权操作、可嗅探全部会话流。只适合完全可信的隔离网段，作为"最简临时档"须明示风险 |
| 多主数据同步（每端一份副本） | 见 §0：与"唯一真相源"架构相悖，冲突消解成本远超收益 |

### 推荐路线（2026-09-15 用户裁决更新）

**唯一路线：方案 B（自建哑中继 + 单 App 安卓端）。**

- 硬约束：安卓侧只装一个 AgentChat App——Tailscale（A）、Termux/
  浏览器（原 β/α 形态）全部出局；授权层与 E2E 层做进自家 App 与协议；
- 中继落国内云（阿里云/华为云，见 §4.3 国内云专题：IP + 自签证书
  绕开备案，认证职责在 Noise 层）；
- 急用过渡（App 未就绪期间）：可信隔离网段内临时开局域网直连档，
  用完即关——不作正式路线。

## 4. 方案 B 详设：哑中继 + 扫码配对 + E2E

### 4.1 角色与总览

```
┌─────────┐  出站 wss   ┌──────────┐   出站 wss  ┌─────────┐
│ 核心端 PC │ ─────────▷ │ 哑中继    │ ◁───────── │ 安卓手机  │
│ AgentChat │            │ relay    │             │ 单一App   │
└─────────┘  ◁──────────└──────────┘──────────▷ └─────────┘
   真相源、密钥持方        只转发密文帧        瘦客户端、设备密钥
   （Ed25519 身份）      （房间=两方管道）      （配对时注册）
```

设计原则：
- **relay 无协议理解**：只认 join/frame/ping 三种控制帧，业务帧一律
  opaque 密文转发——服务端想探测也无从下手；
- **两端皆出站连接**：核心端不监听公网/局域网端口（保持 127.0.0.1 哲学），
  relay 只需一个 wss 入口；
- **存储需求归零**：会话真相在核心端账本，relay 房间是纯内存管道。

### 4.2 配对协议（二维码 → Noise XK → SAS 比对）

**核心端长期身份**：Ed25519 静态密钥对，存 data root（`remote/identity`，
权限 600，首次生成）。它是整个信任链的根。

一次性配对流程：

```
1. 核心端「添加远程设备」：
   - roomId  = 32B random（urlsafe-b64，一次性）
   - 过期时间 exp = now + 5min
   - 二维码 = agentchat://pair?v=1
              &relay=wss://relay.example.com
              &room=<roomId>
              &pk=<核心端 Ed25519 静态公钥>
              &exp=<unix>

2. 手机扫码（扫屏幕 = 面对面的带外信道——**不要改成长发二维码图片**，
   图片若经 IM 转发，room id 即落入第三方服务器，攻击窗口内可抢先进房；
   扫屏是最强形态，远程配对则务必走加密信道）

3. 双方各自出站连 relay → join(roomId) → 房间封闭（恰好两方）

4. Noise XK 握手（发起方=手机，已从二维码带外获知核心端静态公钥）：
   - X 段：核心端静态公钥以加密形态传输（防被动窃听者收集身份）
   - K 段：手机验证对端确为二维码中的 pk —— 中继即使被接管，
     由于拿不到核心端私钥，**无法完成握手也无法 MITM**
   - 握手顺带加密传输手机自己的静态公钥（配对后生成并持久保存）

5. SAS 短认证串比对：SHA256(handshake_hash) 前 4 字节 → 8 位数字，
   核心端屏幕与手机屏幕各显示，人工核对一致才确认——封死"二维码被
   副录 + 攻击者窗口内抢先进房注册成合法设备"的残余通道（ZRTP 同款思路）

6. 核心端把 {deviceId, 手机静态公钥, name, scopes} 写入
   remote/known_devices.json → 配对完成，房间即销毁
```

**运行态重连（KK 模式）**：双方已知对方静态公钥 → 双向身份认证的
Noise KK 握手 → 新会话密钥；每次连接握手一次，帧内顺序计数防重放。
**吊销 = 从 known_devices 删除** → 下次握手直接失败。丢失手机后的
标准动作：任意客户端吊销 + （可选）换核心端身份密钥全量重配。

**帧格式**（本地 wire 协议原样嵌入）：

```
密文帧  = { n: <单调计数>, ct: <AEAD-ChaCha20/AES-GCM(k_send, n, payload)> }
payload = 与本地 WS 完全同构的 JSON-RPC 帧或事件帧
```

密文内载荷与本地协议同构 = **核心端与手机端各只需要一个"加解密壳"**，
业务层零改动。

### 4.3 中继服务器设计（"仅对接"的技术化）

API 全集（就这么大）：

```
GET  /healthz                  # 存活探测（无信息量：恒 200）
WS   /relay
     ← join {room}             → ok | room-unavailable | rate-limited
     ← frame {data:<opaque>}   → 原样转发房间另一端（不解析、不落盘）
     ← ping                    → pong（心跳兼保活）
```

**房间生命周期**（全部内存态）：

| 规则 | 值 | 理由 |
|---|---|---|
| ~~未封闭 TTL~~（cr-246 退役） | ~~5 min 无第二方 → 销毁~~ → 占座房与常住房统一：有心跳即活 | 配对短时效由二维码 exp 字段承担（cr-65）；占座（PC 常驻等对端）是合法形态，TTL 误杀 |
| 封闭即管道 | 恰好两方，第三人 join 一律 `room-unavailable` | 防抢答/旁观 |
| 房间存活（cr-70/72/246 统一） | 只认成员心跳：成员离线只移除该成员并通知幸存者 `peer-left`；任一方 >60s 无 ping 即踢；全员离场即销毁 | 消灭双端重试相位耦合（六轮时序补丁的结构解）；防滥用面不变——恶意占房须持续心跳，受 join 频控与 per-IP 房间配额约束 |
| 会话心跳 | 任一方 >60s 无 ping → 踢该成员（幸存者无责；房间随之可能空销） | 清理僵尸连接 |

**"不探测"的机制化**（不是承诺而是结构性质）：
- join 失败**统一错误码** `room-unavailable`——不区分"不存在/已满/已过期"，
  扫描探测得不到任何存在性回声；
- 帧转发不解析、不落盘、无日志内容字段（日志只允许错误码计数）；
- 无数据库、无磁盘卷——重启即失忆是特性。

**防滥用（公网开放服务的现实义务）**：

| 措施 | 缺省值 |
|---|---|
| 单 IP 并发连接 | ≤ 5 |
| 全局房间数上限 | ≤ 10k |
| 单帧大小上限 | ≤ 1 MiB（超限断连——RPC/事件帧远小于此） |
| 每 IP 令牌桶速率 | 30 msg/s 突发 60 |
| join 频率限制 | 10/min/IP（房间枚举的经济学防御） |
| 单房间流量上限 | 1 GB/天（超限销毁房间——防被当免费中转，国内云自保刚需） |

**部署加固清单**：
- 单二进制（Go/Rust/Node 均可，核心逻辑 <500 行）或 Docker：
  `read-only fs + cap_drop ALL + no-new-privileges + tmpfs /tmp`；
- systemd：`DynamicUser + ProtectSystem=strict + MemoryMax=256M + PrivateTmp`；
- TLS：有已备案域名走 Caddy 自动证书；国内云无域名场景用自签 +
  客户端 pin（见下方国内云专题——认证在 Noise 层，TLS 仅混淆层）；
- 运维指标只暴露计数器（连接数/帧数/字节数），无内容无来源。

**国内云（阿里云/华为云）部署专题**：

- **备案整个绕开——IP 直连 + 自签证书**：国内服务器绑域名开 80/443
  需 ICP 备案；但本方案认证职责全在 Noise 层（绑定 Ed25519），TLS
  降级为防被动嗅探的混淆层——自签证书完全够格（即使被 TLS MITM 也只
  劣化为 DoS：Noise 帧无法伪造/解密）。**零域名、零备案、零证书
  续期**，二维码直接写 `wss://<ip>:<高位端口>`。
- **安全组**：入方向放 relay 高位端口（如 8443）与下载面端口
  （80/443，见 §4.6）；SSH 走云厂商终端或限源 IP。
- **规格**：见 §4.6 选型表（结论：轻量 2C2G 档，流量包月 +
  账单告警）。
- **E2E 在国内云语境的额外价值**：云厂商镜像/快照/宿主机层面的窥探
  所见亦为密文（§2.2 表第 1 行的加强版）——"承担不起"的资产清单
  全部留在 PC。
- **封 IP 自保**：公网端口必被扫描，防滥用限额从礼貌升级为刚需
  （单房间日流量上限——防被当免费中转烧流量触发云厂商处置）。

**可审计性**：开源 + 单文件实现 + 固定 digest 的镜像 → "服务器不探测"
从口头承诺变成"你可以自己跑一份代码相同的实例"。

### 4.4 AgentChat 侧落地（授权层——传输加密之外的另一半工程）

新增出厂行 `ac-remote-link`（核心端）：

```
inject: webServer（复用 rpcTable 处理器与事件广播面）, config
形态  ：出站 wss 连 relay；Noise 壳；配对 UI；设备注册表
下行  ：事件帧白名单下发（会话流 llm/delta-*、loop/*、router/* 照常；
        配置变更/管理类事件默认不下发远程）
上行  ：远程 RPC 进入现有 registerRpc 表（cr-105 起全放行；deliver 类强制
        sender='user' 改写 + 剥 elevation——cr-78）
```

**权限分档（威胁模型里的"手机丢失"缓解）**——每个远程设备一条：

```jsonc
// remote/known_devices.json
{
  "devices": [
    { "id": "pixel-8", "pubkey": "...", "scopes": ["chat", "read"], "pairedAt": "..." }
  ]
}
```

- `read`：查历史/看板（默认）
- `chat`：发消息/中断/续跑（默认）
- `files`：文件读写工具（显式开启）
- `admin`：配置/装卸插件/系统管理（显式开启，永不默认）

> **裁决更新（cr-105，2026-10-02 用户裁决）：scopes 逐方法白名单退役。**
> M1 落地的 `SCOPE_ALLOWED_METHODS` 方法闸门已删——M1 以来两次真实事故
> （cr-66 空档黑屏、cr-104）后用户裁决「只防必要的，不防自己」：配对本身是本人
> 扫码建立的信任，逐方法白名单只防自己。**现行边界**：① `deliver` 类 RPC 由
> `forwardRpc` 强制 `sender='user'` 并剥 elevation（防伪造端点，附录 B）；
> ② scopes 字段保留为设备属性，`read` 仍用于下行事件过滤
> （`src/ac-remote-link/src/service.ts` L745-750），但不再闸方法；③ admin 档不再是闸门语义。
> 设备注册表结构不变：`{ id, name, pubkey, scopes, pairedAt, lastSeenAt? }`（`device-registry.ts`）。

**elevation 恒降级**：远程来源的信封（deliver RPC 的 elevation 通道）
对 remote-device 恒剥除——完全复用现有"agent 信封恒剥除"的机制位置，
远程设备永远不能借提权通道武装。文件/bash 工具对远程会话走最严档位。

**安卓端：单 App 形态（2026-09-15 用户裁决：只装一个 AgentChat App）**——
Capacitor 壳打包 `src/webui/dist` + 原生传输半边，一个 APK：

| 层 | 实现 | 说明 |
|---|---|---|
| UI | Capacitor WebView 加载内置 webui dist | 现有 WebUI 零改动（手机端是同一前端的窄屏形态：cr-28~32 已落地，见附录 A） |
| 传输 | 原生 Kotlin 壳 ~300 行：OkHttp（CertificatePinner 锁自签指纹）连 relay wss + noise-java E2E 解密 + localhost 明文 WS 回环喂 WebView | WebView 只见 loopback 明文——与本地开发完全同构；自签 TLS、Noise 原语、Keystore 等 Android 细节全封原生层 |
| 密钥 | 设备静态密钥对入 Android Keystore（硬件 backed，导出不可行） | 丢机 = 私钥不可提取 + 核心端一键吊销 |
| 配对 | 系统相机扫核心端二维码 → deep link（agentchat://pair）唤起 App → SAS 数字比对页 | 免打字 |
| 锁 | 生物识别解锁才连 relay；后台保活按链路态分派（cr-109：已配对且 CONNECTING/ONLINE 持部分唤醒锁 + 前台服务通知，其余形态切后台即断） | 丢机缓解纵深（原「切后台即断开」被真机省电策略实锤改判——后台静默杀 TCP 使「回前台必重连」成常态；重连循环自带 10 分钟上限，持锁时长有界） |

发布：APK 不上架商店——自托管分发（§4.6 下载面直出 APK，
国内直连免翻墙）；App 内版本检查对照同机 manifest.json
（sha256 校验通过才安装）。
App 的 relay 地址来自配对二维码（换服务器 = 重扫配对码；核心端按设备
公钥识别老设备、仅更新落点，设备身份不变）。

> 备选组合（若不想写 Kotlin）：传输层全放 WebView JS（WebSocket +
> tweetnacl.js 实现 Noise），仅自签 TLS 需配 network security config
> 信任锚——省原生代码但密钥落 WebView 存储，安全性弱于 Keystore。
> 推荐原生传输半边。
>
> **实况（2026-10-06 复核）：已按原生半边落地**——Kotlin 移植 `ac-noise-core` 的 Noise
> 模块 + OkHttp CertificatePinner + localhost 回环桥；实施记录见
> `src/docs/archive/m31-android-transport-implementation.md` 与
> `src/docs/archive/m32-android-loopback-bridge.md`。WebView JS（tweetnacl）与 noise-java
> 两个备选均未采用（密钥必须进 Keystore = 原生半边）。

**断线语义**：真相源在核心端——手机离线期间消息全部入账；重连（新 KK
握手）后按 conversationId 用现有 history/replay RPC 拉取增量（GroupFeed
readSince 锚点模式的同构物）。relay 全程无存储角色。

### 4.5 残余风险（诚实清单）

| 风险 | 程度 | 缓解 |
|---|---|---|
| 元数据泄露（在线时段/流量大小/两端 IP 对 relay 可见） | 不可消除 | 接受；极致可加 padding/恒速发送（收益有限，不建议首期做） |
| 核心端自身被入侵（供应链/恶意插件） | 与本方案无关 | 本地安全域问题（现有 access-tier 体系的主战场） |
| 安卓端浏览器环境被入侵 | 低 | 单 App 生物锁 + 短会话 + 吊销响应演练 |
| relay 服务器被 DDoS | 可用性问题非机密性问题 | 换 IP/多实例；E2E 保证即使打不挂也不泄密 |
| 用户自己忘吊销丢失的手机 | 人因 | 设备页默认按最后活跃排序 + 30 天未活跃提醒复审 |

### 4.6 分发面与服务器选型（同机双面——2026-09-15 需求合并）

需求合并：各端安装包放本服务器下载（不进 git/Releases），与 relay
共机。**双面分离**是本节的核心设计：

| 面 | 端口 | 内容 | 暴露策略 |
|---|---|---|---|
| 下载面 | 80/443（Nginx/Caddy 静态目录） | Win 安装包（0.8.5 实测 ~92MB）/ 安卓 APK（~30MB 预估）/ `manifest.json` | 公开可扫——只放不敏感的公开产物 |
| relay 面 | 8443 | 密文房间管道 | 默认拒绝扫描，房间存在性零反馈（§4.3） |

> 与 §2.3 同一思想的部署面表达：**公开面只放不敏感的东西，
> 敏感的东西全在密文管道里。**

**下载面防护四件套**（公开端口的现实义务，2026-09-15 需求定稿）：

1. **只读挂载**：静态根目录独立于系统盘内容，`autoindex off`；
   可下载项由 `manifest.json` 显式列出，不靠目录浏览；
2. **同 IP 限流**：`limit_req`（如 1r/m + burst 3，只对安装包扩展名）
   + `limit_conn` 单 IP 并发 2 + `limit_rate` ~2MB/s——防重复下载与扫刷；
3. **全局配额门**（2026-09-15 用户裁决：**200 次/月**——现阶段未宣传、
   仅数名同事使用；宣传后按需上调）：Nginx 做不了跨重启
   全局计数，配一个 ~60 行 Node download-gate——计数持久化在
   `/var/lib/agentchat-gate/count-<YYYYMM>.json`，未超限走
   X-Accel-Redirect 内部发文件（不经 Node 转发字节），超限 403
   「本月下载配额已用完」；只计安装包扩展名（主页/manifest 命中不计）；
   附带 `GET /api/quota`（JSON：剩余次数，供主页展示）；
   **成本数学**：200 次 × 92MB ≈ 18GB ≈ ¥15/月出流量上限——配额门
   本身就是流量费的硬顶；
4. **账单告警**：云监控设月流量阈值（如 20GB）——配额门之上的
   第二道网（relay 流量不走配额门）；触发后查 Nginx top IPs 封禁。

**版本清单与信任锚分离**：`manifest.json` =
`[{platform, version, url, sha256, size}]`——**同一份文件进两处**：
服务器 `/downloads/manifest.json`（数据源）+ git 仓库（信任锚）。
HTTP 无证书完整性 → **git 存哈希、服务器存字节**：客户端更新检查从
git raw（HTTPS）取 manifest（可信），安装包从服务器取（快），落地前
用 manifest 里的 sha256 校验——MITM 换掉服务器上的字节也过不了校验，
公网 IP 免备案 HTTP 分发即可成立。

**分发链（CI → 服务器，2026-09-15 需求定稿：安装包不进 git）**：

1. `desktop.yml` 改造：`--publish always` → `--publish never`（不再
   建 Release/传资产）；构建后 `rsync`（GitHub secrets 配
   `SERVER_HOST`/`SERVER_USER`/`SSH_PRIVATE_KEY` 部署钥）把
   `AgentChat-Setup-x.y.z.exe` / AppImage / dmg / zip 上传到服务器
   `/var/www/agentchat/downloads/<version>/`；随后跑 manifest 生成脚本
   （扫产物算 sha256/size，合并进 manifest.json）上传服务器 + 提交回
   git 仓库（bot commit，小文本文件）；
2. `publish.yml`（npm 包）不动——npm 信任链与安装包分发无关；
3. **主页**：服务器静态 `index.html` fetch manifest.json 渲染版本列表
   （平台/版本/大小/sha256 折叠展示），顶部显示剩余下载配额
   （fetch download-gate `/api/quota`）——零服务端渲染，仍是静态面；
4. **桌面自动更新改造**（牵连点，✅ 2026-09-21 已落地）：`desktop/main.mjs` 的
   electron-updater feed 指向 GitHub Releases，安装包搬走后失效——
   已退役 electron-updater，改为 ~30 行 manifest 检查（直接取下载面
   manifest → 比版本 → 提示「前往下载」打开主页；裁决放宽：不经 git raw
   中转——检查走 HTTP manifest 本身，完整性校验在安装包下载页侧 sha256），
   三平台同构（macOS 本就只提醒不自动装，行为不变）；安卓 App 同构
   （§4.4 已定）。
   同批落地：WebUI `system/version-check` 双源化（下载面 manifest 主源 +
   GitHub 兜底，`ac-web-api/src/version.ts`）。
   **2026-09-24 演进（用户裁决：不做静默安装；静默预下载免打扰）**：壳层
   后台自动下载新版安装包（sha256+size 双校验），完成不提醒；版本面板
   「立即安装」经壳桥拉起暂存安装包（win=NSIS 向导——覆盖安装自动带出
   HKCU InstallLocation 记的原目录）。NSIS `/S` 全静默安装仍不启用。
   发布侧同批加闸（用户反馈安装包损坏）：desktop.yml 三腿上传后 sha256
   读回校验，不一致 fail——异常包进不了 manifest。
   **2026-09-24 下载韧性**：壳层下载器改 `<file>.part` + 原子改名 + HTTP Range
   断点续传 + 3 次指数退避重试（哈希不符则丢弃重下，坏前缀不续传）。实测
   下载面 accept-ranges: bytes（206 Partial Content）——续传链路有效。
   **2026-09-24 macOS 签名修复**：`mac.identity` = null 曾使 electron-builder
   完全跳过签名（handleNullIdentity），未密封 bundle 在 Apple Silicon 原生
   执行被判「已损坏」（x64 走 Rosetta 宽容故不复现）——改 `"-"` ad-hoc 签名，
   降级为常规「未验证开发者」右键打开。公证（Developer ID）仍未做。

**选型**（实测依据：Win 安装包 92MB、webui dist 3.9MB、安卓 APK
预估 ~30MB——全家福 ~150MB/版本）：

| 项 | 结论 | 依据 |
|---|---|---|
| CPU/内存 | 2核2G | relay ~100MB 内存常驻、静态文件 CPU≈0；余量留给运维探针/日志轮转/ssh 排查 |
| 磁盘 | 40-60GB 系统盘（档位标配） | ~150MB/版本 ≈ 数百个版本；云快照另算 |
| 带宽 | 轻量套餐选流量包大、峰值带宽高的档；或 ECS 按流量计费 + 上限 10~30Mbps | 固定 4Mbps 档下 92MB 安装包要 ~3 分钟；流量制 + 三件套防账单失控 |
| 地域 | 与 PC/手机就近（华东/华南） | relay 延迟与下载速度双赢 |
| 计费 | 流量包月 + **到期续费提醒** | 活动价机器到期恢复原价是常态；续费或迁移（迁移 = 重出配对码，设备身份不丢） |

厂商对齐：阿里云轻量 / 华为云 FlexUS 同 ECS 底座、同档竞对
（2C2G 流量包月活动价约 ¥8~15/月），按当时活动价取低者即可。

**采购清单（2026-09-14 阿里 ECS 官网折扣价实测，华东1·杭州）**：

| 件 | 规格 | 价格 | 选型理由 |
|---|---|---|---|
| 实例 | `ecs.e-c1m1.large`（经济型 e，2C2G） | ¥19.86/月 · ¥184.19/年 | 四大地域同价；弃 t6-c4m1（¥8.5 但 512MB 内存 + CPU 积分限制，Node+Nginx+系统会挤爆）；e 族共享 CPU 无积分约束，relay 负载 ~0 完全够 |
| 系统盘 | ESSD Entry 40GiB | ¥14/月 · ¥142.8/年 | 弃 ESSD AutoPL（¥1/GiB/月）：静态文件柜 IO≈0，Entry ¥0.35/GiB 省 65%；若购买页不兼容则升 ESSD 云盘（¥0.5/GiB） |
| 带宽 | **按流量计费**，峰值上限设 10Mbps | ¥0.8/GB（用量估 <5GB/月 ≈ ¥4/月） | 计费面 = **公网出方向全部流量**（安装包下载 + relay 密文帧 + 一切响应）；入方向免费。临界点 29GB/月（固定 1Mbps ¥23 ÷ 0.8）——低用量选流量制省 ¥19/月；且流量制峰值可设高：92MB 包 @10Mbps ≈ 74s，@固定 1Mbps ≈ 12min |
| 快照 | 可选，或关闭 | ~¥1/月 | 数据全是可重建的（relay 无状态 + 安装包本地有），快照仅护系统配置 |
| 操作系统 | **Ubuntu 24.04 LTS**（次选 Alibaba Cloud Linux 3） | 免费 | NodeSource/apt 一行装 Node 20+、社区教程最多、5 年支持到 2029；Alinux 3 阿里维护内核/CVE 但三方仓库偶有兼容小坑。勿选：Windows Server（许可费+耗内存）、CentOS 7（EOL）/Stream（滚动） |
| **合计** | — | **~¥38/月 · 年付 ~¥375/年（~¥31/月）** | 实例+盘年付（有小折扣），流量按量 |

> 购买入口提示：此为 ECS"零件价"；**先看当期轻量应用服务器套餐**
> （2C2G 含流量包活动价约 ¥8~15/月）——若套餐价低于零件价且带宽
> 满足（流量包 ≥300GB/月），直接买套餐更省心。套餐不满足再回 ECS
> 组装件。华为云 FlexUS 同理（本数据集未含，需另取价对比）。

## 5. 威胁 → 缓解对照总表

| 威胁 | 方案 B 缓解 | 落点 |
|---|---|---|
| 中继偷看/记录内容 | E2E（Noise + AEAD），中继只见密文 | 协议层 |
| 中继被接管（MITM） | 握手绑定核心端 Ed25519 身份（XK/KK） | 协议层 |
| 二维码被副录抢配 | room 短时效 + 单次 + SAS 人工比对 | 配对流程 |
| 房间扫描探测 | 统一错误码 + join 限速 + 高熵 room id | relay |
| 中继被当免费代理滥用 | 连接/帧/速率/大小四重限额 | relay |
| 下载面被扫/刷流量（公开端口的代价） | 只读挂载 + 限速限连 + 账单告警（触发后封禁 top IPs） | 下载面（§4.6） |
| 明文经公网 | 双层（wss + E2E），任一破另一层仍在 | 传输层 |
| 手机丢失 | 设备可吊销 + scopes 分档 + elevation 恒降级 | 授权层 |
| 重放/注入 | 帧单调计数 + AEAD + 每连接新握手 | 协议层 |
| 离线消息丢失 | 真相源持久账本，重连锚点拉取 | 核心端（已有） |

## 6. 分期路线

| 阶段 | 内容 | 交付 |
|---|---|---|
| M1 | `ac-remote-link` 核心端行：Noise 壳 + 出站连接 + 设备注册表 + 配对 UI（二维码 + SAS）+ scopes 闸门 + elevation 恒降级 | 协议就绪 |
| M2 | relay 服务器：Node/TS 单文件 <500 行（入 monorepo 作 `src/ac-relay-server/`）+ 国内云部署（自签 TLS + 安全组 + 防滥用限额）+ 下载面（Nginx 静态目录 + manifest.json + download-gate 配额门 1000/月 + 四件套防刷 + 主页 index.html）+ `desktop.yml` 改造（rsync 上传 + manifest 生成） | 同机双面上线：中继 + 安装包分发 |
| M3 | 安卓单 App：Capacitor 壳（webui dist 零改动）+ 原生传输半边（OkHttp pin + noise-java + loopback 回环）+ 扫码配对 + 生物锁 | 一个 APK |
| M4（可选） | 设备管理成熟化（多设备、按设备审计日志、登录提醒）+ 分发与版本面（桌面/安卓统一 manifest 版本检查——退役 electron-updater，git raw 取 manifest + 服务器下载 + sha256 校验） | 运营完善 |

（原型验证捷径：M3 之前先用 Node 写 ~50 行 loopback 客户端冒充安卓端，
在 PC 上对通 relay + Noise 壳 + RPC 全链路，再投安卓工程。）

### 6.1 交付实况（2026-10-06 复核）

| 里程碑 | 状态 | 证据（源码/记录） |
|---|---|---|
| M1 核心端 | ✅ 完成 | `src/ac-noise-core/`（XK/KK/AEAD/SAS 纯库）+ `src/ac-remote-link/`（身份/注册表/配对状态机/连接管理/RPC 转发）；实况见 `src/docs/archive/m1-remote-link-implementation-plan.md` |
| M2 relay + 下载面 | ✅ 已上线 | 公网 `wss://47.110.63.135:8443`；relay 协议 e2e 8/8；服务器与下载面实况见 §7 |
| P1 管理 RPC + loopback 全链路 + webui 设备页 | ✅ 完成 | XK 配对 / SAS / 加密 RPC / KK 重连本地全通（`scripts/remote-loopback-*`） |
| P1 尾巴 | 🟡 仅剩 1 项 | 1.0 relayUrl 三层配置（热更）、1.1 设备页、1.1.1 设计系统对齐、1.3 真二维码（cr-43 ④）均已落；**1.2 前端事件驱动刷新未做**（见 §9） |
| M3 安卓单 App | ✅ 完成（2026-09-30 收口，cr-43~54） | 真机 Redmi K20 全链路；记录 `src/docs/archive/m3-handoff-20260929.md` 与 `m31`~`m35` 系列 |
| M3.x 手机端体验 | ✅ 主体完成 | 保活/重连风暴（cr-109）、占座会合根因（cr-255）、提速双压缩（cr-257/259）、requestId 幂等准入（cr-250）、移动端 UI 范式（cr-28~32，附录 A） |
| M4 设备管理成熟化（可选） | ⬜ 未实施 | 多设备并发在线真机验证 / 按设备审计日志 / 登录提醒 / 30 天未活跃提醒——四项均未动（见 §9） |

里程碑级实施记录（M1/M3 各阶段、安全审计两轮）已按归档纪律收在 `src/docs/archive/`：
`m1-remote-link-implementation-plan.md`、`m3-handoff-20260929.md`、`m31`~`m35-*.md`、
`relay-security-audit-2026-10-01.md`、`relay-security-audit-round2-2026-10-01.md`。
本文件只保留**当前事实态**与仍开放项。

## 7. M2 落地实况（2026-09-15）

**relay 面（wss://47.110.63.135:8443）已上线**：

- 包 `src/ac-relay-server/`（RelayCore 纯逻辑 13 测试 + main.ts ws/TLS 适配
  + download-gate.ts 配额门 + esbuild 双 bundle）；
- 服务器：systemd `agentchat-relay`（DynamicUser + LoadCredential 凭据注入
  + ProtectSystem=strict）+ 自签 TLS（CN=IP，10 年）；
- 公网 e2e 8/8：join/封闭/第三者统一 room-unavailable/双向帧/ping-pong/
  离线销毁/垃圾断连（复跑脚本 `scripts/relay-e2e.mjs` 已随里程碑归档为
  `src/docs/archive/scripts/relay-e2e.ts`）；
- 踩坑存档：①房间级 setInterval 不 unref 会钉死事件循环（删，统一全局
  sweep）；②esbuild ESM bundle 需 createRequire banner（ws 的 CJS require
  内建模块）；③LoadCredential 路径是 `/run/credentials/<unit>.service/`。

**下载面（http://47.110.63.135/）已上线**：

- Nginx + `agentchat-gate`（12700）：manifest/主页静态直出；安装包按扩展名
  路由 → gate 计数 → X-Accel-Redirect → `^~ /_internal/`（**必须 ^~**：
  正则 location 会让内部重定向回环再进 gate——404+配额照扣的坑）；
- 限流：limit_req 1r/m burst 3 + limit_conn 2 + limit_rate 256k；
- 配额门：1000/月持久化 `/var/lib/agentchat-gate/`，`/api/quota` 主页展示；
- manifest：`gen-manifest.mjs` 服务器侧扫目录生成（releases/files 嵌套形，
  sha256+size），git 双写接 CI（desktop.yml 已改造：--publish never +
  rsync + gen-manifest；**待配 secrets**：SERVER_HOST/SERVER_USER/
  SSH_PRIVATE_KEY 部署钥）；
- 验收：主页 200 / manifest 1 版 / range 下载 206 + MZ 魔数 + 配额递增。

**遗留（用户动作）**：GitHub secrets 三项 + 服务器部署钥、AK 轮换（AK 已
在聊天记录暴露）、22/3389 安全组收紧（workbench 通道已可全运维）。

## 8. 结论

1. 用户方案（单核心端 + 哑中继 + 扫码配对）**方向正确**，与项目
   "唯一真相源 + 回环信任边界"的既有哲学完全同构；
2. 两处必须修正的直觉：
   - "不存储不探测"要靠**密码学结构**（E2E + 无反馈信道 + 无持久化）兑现，
     而非服务器运营承诺；
   - 远程端拿到的是控制面不是镜像，**授权层（scopes + 吊销 + elevation
     剥除）是与传输加密同等重要的一半工程**；
3. 执行上（2026-09-15 用户裁决更新）：**B 为唯一路线**——安卓单 App 是硬
   约束；授权层（scopes + 吊销 + elevation 剥除）与 E2E 传输层全部内建
   于自家协议与 App；中继落国内云，IP + 自签证书绕开备案，认证职责
   始终在 Noise 层。
4. 同机双面（2026-09-15 需求合并）：安装包分发与 relay 共用一台轻量
   服务器（2C2G、流量包月 + 账单告警）——公开的下载面只放不敏感
   产物并配四件套防刷（含 1000 次/月配额门 + 同 IP 限流），敏感通信
   全走密文 relay 面；两面的暴露策略刻意不对称（§4.6）。分发链
   信任锚分离：**git 存哈希、服务器存字节**，桌面与安卓统一走
   manifest + sha256 校验（electron-updater 退役）。

## 9. 仍开放项（2026-10-06 现状清单）

| # | 开放项 | 事实依据（源码核对） | 归属 |
|---|---|---|---|
| 9.1 | **P1 尾巴 1.2：设备页改事件驱动刷新**——后端转发面已就绪，前端仍 2s 轮询 | `RemoteDevices.vue` L202 仍 `setInterval(() => void refresh(), 2000)`；而 `remote/device-paired` 等四事件已在共享桥接目录（`src/ac-wire-format/src/bridge-events.ts` L193-196）且 ws-bridge 按目录通用订阅（`src/ac-ws-bridge/src/index.ts` L80-87）——**故 cr-108 之后本项只剩前端消费侧改动**（onEvent 驱动 + 轮询降频 10s 兜底） | 本仓可实现 |
| 9.2 | P1 尾巴 1.1：桌面端视觉走查待用户确认 | 设置左树「远程设备」节（order 95）；走查点＝链路状态卡（未配置引导）/ 设备列表（在线点 + 吊销）/ 配对向导三态 | 用户动作 |
| 9.3 | 移动端 Phase③ 真机验证轮待设备 | 键盘（adjustResize）/ tab / Sheet / 返回键逐层退出；清单 `src/docs/archive/m3-realdevice-checklist.md`。**本机无移动端仓**（`仓库根/../AgentChatMobile` 不存在），壳侧项按文档自述在档、未在本仓复验 | 待设备 |
| 9.4 | 移动端 Phase② 遗留：设置面板（SettingsPanel）窄屏仍是既有形态，未纳入 Sheet 化 | 文档自述（cr-30 实况）；按真机反馈决定是否跟进 | 待反馈 |
| 9.5 | color-mix 残量消化 | 棘轮上限已由 **12 下调到 9**（`scripts/check-webview-baseline.mjs` L40 `CSS_COLOR_MIX_CAP = 9`）——文档旧值 12 是 cr-32 时点值；消化一处即下调本数 | 持续 |
| 9.6 | M4（可选，未实施）：多设备并发在线真机验证 / 按设备审计日志 / 登录提醒 / 30 天未活跃提醒 | 四项均无实现落点（`ac-remote-link` 无审计日志与提醒面） | 待定 |
| 9.7 | M2 服务器侧遗留（用户动作，文档自述）：GitHub secrets 三项 + 部署钥、AK 轮换（AK 曾在聊天记录暴露）、22/3389 安全组收紧 | §7 尾「遗留」节 | 用户动作 |
| 9.8 | 移动端渲染性能（cr-258 立项，独立文档 `src/docs/webui-mobile-render-perf-plan.md`） | 该文档是独立在跑的方案，**不在本次四份合并范围内**，此处仅作索引 | 另文档 |

**引用残留待收口（本域外文件，本次未改，报母任务）**：`src/README.md:895`（设计档案索引行）、
`cr-log.md:47` 与 `cr-log.md:70`（历史 CR 记录，只读纪律）、`src/ac-remote-link/src/service.ts:666`
代码注释（指 `remote-deliver-sender-ruling.md` → 应指向本文附录 B 或归档路径）、
`src/docs/archive/` 内 6 处（m1 L132、m3-handoff L4、m31/m32/m33/m34/m35 头部上游引用——归档件不改）。

## 10. 合并与归档记录（2026-10-06）

本文件由四份文档并一份（治理批次 cr-269，本域分派）：

| 原文档 | 判定 | 归并落点 |
|---|---|---|
| `remote-client-relay-plan.md`（域总方案，M1-M4 全景） | 保留为基底并重写为当前事实态 | 本文全文（§0-§8 原有架构与裁决，§1.1/§6.1/§9 为复核新增） |
| `remote-link-remaining-plan.md`（M1-M4 交接，状态快照） | 合并后归档 | 状态表 → §6.1；协议约定表/关键文件索引/本地复现方法/踩坑存档 → 附录 C；1.2 尾巴 → §9.1；手机端优化（cr-109）→ §6.1 与 §4.4 |
| `remote-deliver-sender-ruling.md`（cr-78 单裁决） | 合并后归档 | 全文裁决链 → 附录 B |
| `mobile-ui-paradigm-plan.md`（移动端 UI 范式） | 合并后归档 | 诊断/目标范式/裁决/分期/实况/cr-32 收口 → 附录 A；Phase③ 真机轮与 Phase② 遗留 → §9.3/9.4；color-mix 残量 → §9.5 |

归档件路径：`src/docs/archive/remote-link-remaining-plan.md`、
`src/docs/archive/remote-deliver-sender-ruling.md`、`src/docs/archive/mobile-ui-paradigm-plan.md`
（`git mv` 保历史）。原始结论与裁决过程未做删除——被取代项一律标注「谁取代谁、为什么」。

## 附录 A：移动端 UI 范式重设计（cr-28~32 全史）

> 来源：`src/docs/archive/mobile-ui-paradigm-plan.md`（2026-10-06 合并）。
> 立项 cr-28（2026-09-28）。背景：M3.x 安卓远端链路已收口（配对/传输/回环桥/分发），
> 手机端使用反馈「不方便」——本节裁决 webui 移动端范式重设计方案、分期与落地实况。
> 事实基线：安卓端 = Capacitor 6 壳 + WebView（minSdk 28 / targetSdk 34）加载回环桥上的
> 同一套 webui dist，**一份前端服务桌面与手机两端**。

### A.1 诊断：范式不匹配，不是样式缺陷

现有布局是 VSCode 工作台范式（AppFrame 五席：activity-bar / primary-sidebar / main /
aux-sidebar / overlay），为桌面大屏「多面板并行观察」打造。手机端痛点（均有代码依据）：

| # | 痛点 | 依据 |
|---|---|---|
| 1 | 48px 活动栏常驻吃掉约 1/8 屏宽，窄屏价值低 | `ActivityBar.vue` 固定宽列 |
| 2 | 抽屉是覆盖不是导航：选完会话抽屉还糊在屏上 | `drawerVisible` overlay 模式 |
| 3 | 无「进入会话」心智：桌面三栏并存，手机预期是「列表 → 会话 → 返回」栈式导航 | 无页面栈概念 |
| 4 | Android 返回键 = 退出 App：SPA 无路由，按返回直接 finish → onStop 断链路回配对面板 | MainActivity 无 onBackPressed 处理 |
| 5 | 辅助侧栏窄屏只有零星 Modal 兜底，入口分散 | `uiStore` 各 `open*` 手写 `isNarrow` 分支 |
| 6 | 断点双源：CSS `@media 768` 与 JS `isNarrow()`（即时读 `innerWidth`）跨界瞬间不同步 | `uiStore.ts` `isNarrow` |

**根因**：多面板并行范式与单窗口栈式导航的手机范式冲突——修补 CSS 治不了根。

### A.2 目标范式：消息 App 栈式导航

架构有利条件：壳件席位驱动，行包（agents/singles/conversation/runview…）只插席位、
不关心排布。**移动化 = 壳层换一种排布，席位契约零改动**（插槽-插头原则的直接收益）。

目标形态（≤768px）：

- **root 页**：整页列表（主侧边栏三面板之一）+ 底部标签栏（会话 / Agent / 运行 / 更多）；
- **push 页**：点会话/群/Agent → 全屏会话页滑入（≤200ms），标题栏汉堡变返回；
- **更多 sheet**：头像配置 / 主题切换 / 全局设置 / 数据备份 / 检查更新 / 插件动作收编；
- **返回键**：关最顶层覆盖（sheet → 会话页 → root 页 → 才允许默认退出）。

关键裁决：

1. **活动栏 → 底部标签栏**（拇指区）；未读徽章复用聚合 computed（抽到共享模块后由
   ActivityBar 与 MobileTabBar 同源消费，不复制实现）；
2. **抽屉退役**：主侧边栏三面板在手机 = root 页整页切换（tab 驱动 primaryPanel），
   点列表行 = push 会话页；keepAlive 语义不变（chat 视角文档流保活，草稿/滚动天然保留）；
3. **返回键接入**：mobile 壳 onBackPressed → 经 JS 桥查询导航栈（会话页开则关之，否则默认退出）；
   裁决点是「返回键必须先过导航栈」而非通道选型；
4. **aux 窄屏整体隐藏 → 全屏 Sheet**：各 `open*` 的窄屏分支统一收编（Phase ②）；
5. **断点单源**：`matchMedia('(max-width: 768px)')` 一处定义（`uiStore` 响应式 `narrow`），CSS 断点对齐同值；
6. **桌面零变动**：同一 AppFrame 两形态，`v-if` 级隔离；≥769px 行为与现状逐像素一致。

明确不做（裁决记录，勿恢复）：

- 不引入 vue-router（席位选举已是导航层；栈式导航用壳层状态承载，避免双导航源）；
- 不做手势返回（Android 返回键先行；侧滑手势 WebView 92 兼容性不确定，价值/成本比低）；
- 不改行包席位契约（AgentList/SessionList 等只删自家抽屉 CSS，选中语义不变）。

### A.3 分期与落地实况

| 期 | 内容 | 状态 |
|---|---|---|
| ① 导航范式 | 底部 tab 栏 + root/push 页导航 + 返回键 + 汉堡变返回 + 断点单源 | ✅ cr-29（2026-09-28） |
| ② 覆盖层全屏化 | aux 选区/设置面板窄屏统一全屏 Sheet；webui-kit 出 `Sheet.vue` 原语 | ✅ cr-30（2026-09-28）；设置面板遗留见 §9.4 |
| ③ 品质收口 | adjustResize 键盘钉死；color-mix 构建期回退 + webview 基线判据；触摸三件套；safe-area 令牌 | 🟡 cr-31 部分落地 + cr-32 完成 color-mix；真机验证轮待设备（§9.3） |

**Phase① 落点（cr-29）**：`uiStore` narrow 单源（`matchMedia 768` 响应式；`togglePrimary` 窄屏 no-op）、
`mobileMainOpen` push 态 + `pushMainIfNarrow`/`closeMobileMain`、`openTrackingView`/`openPairView`/
`openSubagentView` 内嵌 push、抽屉态全链退役（`drawerVisible`/`toggleDrawer`/`closeDrawer`/overlay 与五处复制 CSS 全删）。
AppFrame 窄屏 root/push 双层；活动栏与 aux 窄屏隐藏；返回键消费链（`registerBackConsumer` provide 通道 + `historyFlag` 桥）。
新增 `MobileTabBar.vue`（会话/Agent/运行/更多四 tab，消费 `useUnreadBadges` 单源）、`MobileMoreSheet.vue`、`historyFlag.ts`。
`useUnreadBadges` 归位 conversation（feed 的家）——初版落 layout 触发 R5 运行时环，归位消环，未入白名单。
`ConversationHeader` 汉堡钮变返回钮；`ActivityBar` 未读聚合迁共享模块；四列表删 `mobile-close-btn` 与 `@media` 抽屉块、选中改 `pushMainIfNarrow()`。
壳侧 `MainActivity` onBackPressed → `evaluateJavascript` 查询 `__agentchatBack()`；未消费则 `moveTaskToBack`（不 finish，链路不断）。

**Phase② 落点（cr-30）**：`AuxSidebarHost` 窄屏改**全屏 Sheet**（宽屏原形态零改动，选区注册面零改动；
辅助活动栏窄屏不渲染）；`uiStore` 加 `auxPaneStyle` 宽度单源与 `openAuxPanel(def)`/`closeAux()`；
`MobileMoreSheet` 加「面板」区（列 `auxSidebarRailDefs` 全量 + available 过滤 + badge），成为手机端九个选区的唯一入口；
`Sheet.vue` 加 `full`（满高/无圆角/让安全区）与 `keepAlive`（v-show）两档；
usage/prompt/preview 三处「窄屏 Modal 兜底」退役统一走 aux 意图通道（删 `FilePreviewModal`/`SystemPromptModal` 两组件 +
一个 overlay 贡献 + 三标志与配对 close；`TokenUsageHost`/`FilePreviewHost` 退化为零渲染意图宿主——watch 必须住 overlay 常驻组件，
选区宿主 volatile 卸载即收不到意图帧，这是既有裁决）；返回键消费链由单值升为**栈**（Set + 倒序询问）。

**Phase③ 落点（cr-31/32）**：`windowSoftInputMode="adjustResize"`（壳侧，文档自述）；
base.css 全局触摸三件套（`-webkit-tap-highlight-color: transparent` + `touch-action: manipulation` + `overscroll-behavior: none`）；
safe-area 令牌 `--safe-top/--safe-bottom` + `viewport-fit=cover`（cr-29 已前置）。

**color-mix 收口（cr-32，2026-09-28 已落地）**：核心洞察——`color-mix(in srgb, C N%, transparent)`
在预乘 alpha 插值下语义恰等于「C 以 N% 不透明度着色」，故等价物是 `rgba(var(--x-rgb), N/100)`，只差一个 RGB 三元组令牌。
落地：tokens.css 双主题补 `--primary/-text-1/-2/-3/-ok/-warn/-err-rgb`（改色须与 hex 同改，有测试锁）、
`badge.css` 九个 `tt-*` 色相类补 `--tag-hue-rgb`；动态星色 `--sc`/`--tc` 是运行时内联值，组件同时注入伴随变量（`starColor.hexTriplet`）；
确定性 codemod 转 123 处（含嵌套 `var()` 回退的括号平衡解析）；无法表达者保留 `color-mix` 但**同属性前置静态回退声明**（渐进增强）。
防回归：构建期棘轮（`scripts/check-webview-baseline.mjs`，上限只减不增——**现值 9**，§9.5）+ 令牌三元组三锁测试。
验证手段（无设备替代）：本地探针页加载构建产物 CSS，读回**解析后的计算样式**（比肉眼截图可靠），并实锤一处级联缺陷
（组件规则内写 `--tag-hue-rgb` 缺省值压掉色相类）。副产品（测试反哺零冗余）：清掉 4 个未被消费的三元组条目。

**流程发现（值得登记）**：Phase① 删抽屉按钮时 `RunTrackingPanel` 模板残留一个多余 `</div>`——
`pnpm typecheck` 与 `pnpm webui:typecheck`（vue-tsc）**双双放过**，只有 `pnpm webui:build`（模板编译器）报 `Invalid end tag`。
教训：模板结构性破损是 vue-tsc 的检测盲区，**动了前端模板的改动应把 `pnpm webui:build` 纳入验证阶梯**（同时跑 webview 基线守门，成本约 1 分钟）。

**验证口径（沿用）**：桌面回归 `pnpm typecheck && pnpm test:unit && pnpm check:deps` + 定向 eslint + `pnpm webui:typecheck`；
窄屏验证 = devtools 手机模拟（768 以下）+ 真机 `chrome://inspect`（cr-15 基建）；壳侧 `gradlew assembleDebug`。

**实施注意（风险项，仍适用）**：① 选中动作窄屏分派点收敛为 `uiStore.pushMainIfNarrow()` 单点（勿散弹特判）；
② 返回键桥接通道优先壳内 `evaluateJavascript`（零新依赖）；③ push 页滑入用 transform（不触发重排），
chat keepAlive 在隐藏 pane 中继续上屏（v-show 语义）；④ tracking 视角窄屏以 pushed page 兜底，`exitOverlays` 协议原样适用。

## 附录 B：远程 deliver 信封裁决——sender=user，设备溯源留链路层（cr-78）

> 来源：`src/docs/archive/remote-deliver-sender-ruling.md`（2026-10-06 合并）。
> 日期：2026-10-01 · 裁决级：行为修改（`forwardRpc` 强制改写面）。
> **2026-10-06 复核：裁决已是现状**——`src/ac-remote-link/src/service.ts` L667 `p.sender = 'user'`，
> 注释（L661-666）直接指向本裁决。

### B.1 问题

移动端（已配对设备经 relay 链路）发起会话时，deliver 信封的 sender 该取 `user` 还是 `remote:<deviceId>`？
M1 落地时按上游方案 §4.4 取了后者，本轮全链审计发现它造成 1v1 直答路径的实际缺陷。

### B.2 sender 与 source 的契约分工（`ac-agent-loop/src/contract.ts`）

- `sender` = 发送方端点 id（M19 全对键桶模型：`user` 只是端点之一，viewer 虚拟 Agent id；委托 = 发起 Agent id）；
- `source` = 拓扑类（`'user'` 直答 / `'agent'` 委托 / `'event'` 机制触发）。

两者的机械消费点（sender 有、source 无——source 只进事件行与预算判定）：

| 消费点 | 位置 | 行为 | sender=remote:xxx 的后果 |
|---|---|---|---|
| 直答桶键派生 | `ac-web-api` conversation/deliver（现 `src/ac-web-api/src/index.ts` L697 `pairKey(sender, agentId)`） | conversationId = pairKey(sender, agentId)（前端直答不传 conversationId） | 消息落桶 `remote:xxx~agent`，与桌面 `user~agent` 分裂 |
| 历史读侧 | feed 读侧 `requestHistoryPage` | 恒用 `bucketKey(VIEWER_ID='user', agent)` | 手机刷新后读不回自己发的消息 |
| 流式门控 | feed 读侧 `isForCurrentUser` | sender≠'user' 且桶含 viewer → 帧被拦截 | 回复流式帧被丢弃或落矩阵格分区 |
| 提权水位/会话覆盖 | `ac-conversation` deliver | 按 conversationId 写 conv-settings | 写入错桶——手机提权/模型覆盖对桌面会话不生效 |
| 排队/工具估算 | web-api `queueConversationId` / tool-defs | 同款 pairKey 派生 | 全部错位 |

注：前端直答路径不传 conversationId（chat-core deliver 注释：边界算则前端透传，D3 原则）——
sender 是桶键的唯一输入，前缀直接决定桶。

### B.3 remote: 前缀无机械消费者

全仓 grep：`remote:` 只在 `forwardRpc` 的改写处出现，没有任何代码基于该前缀做判定。
安全审计（`src/docs/archive/relay-security-audit-round2-2026-10-01.md` 链路 E）列举的缓解——
剥 elevation、scopes 闸门、admin 档禁用——分别依赖 `sanitizeElevation(source)` 与方法白名单，均与 sender 前缀无关。
`remote:` 只提供描述性溯源，不提供强制力；为它付出桶分裂的代价不成立。

**裁决史（保留，勿恢复）**：M1 时期该前缀合理（当时无 M19 对键桶模型，sender 尚未成为桶键输入）；
M19 后它成了缺陷源 → cr-78 改回 `user`。（cr-105 之后 scopes 方法白名单亦退役，见 §4.4 的裁决更新。）

### B.4 裁决（四条）

1. **sender = `'user'`**：手机是同一 viewer 端点的另一块表面，不是社交图里的新端点——直答桶键、
   流式门控、历史读侧、conv-settings 全部自然对齐；
2. **source = `'user'`**（保持不变）：远程输入在拓扑上就是用户直答，这条原本就对，不动；
3. **保持强制改写，不删字段**：改写面本身就是防伪造屏障——配对设备可自行传 sender 冒充其他端点
   注入 agent⇄agent 桶（source 同理），必须由 `forwardRpc` 强制覆盖；
4. **设备溯源留链路层**：remote-link 层已有 deviceId 在手（`handleDevicePayload` 入口），审计/日志需要时
   打一行即可，不进信封。未来若真需信封级溯源，加专用字段（如 `via`），不挪用 sender。

### B.5 改动面（含 2026-10-06 复核结论）

| 文件 | 改动 | 复核 |
|---|---|---|
| `src/ac-remote-link/src/service.ts` | forwardRpc DELIVER_METHODS 改写：`sender='user'`（原 `remote:` + device.id），注释更新 | ✅ 在位（L667，注释 L661-666） |
| `src/ac-remote-link/tests/remote-link.test.ts` | 新增断言：chat 设备 deliver 转发参数 `sender==='user'`、`source==='user'`、无 elevation | ✅ 在位 |
| `src/docs/archive/m1-remote-link-implementation-plan.md` | §1.4 判定逻辑行同步 | 归档件（本轮不动） |
| `src/docs/mobile-link-diagram.html` | 卡片文字同步（sender=user + 剥 elevation） | HTML 图谱件，原样保留 |

## 附录 C：交接与运维索引（M1-M3 实况沉淀）

> 来源：`src/docs/archive/remote-link-remaining-plan.md`（2026-10-06 合并）。
> 原文档是「下个会话的开工文档」；合并后**有效部分**在此，已收口部分只留实况索引。

### C.1 全链路本地复现方法（自检基准，2026-10-06 复核脚本均在位）

```
（1）本地 relay（源码直跑，绑回环；明文分支已修为 node:http）
    cd src/ac-relay-server
    RELAY_PORT=18443 RELAY_HOST=127.0.0.1 npx tsx src/main.ts

（2）宿主（bootTree 全组合树；data root 固定 sandbox/loopback-data）
    npx tsx scripts/remote-loopback-host.ts

（3）客户端（冒充手机；身份持久化在 sandbox/loopback-identity.json）
    npx tsx scripts/remote-loopback-client.ts --relay ws://127.0.0.1:18443 --rpc ws://127.0.0.1:3839 --reconnect
    老设备直连（跳过配对）：加 --skip-pair

（4）客户端打出 SAS 后，另开终端代答确认（模拟 WebUI 用户点「一致」）
    node 一行脚本调 remote/pair-confirm（sessionId + accept: true，照客户端脚本里的 rpc 写法）
```

### C.2 协议约定（必须与本仓实现一致——M1/P1 实跑沉淀）

| 约定 | 内容 | 代码参照 |
|---|---|---|
| 身份密钥 | X25519 静态对（不是早期文档概称的 Ed25519）；二维码 pk = 核心端 X25519 公钥 base64url | `ac-noise-core` StaticIdentity |
| roomId 编码 | 满足 relay 校验 `[A-Za-z0-9_-]{22,43}`：配对房 = `p` + 18B 随机 b64url；重连房 = `r` + SHA256(core_pub‖deviceId‖device_pub) 前 17B 的 b64url（双方各自可算，免协商） | `ac-remote-link/src/service.ts` startPairing / runDeviceConnection |
| XK 载荷位置 | m1 载荷空；设备信息 JSON（name、pubkey）放 m3（加密段——设备公钥不以明文过 relay） | `relay-connection.ts` + loopback 客户端 |
| KK 进房竞态 | relay 只转发实时帧——m1 早于对端入房即丢。发起方 3s 超时整链重试（新 dial 新握手新 e）；宿主端 kkRetries 上限 10 次、间隔 1s 重排 | 双侧 catch 路径 |
| 业务帧 | `op=frame` 的 data 里 `n` + `ct`：n = 单调计数，ct = base64url AEAD 密文；载荷 JSON 与本地 WS 帧同构（`type` + `data`） | `relay-connection.ts` sendPayload |
| RPC 往返 | 手机发 `rpc/call`（method、requestId、params），回 `rpc/result`；cr-105 起全放行（deliver 类强制 sender/user 改写 + 剥 elevation） | `service.ts` forwardRpc |
| SAS | SHA256(handshake_hash) 前 4 字节转 8 位数字，两端显示比对 | sasFromHandshakeHash |
| relay 控制帧 | `join{room}` 应 `joined` 或 `room-unavailable`；`ping` 应 `pong`（心跳兼保活） | `src/ac-relay-server/` |

### C.3 关键文件索引（2026-10-06 复核）

| 文件 | 职责 |
|---|---|
| `src/ac-noise-core/src/index.ts` | Noise XK/KK + AEAD + SAS 纯库（约 490 行）；测试向量 `tests/noise.test.ts`（RFC 7748 x25519 可直译 JUnit） |
| `src/ac-remote-link/src/service.ts` | RemoteLinkService：身份/注册表/配对状态机/连接管理/RPC 闸门 |
| `src/ac-remote-link/src/relay-connection.ts` | 出站 ws + join + responder 握手 + 帧泵 |
| `src/ac-remote-link/src/{identity,device-registry}.ts` | 持久化（0600 原子写 / 吊销即删） |
| `src/ac-remote-link/src/http-bridge.ts` | 回环 HTTP 桥（scopes 档位闸退役后方法闸在桥层自身） |
| `src/ac-relay-server/src/main.ts`（+ `index.ts` / `download-gate.ts`） | 服务器传输适配（明文分支 node:http + `/healthz`）+ 配额门 |
| `src/ac-client-ui-remote/` | webui 远程设备节（settings:section 贡献，order 95） |
| `src/ac-wire-format/src/bridge-events.ts` | 桥接事件目录（含 `remote/device-*` 四事件，cr-108 并源） |
| `scripts/remote-loopback-{host,client}.ts` | 本地全链路验证双件套 |
| `src/ac-web-server/src/service.ts` 的 `callRpc` | 对 web-server 的唯一侵入点（远程 RPC 复用 rpcTable 处理器） |

### C.4 手机端链路硬化（cr-109，2026-10-02；原「二b 手机端优化」）

**后台保活**：原「切后台即断开」被真机实锤否掉一半——省电策略后台静默杀 TCP，「回前台必重连」成为常态。
新语义：**已配对且链路活动（ONLINE/CONNECTING）时 onStop 不断链**，改持 CPU 部分锁（WAKE_LOCK + PARTIAL_WAKE_LOCK）
+ 前台服务通知（文案随 state 流投影）；其余形态（未配对/ERROR/配对确认期）保持即断。回前台解锁。
重连循环自带 10 分钟上限，后台持锁时长有界。

**重连风暴修复**（手机侧三处结构缺陷，与 PC 侧 cr-67/cr-43⑮ 同族）：
1. `stop()` 打不断在途 KK 尝试循环——内层 10 轮 dial 不感知 stop。修复 = 会话 epoch 代数（stop 递增，尝试循环逐轮校验自弃）；
2. 断链触发源不去重——旧链残骸迟到的 onClose 无条件拉新循环，把健康新链当 stale 清掉重连（`relay === rc` 身份校验后才触发）；同族：换链排旧改 cancel（RST 立断）；
3. `resumeOnline` 与退避循环可并发——双 `tryReconnect` 同房互踩占满 2 席把 PC 关在门外（`reconnectJob?.isActive` 去重）。

验证：`gradle compileDebugKotlin + assembleDebug` 过（唯一警告为存量 deprecation）；transport JVM 测试全绿。
真机验收项（**仍开放，见 §9.3**）：① 在线态切后台 5 分钟回前台——链路应仍 ONLINE；② relay 日志确认后台期无 1006 撞门风暴；③ 未配对态切后台仍即断。

### C.5 公网 relay 对接注意

地址 `wss://47.110.63.135:8443`，自签证书——OkHttp 需 `CertificatePinner` pin sha256 指纹或信任自签
（认证职责在 Noise 层，TLS 仅混淆——见 §4.3）；手机侧 `pair-start` 拿到的 qrUri 里 relay 参数已 URL 编码，
deep link 解析后先 unescape；relay 心跳超 60s 无 ping 断连——客户端空闲 ping 间隔设在 30s 内。

### C.6 踩坑存档（原「下个会话勿重蹈」六条，全部仍适用）

1. relay 明文分支必须 `node:http`——https server 对明文握手静默挂起（写安卓本地联调脚本时同理）；
2. 事件目录文件（`declare module` 形态）必须有顶层 export 空对象，否则整个导入图在 tsc 下降级出数千假错；
3. 行内 RPC 访问自身服务：apply 里 `new Service(ctx)` 直持实例引用，不要在 inject 数组里声明自身服务名（自引用等待死锁）；
4. `types/node` 细节：chacha20-poly1305 的 setAAD 必带 plaintextLength；x25519 私钥 JWK d-only 形态 node 拒收——PKCS8 DER 包装 + clamp 后导入；
5. Node strip-only 加载器禁参数属性（`constructor(private x)` 形态）——TS 编译能过、运行时炸；
6. loopback 客户端身份必须落盘（模拟 Keystore），宿主 data root 必须固定——否则每次重启都算新设备，KK 重连房间永远对不上。

### C.7 2026-10-05 后的链路硬化增量（cr-log）

cr-250 requestId 幂等准入（ws/ack deduped + `.deliver-seen.json` 跨重启短路）、cr-256 chunk 失败弹窗分流
（rpc 探活替代循环重载）、cr-257/259 双向 gzip + RPC 帧压缩（公网 160KB 应答 1.2s → 秒开）、
cr-255 占座会合根因（kkTargetPubkey 在首握等待之后赋值 → waiting-peer 收 m1 后无法会合）、
cr-274 启动等待反馈（ONLINE 后覆盖层文案过渡到「正在加载界面」，轮询 webui `__agentchatBootReady`
标志撤层；index.html 首帧 splash 覆盖 HTML 已到 JS 未跑的空窗；断线提示上提 AppFrame 全局连接条）、
cr-275 链路级断线横幅（真机实锤桥链解耦后 wire WS 无感断线——RemoteSession 状态流广播
`remote/link-state` 事件帧，AppFrame 消费；真机验证断网 6s 横幅出现、恢复后自愈）。

> **维护约定**：本域新事实直接改本文——里程碑进展进 §6.1、开放项进出 §9，不再另起文档（一份域一份总文档）。

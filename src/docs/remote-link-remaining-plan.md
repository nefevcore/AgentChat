# 远程链路后续工作交接（P1 尾巴 + M3 安卓端 + M4 可选）

> 前置阅读：src/docs/remote-client-relay-plan.md（总方案）→
> src/docs/m1-remote-link-implementation-plan.md（M1/P0/P1 实况，含已修复缺陷清单）。
> 本文是下个会话的开工文档——自包含，按序实施即可。

## 0. 当前状态快照（2026-09-22 收口时）

| 里程碑 | 状态 | 验证方式 |
|---|---|---|
| M1 核心端（noise-core + remote-link 服务） | 完成 | 单测 9+6；全仓 2011 过 |
| M2 relay 服务器 + 下载面 | 早已上线 | 公网 wss://47.110.63.135:8443（e2e 8/8） |
| P1 管理 RPC + loopback 全链路 + webui 设备页 | 完成 | 本地实跑：XK 配对、SAS、加密 RPC、KK 重连全通 |
| P1 尾巴（见一、节） | 待办 | — |
| M3 安卓单 App（见二、节，主战场） | 待办 | — |
| M4 设备管理成熟化（见三、节，可选） | 待办 | — |

全链路本地复现方法（写完 M3 前的自检基准）：

（1）本地 relay（源码直跑，绑回环；明文分支已修复为 node:http）
    cd src/ac-relay-server
    RELAY_PORT=18443 RELAY_HOST=127.0.0.1 npx tsx src/main.ts

（2）宿主（bootTree 全组合树；data root 固定 .dsh/tmp/loopback-data）
    npx tsx scripts/remote-loopback-host.ts

（3）客户端（冒充手机；身份持久化在 .dsh/tmp/loopback-identity.json）
    npx tsx scripts/remote-loopback-client.ts --relay ws://127.0.0.1:18443 --rpc ws://127.0.0.1:3839 --reconnect
    老设备直连（跳过配对）：加 --skip-pair

（4）客户端打出 SAS 后，另开终端代答确认（模拟 WebUI 用户点「一致」）
    node 一行脚本调 remote/pair-confirm（sessionId + accept: true，照客户端脚本里的 rpc 写法）

## 一、P1 尾巴（小项，半天内可清完）

### 1.0 relayUrl 配置（已实现——热更通道）

三层配置（优先级从高到低）：

1. 全局设置层（推荐，热更即时生效）：config.json 的 settings 域——
   UI 设备页中继行「配置/修改」按钮在线填写
   （config/set 到 settings.remoteLink.relayUrl，config/changed 后服务对账、
   自动断开旧连接、无需重启无需重新配对）；
2. 行配置层：cordis.patch.yml（本机行偏好，不进 git）给 remote-link 行接 config；
   cordis.yml 出厂态永不写（F10 守卫）；
3. 缺省：空 = 静默待机（UI 显示「未配置」+ 配置按钮引导）。

公网 relay：wss://47.110.63.135:8443（自签——认证在 Noise 层）。
本地开发：起本地 relay 后填 ws://127.0.0.1:18443。

### 1.1 浏览器视觉走查（用户动作）

桌面端打开设置面板，左树应出现「远程设备」节（order 95，存储管理之后）。
走查点：链路状态卡（relay 未配置时显示引导文案）/ 设备列表（在线点+吊销按钮）/
配对向导三态（wait-join 二维码 URI 复制、sas-confirm 双按钮、done）。
发现问题直接改 src/ac-client-ui-remote/client/RemoteDevices.vue。

### 1.1.1 UI 已对齐设计系统（本轮完成）

RemoteDevices.vue / PairingQr.vue 已重写为 webui-kit 形态：Button/StatusDot
组件直用（@agentchat/webui-kit），样式全走 tokens.css 设计令牌（--primary/--line/
--text-*/--bg-*/--r-*/--space-*/--font-mono/--dur-*），双主题（Nebula/Aurora）自适应。
SAS 数字用 primary-light 底大号等宽焦点块；链路/设备在线状态用 StatusDot 语义色；
scopes 档位以 pill 徽章展示。视觉走查仍待用户在桌面端确认。

### 1.2 remote/* 事件 ws-bridge 转发（实时推送替代 2s 轮询）

现状：RemoteDevices.vue 每 2s 轮询 remote/devices；
目标：ws-bridge 桥接 remote/device-paired、device-revoked、device-online、
device-offline 四事件（已带 mode=emit + scope=host 标注），前端 onEvent 驱动刷新；
落点：src/ac-ws-bridge/src/index.ts 加 4 条 fwd（照 agents/updated 同款）；
RemoteDevices.vue 的 refresh() 保留兜底轮询（降频到 10s）。

### 1.3 真二维码渲染（可选，浏览器侧降级体验）

当前 PairingQr.vue 是散列点阵视觉占位 + URI 复制。真扫码方是 M3 安卓 App，
浏览器侧二维码只服务于「另一台设备装了 App 但无法跳转」的边缘场景。
若要做：webui 加 qrcode（npm 包）依赖，约 20 行替换点阵。低优。

## 二、M3 安卓单 App（主战场）

上游方案 4.4 节已定架构，此处是实施切分 + 本仓新沉淀的协议约定。

### 2.1 架构（照方案，不变）

安卓 APK（Capacitor 壳）：
  UI     WebView 加载内置 webui dist（与桌面 WebUI 零改动）
  传输   原生 Kotlin 约 300 行：OkHttp(CertificatePinner) 连 relay wss
         + Noise E2E + localhost 明文 WS 回环喂 WebView
  密钥   设备静态密钥对入 Android Keystore（硬件 backed）
  配对   系统相机扫核心端二维码，agentchat://pair deep link 唤起，SAS 比对页
  锁     生物识别解锁才连 relay；切后台即断开

### 2.2 协议约定（必须与本仓实现一致——M1/P1 实跑沉淀）

| 约定 | 内容 | 代码参照 |
|---|---|---|
| 身份密钥 | X25519 静态对（不是早期文档概称的 Ed25519）；二维码 pk = 核心端 X25519 公钥 base64url | ac-noise-core StaticIdentity |
| roomId 编码 | 满足 relay 校验 [A-Za-z0-9_-]{22,43}：配对房 = p + 18B 随机 b64url；重连房 = r + SHA256(core_pub‖deviceId‖device_pub) 前 17B 的 b64url（双方各自可算，免协商） | service.ts startPairing / runDeviceConnection |
| XK 载荷位置 | m1 载荷空；设备信息 JSON（name、pubkey）放 m3（加密段——设备公钥不以明文过 relay） | relay-connection.ts + loopback 客户端 |
| KK 进房竞态 | relay 只转发实时帧——m1 早于对端入房即丢。发起方 3s 超时整链重试（新 dial 新握手新 e）；宿主端 kkRetries 上限 10 次、间隔 1s 重排 | 双侧 catch 路径 |
| 业务帧 | op=frame 的 data 里 n + ct：n = 单调计数，ct = base64url AEAD 密文；载荷 JSON 与本地 WS 帧同构（type + data） | relay-connection.ts sendPayload |
| RPC 往返 | 手机发 rpc/call（method、requestId、params），回 rpc/result；scopes 档 read/chat 白名单见服务端 | service.ts SCOPE_ALLOWED_METHODS |
| SAS | SHA256(handshake_hash) 前 4 字节转 8 位数字，两端显示比对 | sasFromHandshakeHash |
| relay 控制帧 | join{room} 应 joined 或 room-unavailable；ping 应 pong（心跳兼保活） | ac-relay-server |

### 2.3 Noise 实现选型（安卓侧）

JS 库放 WebView 的路线已被方案否决（密钥必须进 Keystore = 原生半边）；
推荐：Kotlin 移植 ac-noise-core（约 490 行 TS，预计 600 行 Kotlin），算法
对照 Noise spec rev34 + 本仓测试向量（RFC 7748 x25519 向量在
ac-noise-core/tests/noise.test.ts，可直译 JUnit）；
备选：noise-java 库（wire format 不兼容需适配层，不推荐）。

### 2.4 工程结构（建议）

mobile/ 新顶层目录（不进 src/ cordis 轨）：
  app/       Capacitor 工程（android/ 原生壳 + src/ 资源与 deep link 配置）
  transport/ Kotlin Noise 实现（独立可测模块，含对照测试）
  scripts/   同步 webui dist 进壳的构建脚本

### 2.5 实施切分（每步可独立验证）

| 阶段 | 内容 | 验收 |
|---|---|---|
| M3.1 | Kotlin Noise 模块（XK/KK/AEAD/SAS）+ 测试向量 | 与 ac-noise-core 测试向量互过；与 Node 侧 loopback 客户端跨端握手（PC 起 relay，各跑一端） |
| M3.2 | Capacitor 壳 + 回环桥（原生到 WebView 明文 WS） | WebView 加载 webui dist 并能 rpc/call 通回环桥 |
| M3.3 | 配对面：扫码 deep link + SAS 比对页 + Keystore 身份 | 真机扫 PC 屏二维码，SAS 一致后设备出现在 PC 设备列表 |
| M3.4 | 在线态：事件下行（PC 到手机流式）+ 断线重连（KK）+ 生物锁 | 真机全链路：发消息看流式、断网重连、切后台断开 |
| M3.5 | APK 自托管分发（下载面 + manifest + App 内版本检查） | 下载面装 APK；版本更新提醒走通 |

M3.1 起步提示：先把 ac-noise-core/src/index.ts 逐函数对照写 Kotlin
（SymmetricState、CipherState、HandshakeState 三层结构照搬），测试向量从
ac-noise-core/tests/noise.test.ts 直译。

### 2.6 与公网 relay 对接时的注意

地址 wss://47.110.63.135:8443，自签证书——OkHttp 需 CertificatePinner
pin sha256 指纹或信任自签（认证职责在 Noise 层，TLS 仅混淆——上游方案 4.3 节）；
手机侧 pair-start 拿到的 qrUri 里 relay 参数已 URL 编码，deep link 解析后先 unescape；
relay 心跳：超 60s 无 ping 断连——安卓侧 OkHttp 连接空闲 ping 间隔设在 30s 内。

## 三、M4 可选（设备管理成熟化）

多设备并发在线（connections 表已支持，需真机验证双设备互不干扰）；
按设备审计日志（谁在何时发了什么 RPC——落 ac-session 或独立 jsonl）；
登录提醒（新设备上线推送到既有会话）；
设备页 30 天未活跃提醒（上游方案 4.5 节残余风险表最后一条）。

## 四、关键文件索引

| 文件 | 职责 |
|---|---|
| src/ac-noise-core/src/index.ts | Noise XK/KK + AEAD + SAS 纯库（约 490 行） |
| src/ac-remote-link/src/service.ts | RemoteLinkService：身份/注册表/配对状态机/连接管理/RPC 闸门 |
| src/ac-remote-link/src/relay-connection.ts | 出站 ws + join + responder 握手 + 帧泵 |
| src/ac-remote-link/src/identity.ts 与 device-registry.ts | 持久化（0600 原子写 / 吊销即删） |
| src/ac-relay-server/src/main.ts | 服务器传输适配（明文分支已修 node:http + /healthz） |
| src/ac-client-ui-remote/ | webui 远程设备节（settings:section 贡献） |
| scripts/remote-loopback-host.ts 与 remote-loopback-client.ts | 本地全链路验证双件套 |
| src/ac-web-server/src/service.ts 的 callRpc | M1 对 web-server 的唯一侵入点 |

## 五、踩坑存档（下个会话勿重蹈）

1. relay 明文分支必须 node:http——https server 对明文握手静默挂起（已修；
   写安卓本地联调脚本时同理：ws:// 连明文服务）；
2. 事件目录文件（declare module 形态）必须有顶层 export 空对象，否则整个
   导入图在 tsc 下降级出数千假错；
3. 行内 RPC 访问自身服务：apply 里 new Service(ctx) 直持实例引用，不要在
   inject 数组里声明自身服务名（自引用等待死锁）；
4. types/node 细节：chacha20-poly1305 的 setAAD 必带 plaintextLength；
   x25519 私钥 JWK d-only 形态 node 拒收——PKCS8 DER 包装 + clamp 后导入；
5. Node strip-only 加载器禁参数属性（constructor(private x) 形态）——
   TS 编译能过、运行时炸；
6. loopback 客户端身份必须落盘（模拟 Keystore），宿主 data root 必须固定——
   否则每次重启都算新设备，KK 重连房间永远对不上。
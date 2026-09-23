# M1 实施方案：ac-remote-link 核心端行（remote-client-relay-plan §4.4）

> 上游方案：src/docs/remote-client-relay-plan.md（B 路线唯一裁决）。本文档是
> M1 里程碑的工程落地方案：架构探索结论 → 设计决策 → 实施切分。M2（relay
> 服务器 + 下载面）已于 2026-09-15 上线，本文档不重复其内容。

## 0. 架构探索结论（现状盘点）

### 0.1 可复用的既有能力面

| 能力 | 位置 | 对 M1 的意义 |
|---|---|---|
| RPC 注册面（显式表） | ac-web-server registerRpc + rpcMethods | 远程 RPC 的处理面就是本地 RPC 处理面——转发即可，无需镜像协议 |
| WS 帧词汇 | ac-ws-protocol：rpc/call、rpc/result、ws/ack + 业务帧 type=事件名直转 | 密文内载荷与本地协议完全同构（上游 §4.2 帧格式设计的前提成立） |
| 事件桥订阅 | ac-ws-bridge：emit 面 → webServer.broadcast | 下行白名单的参照系（订阅哪些事件、怎么过滤后台 run） |
| elevation 判定单源 | ac-conversation sanitizeElevation(source, elevation) | 远程来源恒剥除的机制位置已存在：source 非 user/event 即剥 |
| 身份密钥存储先例 | ac-credentials：AES-256-GCM + 机器绑定 + 原子写（tmp+fsync+rename） | remote/identity 文件的存储纪律照抄 |
| relay 服务端 | ac-relay-server RelayCore（13 测试）+ 公网实例 | e2e 测试的真实对端；协议词汇 join/frame/ping/close |
| 测试基建 | vitest + new Context() 脚手架（ac-llm/tests/router.test.ts 形态） | FakeRelay 用 RelayCore + FakeConn 即可拼出 |

### 0.2 关键探索发现（影响设计）

1. webServer.rpcTable 是私有的（private readonly rpcTable = new Map()）。
   RPC 分发在 handleRpc 内部完成，外部无法直接调用。远程 RPC 转发有两条路：
   - A. 本地回环 WS 客户端：remote-link 自己开一条 WS 连到本机 web-server，
     作为普通客户端发 rpc/call 帧——零侵入，但多一层串口转发。
   - B. 内部 RPC 桥：在 web-server 增加一个受控的内部调用入口（新增
     webServer.callRpc(method, params) 公共方法，走 rpcTable 查表直调）。

   决策：选 B。理由：A 方案多一次序列化 + 依赖 web-server 已启动且监听（引入
   启动顺序耦合）；B 是注册中心模式的自然延伸（registerRpc 已是公共 API，
   查表直调只是把 handleRpc 的「帧到达」入口换成「进程内调用」入口）。需要在
   web-server 增加 ~15 行公共方法。

2. broadcast 是全局广播（无按连接过滤），且 WS_READY 帧只有 connId。
   远程端需要的是「事件白名单 + 按 conversationId 增量拉取」。设计：remote-link
   自己订阅事件（与 ws-bridge 同款姿势，复用其白名单词汇表 + 后台 run 过滤
   判定），加密后单播给已连接设备。不通过 webServer.broadcast——广播面是
   本地浏览器的，远程单播是 remote-link 的职责。

3. deliver 的 elevation 通道对远程天然封闭：web-api 的 deliver RPC 把 elevation
   白名单窄化后透传，deliver 边界按 source 再判定（agent 恒剥除）。远程设备经
   remote-link 转发 deliver 时不带 elevation——恒剥除自动成立，无需在
   remote-link 侧再写防御。但 scopes 闸门（read/chat/files/admin）是 remote-link
   自有职责（web-server 不知道设备身份）。

4. config 服务没有统一 data root 服务（root 默认 ./data 或 AGENTCHAT_DATA_ROOT
   环境变量）——各持久化域自持文件路径（credentials 同款）。remote/ 目录
   照 credentials 模式：path.resolve(root ?? env ?? "./data", "remote/")。

5. noise 库生态：noise-ws 不存在（npm 404）；@stablelib/* 系列存在（2.x）。
   Noise XK/KK 手写实现需要 DH + AEAD + HKDF 三件套，node:crypto 全部原生具备
   （x25519 + chacha20-poly1305 + hkdf 均原生支持）。决策：noise-core 纯库
   自研（~300 行，纯 node:crypto），照 Noise 规范状态机实现。好处：零新依赖、
   与 relay 侧（同样自研）对称、安卓端 noise-java 对称参照。

## 1. M1 范围与切分

### 1.1 包结构

```
src/ac-noise-core/            纯库：Noise XK/KK 握手状态机 + AEAD 帧封装
  src/index.ts                DH(x25519) + HKDF-SHA256 + ChaCha20-Poly1305
                              + MixHash/MixKey 链 + SAS 派生 + 帧计数
  tests/noise.test.ts         RFC 7748 向量 / 自洽往返 / 篡改拒绝 / 重放拒绝

src/ac-remote-link/           核心端行：服务 + 配对 + RPC 桥 + 事件桥
  src/contract.ts             RemoteDevice / PairingSession / Scopes / 帧类型
  src/events.ts               remote/* 事件目录（emit，host 域）
  src/identity.ts             Ed25519 身份密钥（remote/identity，0600，原子写）
  src/device-registry.ts      known_devices.json 读写（吊销 = 删除）
  src/relay-connection.ts     出站 wss 连 relay + join + Noise 会话 + 帧泵
  src/service.ts              RemoteLinkService（ctx.remoteLink）
  src/index.ts                薄行 + RPC 注册（remote/* 管理面）
  tests/remote-link.test.ts   全链路（FakeRelay = RelayCore + FakeConn）
```

### 1.2 新增服务与契约

- ctx.remoteLink（服务名已查重，扁平命名空间无冲突）：
  - listDevices() / revokeDevice(deviceId) / deviceStatus(deviceId?)
  - startPairing(opts) → 配对会话（roomId + 二维码 URI + SAS 等待确认）
  - confirmPairing(sessionId, accept) → SAS 比对结果
  - connect(opts) / disconnect() → 手动控制出站连接
  - callRpc(method, params) → 内部桥入口（webServer.callRpc 的受控暴露）
- remote/* 事件（emit，host 域）：
  - remote/device-paired：载荷 (device: RemoteDevice)——设备注册成功
  - remote/device-revoked：载荷 (deviceId: string, device?: RemoteDevice)
  - remote/device-online / remote/device-offline：在线状态变更
  - 4 个事件全部 @mode emit + @scope host（管理面通知，与 agents/updated 同级）。
    ws-bridge 可订阅转发给 webui 设备管理页（M1 不强制，remote/* RPC 轮询即可）

### 1.3 密码学层设计（noise-core）

```
身份：Ed25519 静态密钥对（remote/identity，0600，首次生成——与 SSH id_ed25519
      同级暴露面；机器绑定加密留后续增强，不动 schema）
握手：XK（配对，手机为发起方，已从二维码带外获知核心端静态公钥）
        -> e                        手机 → 核心端：手机临时公钥（明文）
        <- e, ee, s, es             核心端：静态公钥加密传输 + 双重 DH
        -> s, se                    手机：静态公钥加密传输（配对后保存）
      KK（重连，双方已知对方静态公钥，双向认证）
        -> e, es
        <- e, ee
        -> (空)                     载荷可随最后一帧携带
AEAD：ChaCha20-Poly1305（node:crypto 原生 chacha20-poly1305）
密钥派生：HKDF-SHA256（MixHash/MixKey 链照 Noise spec §4-§5）
帧格式：{ n: number, ct: base64 }——n 为发送方单调计数
      每连接新会话密钥（handshake 完成后 Split() → k_send/k_recv）
SAS：SHA256(handshake_hash) 前 4 字节 → 8 位数字（显示为两组 4 位）
```

### 1.4 RPC 白名单与 scopes 闸门

远程设备可调用的 method 按 scopes 分档（上游 §4.4 表）：

| scope | RPC 白名单 |
|---|---|
| read | session/history、session/tokens、agents/list、agents/presets、agents/tool-defs、tools/list、tags/catalog、conversation/stats、group/list、group/history、runs/snapshot、runs/interrupt、usage/tokens、goal/get、todo/get、fileSnapshots/*、skills/list、timer/list、timer/entries |
| chat | read + conversation/deliver、conversation/interrupt、conversation/queue*、group/send、interaction/list、interaction/reply |
| files | chat + 文件类写侧（fileSnapshots 写侧、fs 类 RPC 如有） |
| admin | 全部（M1 仅保留档位定义，白名单留空数组 = 显式禁用，防误开） |

判定逻辑（remote-link 侧单源）：

```
方法不在任何档位白名单 → 拒绝（unknown-by-scope）
设备 scopes 含该方法所属档位 → 放行（进入 webServer.callRpc）
deliver 类 → 强制 sender=remote:<deviceId>、source=user、剥 elevation
```

### 1.5 配对流程状态机

```
idle → (startPairing) → pairing-wait-join（roomId 就绪，二维码可显示，TTL 5min）
    → 手机 join → XK 握手 → pairing-sas-confirm（两端显示 SAS）
    → confirmPairing(true) → 设备写入注册表 → emit device-paired → idle
    → confirmPairing(false) / 超时 / 断连 → idle（房间销毁）
```

运行态重连不经过配对：注册表内设备 join → KK 握手（双向认证）→ online。
未配对 join（核心端无记录）→ 握手在 KK 对端公钥验证处失败 → 断连。

## 2. 实施顺序（P0 → P1）

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0.1 | noise-core 纯库 + 单测 | RFC 7748 x25519 向量过；XK/KK 往返一致；篡改/重放拒绝 |
| P0.2 | identity + device-registry | 文件 0600；原子写；吊销删除 |
| P0.3 | relay-connection + service | FakeRelay 全链路：配对（XK+SAS）→ 消息往返 → 重连（KK）→ 吊销后拒连 |
| P0.4 | web-server callRpc 公共方法 + remote-link RPC 注册 | callRpc 走 rpcTable 查表；remote/* 管理 RPC 可调 |
| P1.1 | webui 设备管理页 + 二维码 + SAS（后续轮次） | 浏览器手测 |

## 3. 与上游方案的偏差记录

1. 密钥库加密：上游 §4.4 说存 data root 权限 600——M1 落 0600 明文
   （与 SSH 同级暴露面），机器绑定加密留作后续增强（不动 schema）。
2. noise 库选型：上游未指定库；探索发现无现成 noise-ws。自研纯库（纯
   node:crypto），XK/KK 状态机 + AEAD 帧封装 ~300 行。
3. RPC 转发路径：上游说「复用 rpcTable 处理器」——落地需要 web-server 新增
   callRpc(method, params) 公共方法（rpcTable 私有，外部不可达）。这是 M1 对
   ac-web-server 的唯一侵入点（~15 行）。
4. 配对 UI：M1 先交付 RPC 面（remote/pair-start 等返回二维码 URI + SAS），
   webui 页面留 P1（下一轮）——CLI/curl 也能完成配对闭环。
5. 事件下行白名单：M1 先交付事件订阅桥（会话流照常下发），白名单词汇表
   照 ws-bridge 现有桥接面收敛（不新增词汇，只做订阅转发 + Noise 加密单播）。

## 4. 风险与开放问题

- noise-core 自研的密码学风险：严格照 Noise spec 派生链（MixHash/MixKey），
  用 test vector 自校验（x25519 用 RFC 7748 向量；HKDF/AEAD 用标准向量）；
  不发明任何自有原语。XK 的 s/es 步骤实现易错，写测试时对照 spec 逐步断言。
- 帧计数回绕：n 单调计数，Node number 精度 2^53——BigInt 端内计数，wire 上
  仍 number（超过 2^53 前人类无法达到）。
- 重连风暴：指数退避（1s 起，上限 60s，抖动 ±20%）；relay 不可达时设备
  状态置 offline-retry，不阻塞宿主其他功能。
- elevation 通道：远程 deliver 不带 elevation 字段（remote-link 转发时显式
  delete）——机制上 sanitizeElevation 已剥，双保险。

## 6. 实施实况（2026-09-22 收口）

P0 全量落地，验证链全绿（typecheck 0 错 / lint 净 / 全仓单测 2011 过 /
smoke 过 / check:deps 过）：

- **ac-noise-core**：XK/KK 握手状态机 + AEAD 帧 + SAS，纯 node:crypto，9/9 测试
  （含 RFC 7748 向量、XK 伪冒响应方拒绝、重放/乱序拒绝）；
- **ac-remote-link**：identity（0600 原子写）+ DeviceRegistry（吊销即删）+
  RelayConnection（出站 ws + join + responder 握手 + 帧泵）+ RemoteLinkService
  （配对状态机 + scopes 闸门 + deliver 强制 sender=remote:<id>/source=user/剥
  elevation + 事件白名单单播），6/6 测试；
- **ac-web-server** 唯一侵入点：`callRpc(method, params)` 公共方法（rpcTable 查表
  直调，与 WS 帧到达同一条处理链）；
- 挂载：cordis.yml + ac-app TREE + 根/ac-app package.json 依赖 + README 契约表。

实施中沉淀的裁决（后续轮次遵守）：

1. **roomId 编码**：relay 校验 `[A-Za-z0-9_-]{22,43}`——首字符 p/r 作模式信令
   （配对/重连）；重连 roomId 确定性派生（SHA256(core_pub‖deviceId‖device_pub)），
   双方各自可算无需协商；
2. **TS 类型级联事故**：`import type {} from './events.ts'` 引入「无顶层 export 的
   declare module 文件」会让整个导入图在 tsc 下降级（2741 个假错误）——事件目录
   文件必须 `export {}`；
3. **@types/node 细节**：chacha20-poly1305 的 setAAD 必带 `{plaintextLength}`；
   JWK d-only 形态 node 拒收 x25519 私钥——PKCS8 DER 包装 + clamp 后导入；
4. **es 档位白名单收敛**：M1 只开 read/chat（files/admin 空数组显式禁用）。

P1（webui 设备管理页 + 二维码 + SAS 比对 UI）留待下一轮。

## 5. P1 实况（2026-09-22 收口）

P1 全量落地，验证链全绿（typecheck 0 / webui:typecheck 0 / lint 净 / 全仓单测
2011 过 / smoke 过 / check:deps 过）+ **本地全链路 e2e 实跑通过**：

- **remote/* 管理 RPC 8 方法**（status/devices/revoke/pair-start/confirm/cancel/
  connect/disconnect）——ac-remote-link 行内注册（apply 直持服务实例，不经
  ctx.remoteLink 避免 inject 自引用等待）；
- **loopback 客户端**（`scripts/remote-loopback-client.ts`）+ 宿主 driver
  （`scripts/remote-loopback-host.ts`）——本地实跑全链路：XK 配对（SAS 打印
  → RPC 代答确认）→ 设备注册上线 → **加密链路 RPC 冒烟**（agents/list 过
  scopes 闸门）→ 断线 → **KK 重连成功**（确定性房间派生 + 双侧重试对齐）；
- **webui 设备管理页**（`ac-client-ui-remote` 行）：settings:section 贡献
  「远程设备」节——链路状态/设备列表（在线点 + 吊销）/配对向导（二维码
  URI 复制 + SAS 双按钮比对）。二维码为视觉占位（真扫码方 = M3 安卓 App）；
- 挂载：cordis.yml/TREE/根+ac-app/webui 依赖/README。

### 本轮发现并修复的真实缺陷（全部回填）

1. **relay 明文分支误用 node:https**：TLS server 收明文 WS 握手只会挂起到
   超时（socket hang up）——本地 loopback 从未通过的真因。明文分支改
   node:http；顺带补 /healthz（上游方案 §4.3 本就定义）；
2. **XK 载荷错位**：客户端设备信息原放 m1（明文段），宿主读 m3 →
   Unexpected end of JSON input。约定对齐：m1 空、设备信息放 m3（加密后
   传输——设备公钥不以明文过 relay）；
3. **KK 进房时序竞态**：relay 只转发实时帧——m1 早于对端入房即丢。双侧
   对策：发起方 3s 超时整链重试（新 dial 新握手）；宿主端 kkRetries 短窗
   重排（不受 autoReconnect 门控）；
4. **死链挡重连**：宿主 connections 残留旧链让 connect 短路——
   runDeviceConnection 入口 dispose 同设备旧连接；
5. **pairing 会话残留**：失败路径不释放 → startPairing 被 already in
   progress 挡。cancel/失败均置 null；守卫只挡 wait-join/sas-confirm 活态；
6. **loopback 身份不持久**：每轮进程重启 = 新设备，KK 房间永远对不上——
   客户端身份落盘（模拟 Keystore）；宿主 driver 固定 data root。

### 已知边界（记录不阻塞）

- 浏览器手测（真实 UI 渲染走查）待用户在桌面端进行；
- remote/* 事件的 ws-bridge 转发（设备上下线实时推送）留后续——当前 UI
  2s 轮询驱动；
- M3（安卓 App）为真扫码方——浏览器二维码是降级占位。

## 6. 验收清单（P0 收口对照）

- [x] noise-core：RFC 7748 向量、XK/KK 往返、篡改/重放拒绝、SAS 一致性
- [x] identity 文件权限 0600 + 原子写 + 重启加载
- [x] known_devices.json：配对写入/吊销删除/重启恢复
- [x] scopes 闸门：read 设备调 deliver 被拒；chat 设备 deliver 无 elevation
      （单测覆盖；全链路 ws e2e 属 P1 联调——relay 协议层已有 scripts/relay-e2e 8/8）
- [x] callRpc：未注册 method 报错与本地 WS 同口径（unknown method 同文案）
- [x] cordis.yml/TREE/README/依赖门禁更新；typecheck/lint/test:unit/smoke 全绿
# M3.1 实施实况：Kotlin Noise 模块 + relay 全链路验证

> 上游：remote-link-remaining-plan.md §二（M3 切分表 M3.1）。本文记录实施落点、
> 与 TS 实现的对照关系、验证结果与本轮新踩坑——M3.2（Capacitor 壳）开工前必读。

## 1. 落点清单

| 文件 | 职责 |
|---|---|
| mobile/transport/（Gradle 工程，Kotlin JVM 2.1.20 + JDK17） | 独立可测模块，不进 src/ cordis 轨 |
| mobile/transport/src/main/kotlin/agentchat/noise/Noise.kt | Noise XK/KK + AEAD + SAS 纯实现（~470 行，逐函数对照 ac-noise-core） |
| mobile/transport/src/main/kotlin/agentchat/noise/RelayClient.kt | OkHttp WS 出站 + join + 发起方握手 + 帧泵（手机半边） |
| mobile/transport/src/main/kotlin/agentchat/noise/RelayMain.kt | 全链路验证驱动器（RPC 面 + pair-start + XK + confirm + KK） |
| mobile/transport/src/main/kotlin/agentchat/noise/CrossTest.kt | 管道级跨端驱动器（stdin/stdout JSON 行协议） |
| mobile/transport/src/test/kotlin/agentchat/noise/NoiseTest.kt | JUnit 11 例：RFC 7748 / RFC 8439 / HKDF / SAS / XK / KK / 篡改 / 重放 |
| scripts/m31-fixtures.ts | 跨端基准值生成（node:crypto 现算，值嵌入 Kotlin 测试） |
| scripts/m31-cross-verify.ts | 管道级跨端验证（Node responder ⇄ Kotlin initiator） |
| scripts/m31-kk-responder.ts | KK 专项：Node responder 扮演宿主半边 |
| scripts/m31-auto-confirm.ts | SAS 自动确认（sessionId 经 .dsh/tmp/pair-session.txt 传递；已被 Kotlin 内置确认取代，保留作参照） |

## 2. 验证结果（2026-09-25）

1. **JUnit 11/11 绿**：x25519 RFC7748 §6.1 向量、AEAD RFC8439 §2.8.2 官方向量（+ node 基准双锚定）、
   HKDF-SHA256（node hkdfSync 对照）、SAS（node 基准 26065796/71813300）、XK/KK 往返、伪冒拒绝、
   篡改/重放拒绝、b64u 往返 + node 交叉。
2. **管道级跨端 6/6 绿**（scripts/m31-cross-verify.ts）：XK 载荷可达、responder 解发起方公钥、
   SAS 双端一致、双向帧互通、KK 重连后帧互通。
3. **relay 全链路绿**（本地 relay 18443 + remote-loopback-host 4183）：
   pair-start → qrUri 解析 → XK 握手 → SAS → pair-confirm → ONLINE →
   加密 RPC agents/list（返回真 agents 数据）→ 断开 → remote/connect → KK 重连 → 重连后 RPC 应答通过。

## 3. 协议实测补充（文档没写死的细节）

- web-server RPC 应答信封：`{type:"rpc/result", data:{requestId, ok, result|error}}`——**ok 不是 __ok**
  （loopback 客户端的 `r.__ok` 是它对 `f.data` 的字段读取历史；新客户端按 ok 读）。
- dedup：同 method+requestId 30s 窗口重复 → `ws/ack kind=deduped`，不执行。requestId 要每次唯一（加随机后缀）。
- remote/pair-confirm 需要**精确 sessionId**（pair-start 返回值里有；status 不暴露）。
- 新设备缺省 scopes 由宿主行 config `defaultScopes` 决定（remote-loopback-host 现传 ["read","chat"]）；
  不传则空数组 = 一切 method 拒绝。

## 4. 本轮踩坑（新增，勿重蹈）

1. **Windows 动态端口排除段**：本机 3831-3930 被 Hyper-V 保留——3839 监听会 EACCES 降级
   （web-server 静默降级 resolve(options.port)，表象是「READY 端口对但拒连」）。
   宿主端口可用 LOOPBACK_PORT env 换（现用 4183）。运行 `netsh interface ipv4 show excludedportrange protocol=tcp` 可查。
2. **OkHttp 回调线程 vs 协程赋值竞态**：握手完成后对端立刻发的加密帧可能先于 `transport` 赋值到达，
   朴素实现会静默丢帧。RelayClient 已加 earlyFrames 缓存 + replayEarlyFrames 重放（M3.2 壳内复用勿删）。
3. **Kotlin b64u 手写尾部掩码**：rem==1/2 分支的字符索引掩码必须是 `and 63`（逐 6bit），
   写成 `and 3`/`and 15` 时 32B 公钥编码错误且单测往返测不出（往返自洽）——必须与 node 交叉锚定。
4. JCE 的 X25519 KeyFactory 不支持从私钥反推公钥（getKeySpec 限 PKCS8/XEC spec）——
   密钥对生成用 KeyPairGenerator，双向导出 raw。
5. Kotlin 可空函数类型调用语法是 `onPayload?.invoke(x)`——`onPayload?(x)` 不编译。
6. 宿主 KK 重连对时序敏感：手机端 close → remote/connect 之间需 ≥4s（ws 关闭传播 + 宿主 stale 清理）；
   RelayMain 现值 4000ms。真机 M3.4 阶段建议改为事件驱动（等 device-offline 再 connect）。

## 5. 工程运维

- Gradle 8.14 发行包解压在 mobile/.dsh-gradle/（已 ignore？——transport/.gitignore 只盖 build/.gradle，
  根 .gitignore 未含 mobile/.dsh-gradle——**待 M3.2 一并处理**）。
- 依赖：kotlinx-coroutines 1.9.0 / gson 2.11.0 / okhttp 4.12.0（OkHttp 同时是 Android 壳的传输层依赖，
  transport 模块将来直接进 Android 工程）。
- 全链路验证一条龙（各终端）：
  ```
  (1) cd src/ac-relay-server && RELAY_PORT=18443 RELAY_HOST=127.0.0.1 npx tsx src/main.ts
  (2) LOOPBACK_PORT=4183 npx tsx scripts/remote-loopback-host.ts
  (3) java -cp <installDist lib> agentchat.noise.RelayMainKt ws://127.0.0.1:18443 ws://127.0.0.1:4183 kotlin-phone --reconnect
  ```

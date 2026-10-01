# M3.2 实施实况：回环桥 + WebView 面（含 4 处链路根因修复）

> 上游：remote-link-remaining-plan.md §二 M3.2「Capacitor 壳 + 回环桥（原生到 WebView
> 明文 WS）」；验收「WebView 加载 webui dist 并能 rpc/call 通回环桥」。
> 本文记录实施结果与实测挖出的四处真实缺陷——M3.3/M3.4 开工前必读。

## 1. 落点

| 文件 | 职责 |
|---|---|
| mobile/transport/src/main/kotlin/agentchat/noise/LoopbackBridge.kt | 回环桥：**同口** HTTP（静态 dist）+ WS（/ws）+ /api 转发 |
| mobile/transport/src/main/kotlin/agentchat/noise/RpcClient.kt | 本地 RPC 面客户端（自 RelayMain 提取共用，消除重复） |
| mobile/transport/src/main/kotlin/agentchat/noise/BridgeMain.kt | 桥验收驱动器（含帧大小/连接探测观测口） |
| mobile/transport/src/test/kotlin/agentchat/noise/LoopbackBridgeTest.kt | 桥单测（同口静态+WS+rpc/call 流转） |
| scripts/m32-bridge-verify.ts | 协议级验收（HTTP 静态 / SPA fallback / ws/ready / 加密 RPC） |
| scripts/m32-webview-verify.mjs | **浏览器级验收**：真 Chromium 加载 webui dist 跑真实应用 |

## 2. 关键设计：为什么是「同口」

webui 的连接地址是 ``${location.protocol}//${location.host}/ws``（src/webui/src/api/wire.ts）
——同源推导。因此桥必须**与 ac-web-server 同构**：一个端口上同时提供 HTTP 静态与 WS。
这直接决定「webui 零改动」成立（实测确认：桥端口任意分配 3203/7121/9081/11155，webui
均自动连上对应 /ws）。

技术选型：**Ktor（CIO 引擎）+ ktor-server-websockets**。最初试 Java-WebSocket 发现其无 HTTP
静态服务能力，无法同口；Ktor 一栈解决且 Android 友好（将来直接进 Android 壳）。

## 3. 验收结果（2026-09-25）

浏览器级验收（真 Chromium + 真实 webui bundle）：**9/9 通过**，且**静置 100 秒后复测仍 9/9**：
- 页面加载 / 应用渲染 **65001 字符 DOM**（完整界面）
- **同源推导零改动**自动连上桥 /ws（无任何前端改动）
- ws/ready 收到；**27 次 rpc/call → 27 次 rpc/result 全对应**（零丢失）
- 零未捕获异常、零致命 console 错误

协议级验收（scripts/m32-bridge-verify.ts）：5/5（静态可达 / SPA fallback / ws/ready / 加密 RPC）。
桥单测：1/1（同口静态+WS+rpc/call 单向与广播）。

## 4. 本轮挖出的四处真实缺陷（全部修复）

### 4.1 webui 启动强依赖 /api/ui/boot-graph —— 手机端白屏（方案缺口）

- **现象**：WebView 加载 dist 后 #app 为空（0 字符 DOM），pageerror `Cannot read properties
  of undefined (reading 'init')`。
- **根因**：webui 装配第④步拉 `/api/ui/boot-graph` 获取行 client 半边装载图；remote-link 方案
  只设计了 **RPC 面**（registerRpc）与事件白名单，**未覆盖 webui 启动强依赖的 HTTP 面**。
  桥把该路径当 SPA 未知路由回落成 index.html → 前端解析出无 clients → 装配崩。
- **修法（机制归位，未改协议）**：ac-webui 行把同一数据同时挂上既有 RPC 面
  （`web.registerRpc('ui/boot-graph', ...)`），ac-remote-link 的 read 档白名单放行；
  桥把 `/api/ui/boot-graph` 转成对核心端的加密 RPC，其余 `/api/*` **显式 501 而非回落 HTML**
  （回落 HTML 会掩盖缺口，是本次排查耗时的主因）。
- **教训**：远程 WebView 面的完备性判据 = webui 启动路径上的**全部**宿主 HTTP 依赖，
  不只是 RPC 方法。M3.3/M3.4 若再遇到新 /api 依赖，按同一机制补（不新造通道）。

### 4.2 relay 单帧上限 = 正当载荷上限 —— 桥上游数分钟后静默失效

- **现象**：桥启动一两分钟后，WebView 侧 RPC 全部超时；桥日志 `UPSTREAM CLOSED:
  sent ping but didn't receive pong within 25000ms`。
- **根因（两层）**：
  1. relay 的 `maxFrameBytes` 初值 1MB 对远程链路过紧——webui 的会话历史/运行快照类 RPC
     应答 + Noise 封装开销轻易破限，超限即被 relay **直接关连接**；
  2. 更危险的是：ws 层 `maxPayload` 恰等于应用层限额，超限帧在 ws 层就抛 error，而
     connection handler **未挂 error handler** → 未捕获 error 冒泡**崩掉整个中继进程**
     （实测 relay 以 `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH` status 1009 退出）。
- **修法**：① 单帧上限放宽到 8MB（防滥用主力是速率桶与房间日流量上限，均不变）；
  ② ws 层 maxPayload 留余量（应用层限额 + 64KB），超限判定归位到应用层；
  ③ `ws.on('error')` 只关该连接——**公共入口单连接异常绝不允许带走进程**。

### 4.3 应用层心跳缺失 —— relay 60s 判死空闲连接

- **现象**：桥连接在约 60s 后失效。
- **根因**：`ac-relay-server` 只把**应用层帧**（`{op:"ping"}`、join、frame）计入活跃判定
  （`touch`），60s 未见即 `destroyRoom`。Kotlin 侧原本只配了 OkHttp 的**协议层**
  `pingInterval`（TCP 保活）——**不计入** relay 的活跃判定。
- **修法**：RelayClient 增 `startHeartbeat()`（协程每 25s 发 `{op:"ping"}`，留足余量）；
  companion 注释标明协议层 ping 不能替代它。close() 时取消。

### 4.4 同公钥重复配对追加而非替换 —— KK 房间派生歧义

- **现象**：多次配对同一设备后，注册表出现 **7 条同公钥不同 id** 记录（实测）。
- **根因**：`DeviceRegistry.add()` 只按 id 判重；每次配对生成新 id 并追加。而 **KK 重连房间
  按 deviceId 派生**（`SHA256(core_pub‖deviceId‖device_pub)`）——两端各取一条记录即房间错位，
  重连永远建不起来（这正是 M3.1 末轮 KK 重连一度超时的真因）。
- **修法**：新增 `upsertByPubkey()`（同公钥替换、**保留原 id**——换 id 会让已配对设备的
  派生命名空间漂移），配对落库改走它。

> 4.2 / 4.3 / 4.4 三处都是**真机会踩到**的产品级缺陷（不是测试装置的问题）：真机长时间
> 挂机（4.2/4.3）与重装 App 后重扫（4.4）都会命中。

## 5. 全链路复现（M3.3 开工基准）

```
(1) cd src/ac-relay-server && RELAY_PORT=18443 RELAY_HOST=127.0.0.1 npx tsx src/main.ts
(2) LOOPBACK_PORT=4183 npx tsx scripts/remote-loopback-host.ts
(3) java -cp <installDist lib/*> agentchat.noise.BridgeMainKt \
        ws://127.0.0.1:18443 ws://127.0.0.1:4183 src/webui/dist
    → 打印 BRIDGE_PORT=<n>（含周期性上游探测日志）
(4) node scripts/m32-webview-verify.mjs <n>     # 浏览器级验收
    npx tsx scripts/m32-bridge-verify.ts <n>     # 协议级验收
```

## 6. Android 壳与 APK（本轮一并落地）

Android SDK 已装（commandline-tools + platforms;android-34 + build-tools;34.0.0，
位于 `C:\Android\Sdk`），壳工程与 APK 构建全部跑通：

| 件 | 落点 | 状态 |
|---|---|---|
| Capacitor 配置 | mobile/app/capacitor.config.json（appId com.agentchat.mobile） | ✅ |
| 依赖隔离 | mobile/app/pnpm-workspace.yaml（**独立 workspace 根**，阻断向上找仓库根——否则 pnpm 不链接 @capacitor/cli） | ✅ |
| Android 原生工程 | mobile/app/android/（`npx cap add android` 生成） | ✅ |
| dist 同步 | mobile/scripts/sync-webui.mjs（含**自洽校验**：index.html 引用的 chunk 必须存在，缺它即白屏且难查） | ✅ |
| 传输半边接入 | app/build.gradle：`sourceSets.main.java.srcDirs += ['../../../transport/src/main/kotlin']` + Kotlin 插件 | ✅ 编入确认（kotlin-classes/debug/agentchat/noise/*.class） |
| APK | mobile/app/android/app/build/outputs/apk/debug/app-debug.apk | ✅ 17.9MB，minSdk 28 / targetSdk 34，含 274 个 webui 资源 |

**minSdk 28（Android 9）不是随意取值**：X25519 KeyAgreement（Conscrypt）与
ChaCha20-Poly1305 均自 API 28 起可用——传输半边的 Noise 握手就靠这两个原语，
低于 28 真机握手必崩。已在 variables.gradle 注释说明。

构建命令（SDK 路径经 android/local.properties 的 sdk.dir 固定）：
```
cd mobile/app && pnpm install          # 独立 workspace（首次）
node ../scripts/sync-webui.mjs         # dist → www
npx cap sync android && cd android && .\gradlew.bat assembleDebug
```

## 7. 待办（留给 M3.3/M3.4）

- **真机验证未做**：`adb devices` 无设备。桥层已在浏览器级达成等价验证（同一 dist、
  同一桥、同一协议面），但 Capacitor WebView 内的实际行为、Android Keystore、
  生物识别均需设备或模拟器。
- **Android 侧启动装配缺失**：BridgeMain 是 JVM `main()`，Android 上不能这样跑。
  需要一个前台 Service（生物锁解锁后启动桥与 relay 连接、切后台即断——方案 §4.4
  「锁」行）+ Capacitor Plugin 把桥端口交给 WebView。这是 M3.3 的前置件。
- 驱动器（BridgeMain/RelayMain/CrossTest，含 main()）暂与产品代码同源集——
  M3.3 做 Service 时一并归位（真机调试还需要它们，暂不动）。
- 桥承担「Capacitor 的 WebView + 本地服务」职责——真机上由 Android Service 持有生命周期
  （前台服务 + 生物锁解锁后启动、切后台即断，见上游方案 §4.4「锁」行）。
- 大载荷的**分片**（8MB 上限只是缓解，单帧超限仍会断链）——建议 M3.4 与流式下行一并设计。
- `mobile/.dsh-gradle*` 已入 .gitignore；Ktor/SLF4J 的 NOP 日志噪音可加 binding 消音（低优）。

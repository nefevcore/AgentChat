# M3.3 实施实况：真机配对 + Keystore 身份（含 7 处真机缺陷）

> 上游：remote-link-remaining-plan.md §二 M3.3「配对面：扫码 deep link + SAS 比对页 +
> Keystore 身份」，验收「真机扫 PC 屏二维码，SAS 一致后设备出现在 PC 设备列表」。
> 本文是**首次真机验证**的实况——桌面环境测不出的一批问题在这里集中暴露。

## 1. 落点

| 文件 | 职责 |
|---|---|
| mobile/transport/.../android/KeystoreIdentity.kt | 设备身份：Keystore 信封加密落盘（§3.1） |
| mobile/transport/.../android/PairingStore.kt | 非机密配对状态（核心端公钥 / relay / deviceId / scopes） |
| mobile/transport/.../android/RemoteSession.kt | 会话中枢：配对 → 等确认 → 起桥 → KK 重连；入站帧分发 |
| mobile/transport/.../android/RemoteLinkService.kt | 前台服务（持链路生命周期 + 常驻通知 + 平台能力诊断） |
| mobile/transport/.../android/WebuiAssets.kt | 释放 APK 内置 webui dist 到文件系统（桥的静态面需要目录） |
| mobile/transport/.../X25519Probe.kt | 平台密码学能力探测（真机排障工具，§3.2） |
| mobile/app/android/.../MainActivity.kt | 装配点：配对面板 / 深链 / 桥加载 / 切后台断开 |
| mobile/app/android/app/src/main/res/xml/network_security_config.xml | 明文策略：**只放行 loopback** |

## 2. 真机验收结果（Android 14 / API 34 模拟器 pixel_5）

对照 M3.3 验收行，**全部达成**：

| 验收点 | 证据 |
|---|---|
| 扫码 deep link 唤起 | `am start -a VIEW -d agentchat://pair?...` 唤起 MainActivity（intent-filter 命中） |
| SAS 比对页 | 界面显示 `8099  4914`（8 位分两段，人工比对友好） |
| Keystore 身份 | `/data/data/<pkg>/files/identity.enc` 124B 密文、权限 600（私钥永不明文落盘） |
| 设备出现在 PC 设备列表 | `remote/devices` → `{name:"sdk_gphone64_x86_64", scopes:["read","chat"], online:true}` |

**超额达成**（M3.2 桥的真机确认）：WebView 加载 `http://127.0.0.1:44649/`（回环桥端口），
webui 完整装配并**经加密链路拉到 448 条真实会话数据**（往返 1386ms）——
Android WebView → 回环桥 → OkHttp WS → Noise E2E → relay → 核心端 → 数据回传，
整条远程链路在真机上成立。

## 3. 关键设计说明

### 3.1 Keystore 身份为什么是「信封加密」

Noise 需要 X25519 **原始 32B 标量**做 DH（协议语义，无法外包给 Keystore 的
Cipher/KeyAgreement API 编排）；而 Android Keystore 的 X25519 密钥默认不可导出。
折中：Keystore 里生成一把 hardware-backed 的 AES 密钥（不可导出），用它**信封加密**
设备私钥后存普通存储。效果：静态存储永远是密文、无 Keystore 密钥解不开、
刷机/恢复出厂随 Keystore 一起销毁。

### 3.2 平台探测类为何保留

真机与桌面 JDK 的 JCA 算法名注册集**不同**，编译期与 JVM 单测都无法暴露。
X25519Probe 把探测结果一次性打全，并在服务启动时入日志——换设备/刷系统后的
第一个排查锚点。这不是临时调试代码，是长期运维工具。

## 4. 真机暴露的 7 处缺陷（全部修复）

### 4.1 Android 的 X25519 算法名是 `XDH`（桌面 JDK 反之）——握手必崩

- **现象**：`NoSuchAlgorithmException: X25519 KeyPairGenerator not available` → App 崩。
- **根因**：Android（Conscrypt/BouncyCastle）只注册规范名 `XDH`；桌面 JDK 17 注册 `X25519`。
  M3.1 实现按桌面 JDK 写死 `"X25519"`，编译过、JVM 测试全绿、真机必崩。
- **修法**：X25519Platform 多名字探测（X25519/XDH/X25519DH，**刻意不含 "EC"**——
  它在两端都存在，作后备会探测出假阳性），两平台走同一条代码路径；
  并补 basepoint 路径测试（RFC 7748 向量锚定 `pub = X25519(priv, 9)`）。

### 4.2 核心端配对期无应用层心跳 → relay 60s 判死房间

- **现象**：真机扫码后 `room-unavailable`。
- **根因**：relay 活跃判定**只认应用层帧**（ping/join/frame），60s 未见即 destroyRoom。
  服务层 ensureHeartbeat 只在 `connections.size > 0` 时启动，配对期连接尚未入表——
  **恰好是盲区**。用户从「点添加设备」到「扫码完成」超 60 秒（开 App、授权相机、对准屏幕）
  即必现；M3.1 的 loopback 客户端拿码后毫秒级 join，完全测不出来。
- **修法**：`RelayConnection.startKeepalive()`（25s 周期，`unref()` 保 pnpm dev 自退），
  由连接自身负责而非依赖服务层——「连接活着就保持活跃」。

### 4.3 协议缺 deviceId 下发信令 → 断线后永久无法重连（最严重）

- **根因**：KK 重连房间号 = `SHA256(core_pub‖deviceId‖device_pub)`，而 **deviceId 是核心端
  分配**的（`dev-<rand>`）——手机侧无从自行得知。M3.1 的 loopback 客户端靠直连本地 RPC
  查注册表绕过了它，真机没有这个通道。缺这条信令时手机断线后算不出房间号，
  **重连永久失败**，且是静默失败（只能一直重试）。
- **修法**：配对成功后核心端经**加密通道**下发 `{type:"remote/paired", data:{deviceId, scopes}}`，
  手机落 PairingStore；scopes 一并下发供 UI 展示。

### 4.4 `adb install -r` 不真正替换 APK（Windows 环境）

- **现象**：真机跑旧代码，而源码、编译产物、APK 时间戳全是最新——极易误判为「代码没生效」。
  实测设备 APK 与本地 APK **字节数完全相同**（19059529），改动符号在 dex 里搜不到。
- **修法**：`BuildConfig.BUILD_TAG`（构建时间戳）启动即打印 + 关键回归一律 `uninstall` 后 `install`。
  纯工程环境坑，但**消耗的排障时间最多**，值得固化。

### 4.5 `awaitPaired` 中 phase 先于 bridgePort 设置 → 桥永不加载

- **根因**：先置 `ONLINE` 再 `startBridge()`，UI 的 collect 收到 ONLINE 时 `bridgePort` 仍为 null，
  加载分支永不触发。
- **修法**：先起桥拿端口，再置 ONLINE（顺序即语义）。

### 4.6 webui 的其他 HTTP 面依赖未桥接（**M3.4 前置项**）

- **现象**：真机 console 报 `remote bridge: HTTP API path not bridged`。
- **范围**：`/api/ui/extensions`（UI 插件清单）、`/api/workspace/tree|file|raw`（工作区文件与图片）、
  `/api/workspaces`（工作区列表）。会话/聊天面**已通**（448 条真实数据到位）；
  受影响的是附属面板（文件预览、UI 插件）。
- **性质**：与 M3.2 的 `/api/ui/boot-graph` 同源——「远程 WebView 面的完备性 = webui 启动与
  交互路径上的**全部**宿主 HTTP 依赖」，且 `raw` 类是**二进制流**，不适合走 RPC。
- **候选方案**（留 M3.4 定夺）：桥做**通用 HTTP 代理**（`/api/*` 经加密通道转发到核心端执行，
  二进制走 base64），而非逐个端点 bridge——后者会持续追着 webui 的新端点跑。

### 4.7 `remote/status.state` 在配对期恒为 `pairing`

- **根因**：`RemoteLinkStatus.state` 只有 idle/pairing/online/connecting/error；
  `sas-confirm` 是**配对会话**级字段而非链路状态。自动化脚本若靠 `state === "sas-confirm"`
  判断阶段会永久等待。
- **处置**：验证脚本改为「重试 `remote/pair-confirm` 直到成功」，不依赖该字段。

## 5. 全链路复现（真机/模拟器）

```
# 0) 模拟器（无真机时）
C:\Android\Sdk\emulator\emulator.exe -avd acphone -no-snapshot-save -gpu swiftshader_indirect
adb reverse tcp:18443 tcp:18443   # relay 经 loopback 转发进设备

# 1) 核心端
cd src/ac-relay-server && RELAY_PORT=18443 RELAY_HOST=127.0.0.1 npx tsx src/main.ts
LOOPBACK_PORT=4183 npx tsx scripts/remote-loopback-host.ts

# 2) 手机端（构建 + **卸载重装**——见 §4.4）
cd mobile/app && node ../scripts/sync-webui.mjs && npx cap sync android
cd android && ./gradlew.bat assembleDebug
adb uninstall com.agentchat.mobile; adb install app/build/outputs/apk/debug/app-debug.apk

# 3) 配对：取二维码 → 深链唤起 → 用户在核心端确认
node .dsh/tmp/m33-run.mjs          # 起配对会话并自动确认（写 .dsh/tmp/qr-run.txt）
adb shell am start -a android.intent.action.VIEW -d "$(cat .dsh/tmp/qr-run.txt)" com.agentchat.mobile
```

## 6. 待办（M3.4）

- **§4.6 HTTP 面补齐**（通用 HTTP 代理）——webui 完整可用的最后一块。
- 生物识别解锁才连 relay（方案「锁」行；当前仅实现「切后台即断」）。
- 事件下行（流式）与 KK 重连的 UI 状态呈现。
- 桥的大载荷分片（8MB 单帧上限只是缓解）。

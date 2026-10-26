# M3 安卓端·真机验证实况（Redmi K20 轮）

> 背景：M3.1–M3.5 已实施并通过模拟器验收（见 src/docs/m3{1..5}-*.md）。
> 2026-09-28 真机轮（Redmi K20 / MIUI 12.5 / Android 11 / WebView 92.0.4515.131）
> 首次落地——**模拟器长期掩盖的三处致命缺陷当轮暴露并修复**（cr-13/14/15）。

## 0. 接机记录

| 项 | 值 |
|---|---|
| 设备 | Redmi K20（davinci）/ Android 11 / MIUI 12.5 |
| WebView | com.google.android.webview 92.0.4515.131（Chrome 92）——**远旧于桌面与模拟器** |
| JCA | X25519 / XDH / X25519DH 三族算法名**全无**（含 BC provider） |
| BUILD_TAG | 1790571001572（启动即打，核对通过） |
| 网络 | 手机 192.168.1.3；实测 ping PC 丢包 25%、RTT 30–50ms（RSSI -66） |

## 1. 真机暴露并修复的三处致命缺陷

### 1.1 webui 产物未声明最低运行环境（cr-13）

**两层，都是「桌面/模拟器 Chromium 版本新 → 永远看不见」**：

| 层 | 现象 | 根因 |
|---|---|---|
| 运行时 API | Object.hasOwn is not a function → 装配崩、白屏 | esbuild（含 build.target）**只降语法、不补 API**；cordis 打包进的 Object.hasOwn（Chrome 93）WebView 92 没有 |
| 语法 | SyntaxError: Unexpected token 花括号 → 整块 chunk 不执行 | esbuild 对 **class static block**（Chrome 94）**不降级只警告**，vendor/cordis 的 static 块原样残留 |

修法（三处同一份基线，改须同步）：

1. src/webui/public/legacy-runtime.js——垫片（classic script 先于 module 求值，逐个 feature-detect）；
2. src/webui/vite.config.ts——build.target chrome92 + esbuild.supported 关 class-static-blocks；
3. scripts/check-webview-baseline.mjs——构建期守门（API 面 + 语法面双判据，接入 webui:build）。

### 1.2 真机 API ≤ 32 无 X25519（cr-14）

- **现象**：首配即闪退（NoiseException: 本平台无 X25519 实现，crash 栈直达 X25519Platform.require）。
- **根因**：API 33+ 的 Conscrypt 才带 X25519；K20（API 30）三族算法名全无。M3.1 注释即写明「API 28–32 没有」，但当时只做 fail-loud 探测、未做兜底。
- **修法**：新增 X25519Pure.kt（RFC 7748 BigInteger ladder），dh() 探测优先 JCA、缺席落纯实现；X25519PureTest 5 例锚定（§5.2×2 + §6.1 DH 交互 + JCA/纯实现一致性 + basepoint 生成）。
- **次生坑**：BigInteger.TWO 是 JDK 9+ 常量，Android API 30 core-libart 无 → NoSuchFieldError（**JVM 单测全绿、真机崩**——再次印证「桌面绿 ≠ 真机绿」）。

### 1.3 验证基建（cr-15）

WebView CDP 调试口（debug 门控）· debug 跳过生物锁 · 局域网明文放行 · loopback 宿主 LOOPBACK_AUTO_RECONNECT · relay 限额 env 口 + RELAY_DEBUG 生命周期日志。

## 2. 验证结果

### 2.1 安装与首启 ✅

- 卸载重装 Success（须先开 MIUI「USB 安装」——否则 INSTALL_FAILED_USER_RESTRICTED）；
- 启动无 crash；BUILD_TAG 核对通过；X25519Probe 输出全 NO（→ 落纯实现路径）。

### 2.2 生物锁 ✅（A 正路径 + 断链语义）

- 默认开（A）：冷启弹系统指纹面板 → 解锁 → 起链路（日志「解锁成功」）；
- 切后台即断链（链路关闭: ping timeout）✓ 符合方案「锁」行；
- 回前台重新过锁（「解锁 AgentChat」面板）✓；
- ⏳ 未验：取消解锁、切 B（关闭丢机保护）、切回 A。

### 2.3 配对与 Keystore ✅

- 深链唤起配对（am start -a VIEW -d uri——**URI 须单引号包裹**，否则 & 被 shell 截断成 agentchat://pair?v=1，M3.4 坑复用）；
- XK 握手成功（X25519 纯实现真机首跑）→ SAS 4498 8347 **两端一致** ✓；
- 核心端确认 → remote/paired 信令 → deviceId 下发 → KK 重连 → 桥起（端口 42427）→ WebView 加载完整 WebUI ✓；
- run-as ls files/ → identity.enc 存在，权限 -rw-------（0600），124B ✓。

### 2.4 在线态全链路 ◐

- ✅ **WebView 加载真实数据**：Agent 列表（含自定义 helper）、会话列表、辅助面板全就位；
- ✅ **发消息 → 流式回复**（loopback 宿主 + DeepSeek 真凭据）：

      conversation/deliver → router/message-received → loop/run-started
        → loop/step-started → llm/delta-start → llm/delta ×N（逐字）
        → llm/delta-end → loop/after-step → loop/after-run → router/reply-completed

  **859 帧事件流、398 帧 llm 相关**，回复文本正确返回。此即模拟器做不成的「LLM 流式遗留项」闭环。
- ⏳ 未验（受阻，见 §3）：手机端 WebView 内呈现流式、飞行模式重连、切后台 30s 恢复。

### 2.5 版本提醒 ⏳

未执行（依赖稳定在线态）。

## 3. 本轮阻断项（环境 + 架构，未修复）

### 3.1 adb reverse 通道长时不稳（原清单 §4.2 预言成真）

USB reverse 下链路**约 25s 后必断**（sent ping but did not receive pong）——非 relay 问题（PC 侧裸 WS 长连 40s+ 存活、手机侧 curl 8/8 通）。

### 3.2 手机 WiFi 链路质量差

实测丢包 25%、RTT 30–50ms。局域网直连（192.168.1.6:18443）能连上，但长连仍 25s 级掉线。

### 3.3 KK 重连握手时序竞态 —— **已修复（cr-16）**

relay 日志实测（RELAY_DEBUG=1）：

      #2 <- join  #2 <- frame   ← 设备（KK 发起方）join 后立即发 m1
      #3 <- join                ← 宿主（响应方）稍后才 join，只等不发

根因三层，全部修复：

1. **发起方单次长等待**（15s）→ 改 `KK_HANDSHAKE_TIMEOUT_MS=3s` 短窗 + `RemoteSession.tryReconnect` 10 轮整链重试（每轮新 dial/新握手，对齐 scripts/remote-loopback-client.ts 的既有裁决——M3.1 Kotlin 移植漏了该重试层）；
2. **响应方不主动进房**（构造器不 connect）→ `RemoteLinkService` 构造器补「启动即连」；
3. 重试节奏受 relay join 频控约束（burst 5 / 10 每分钟 per IP）→ 3s 超时 + 4s 间隔 ≈ 8.5 join/min 不触顶。

真机复验：设备重试机制生效（`KK 重连第 N/10 轮` 日志节律 7s/轮），握手可通（在线过 25s）。回归锁：`RelayReconnectTimeoutTest`（ktor 夹具：m2 不到必须快速失败，防有人改回长挂）。

**仍未解的**是环境性断链：reverse 通道与手机 WiFi 各自的 25s 级断流（见 §3.1/3.2）——握手通后仍会被物理断链打断，属测试环境问题，生产 relay（公网 VPS + 手机蜂窝/WiFi）不存在此场景。

### 3.4 本地联调特有：双端同 IP 挤兑 relay 限额

adb reverse 出口与宿主同为 127.0.0.1 → 共享 maxConnPerIp=5 与 joinBucket（5 突发/10 每分钟）→ 重试期互相挤兑（已加 env 放宽口，生产双端异 IP 不受影响）。

## 4. 快速命令备忘（真机轮实录）

    adb 设备确认：C:\Android\Sdk\platform-tools\adb.exe devices
    卸载重装：adb uninstall com.agentchat.mobile && adb install <apk>
       —— 改 shared_prefs 后想保配对：install -r（同签名覆盖）
    前端同步：node mobile/scripts/sync-webui.mjs && (cd mobile/app && npx cap sync android)
       注意 pnpm --filter ac-mobile-app sync 是空操作（mobile/app 不在 workspace）
    日志：adb logcat -s AgentChatRemote AgentChatBio AgentChatUpdate
    深链配对（URI 必须单引号）：adb shell "am start -a android.intent.action.VIEW -d <uri> com.agentchat.mobile"

## 5. 环境坑备忘（新增）

1. **MIUI「USB 安装」开关**：不开则 INSTALL_FAILED_USER_RESTRICTED: Install canceled by user。
2. **「等待调试器」**：开发者选项若选了本 App 为调试应用并勾等待调试器，App 挂在 Waiting For Debugger 窗口（日志空、像死机）。清：adb shell am clear-debug-app + settings put global wait_for_debugger 0。
3. **relay 多实例抢端口**：残留进程抢 18443 会导致连接数虚高与莫名 room-unavailable。起前务必确认监听者唯一。
4. **本机网络栈过载**：高频探测进程 + TIME_WAIT 堆积会触发 ENOBUFS/socket 缓冲耗尽。批量探测后清理残留进程。
5. **loopback 宿主凭据 key 名**：ac-llm-pool 查的是 getGlobal(pool:provider) → 凭据文件 key = __GLOBAL___POOL:<PROVIDER>_API_KEY（大写、三个下划线）。写错则静默走「无凭据」→ LLM 401。
6. **模拟器基线错觉**：模拟器 API 33+ 有 Conscrypt X25519、Chromium 新 → 掩盖 WebView 92 与 JCA 两组缺口。凡涉及「浏览器/密码学原语」的验收，**真机才算数**。

## 6. 待办

- [ ] §2.4 剩余：手机端 WebView 内流式呈现、飞行模式重连、切后台恢复（待链路稳定）；
- [ ] §2.5 版本提醒；
- [ ] §2.2 剩余：取消解锁 / 切 B / 切回 A；
- [x] ~~§3.3 KK 握手时序竞态~~（已修复 cr-16：发起方短超时重试 + 响应方启动即连 + 契约测试锁）；
- [ ] CSS color-mix()（Chrome 111）兜底（cr-13 遗留，非阻断）；
- [ ] 相机扫码器（原清单 §2.1）。

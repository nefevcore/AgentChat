# M3 真机验证 · 会话交接单（2026-09-28）

> 完整实况见 src/docs/m3-realdevice-checklist.md（134 行，已含全部细节）。
> 本单只列「下一会话继续时最先要看的」。

## 一、已完成（全部带测试/文档锁）

| 项 | 状态 | 凭据 |
|---|---|---|
| §1.1 安装首启 / BUILD_TAG / X25519Probe | ✅ | 文档 §2.1 |
| §1.2 生物锁 A 正路径 + 切后台断链 + 回前台过锁 | ✅ | 文档 §2.2 |
| §1.3 配对 SAS 一致 + identity.enc 0600 + WebView 全量加载 | ✅ | 文档 §2.3 |
| §1.4 WebView 真实数据 + LLM 流式 859 帧（DeepSeek 真凭据） | ✅ | 文档 §2.4 |
| cr-13 WebView92 基线（垫片+static block+守门） | ✅ | 测试+构建守门 |
| cr-14 X25519Pure（RFC7748 向量 5/5） | ✅ | X25519PureTest |
| cr-15 验证基建 | ✅ | — |
| cr-16 KK 时序竞态（重试+启动即连） | ✅ | RelayReconnectTimeoutTest |
| 验证阶梯 | ✅ | typecheck/2181 单测/deps/lint 全绿 |

## 二、下一会话待办（按优先级）

1. **§1.5 版本提醒**（约 10 分钟）：loopback 宿主起 download-gate + manifest 调高 → 看 App 更新条。
   - download-gate 起法：cd src/ac-relay-server && npx tsx src/download-gate.ts（监听 127.0.0.1:12700）
   - 注意设备的 UPDATE_MANIFEST_URL 指向 127.0.0.1:18080（旧值），可能要 adb reverse tcp:18080 或改配置
2. **§1.2 生物锁剩余**（需用户在场）：取消解锁 / 切 B（关丢机保护）/ 切回 A——UI 都在配对面板，手工点验即可。
3. **相机扫码器**（原清单 §2.1，约半天）：zxing-embedded，零 GMS 依赖；扫码后 pairWith(uri) 入口已就绪。
4. **CSS color-mix() 兜底**（cr-13 遗留，非阻断）：产物大量无兜底声明，WebView 92 样式降级。

## 三、环境要点（避坑）

- relay 启动：须带 env（RELAY_DEBUG=1 RELAY_MAX_CONN_PER_IP=64 RELAY_JOIN_BURST=64 RELAY_JOIN_RATE=2），且**先确认 18443 无残留监听**（多实例 = 灾难）。
- loopback 宿主：AGENTCHAT_DATA_ROOT=.dsh/tmp/loopback-data（独立根）+ LOOPBACK_AUTO_RECONNECT=1；凭据已写入（key=__GLOBAL___POOL:DEEPSEEK_API_KEY，热生效）。
- 深链 URI 必须**单引号包裹**（& 截断坑）；保配对重装用 install -r。
- 设备当前 relayUrl=ws://192.168.1.6:18443（局域网直连，写在 shared_prefs/agentchat.remote.xml）。
- 手机保持亮屏（svc power stayon true 已设）；doze 已禁。
- **已知环境限制**：reverse 通道与手机 WiFi 各 25s 级断流（物理层，生产公网 relay 无此场景）——别再在这上面耗时间。
- 设备端 debug 构建跳过生物锁 + 开了 WebView CDP（chrome://inspect → 9222 forward webview_devtools_remote_<pid>）。

## 四、验证命令速查

    transport 测试：用本机 gradle（mobile/transport 无 wrapper）
      & ~/.gradle/wrapper/dists/gradle-8.2.1-all/d8pvvlun5bx6sdtwqhf8y9z4b/gradle-8.2.1/bin/gradle.bat test
    APK：cd mobile/app/android && gradlew.bat assembleDebug
    前端同步：node mobile/scripts/sync-webui.mjs && (cd mobile/app && npx cap sync android)
      注意 pnpm --filter ac-mobile-app sync 是空操作（不在 workspace）

## 五、未提交改动

git working tree 有大量未提交内容（含本轮全部修复）。建议下一会话与用户确认后分批提交：
- mobile/：X25519Pure(.kt+test)、RelayClient/RemoteSession/MainActivity/network_security_config
- src/webui/：legacy-runtime.js、vite.config、index.html
- scripts/：check-webview-baseline.mjs、remote-loopback-host.ts
- src/ac-relay-server/src/main.ts（诊断日志+限额 env）
- src/ac-remote-link/src/service.ts（启动即连）
- src/docs/：cr-log.md（cr-13~16）、m3-realdevice-checklist.md（重写实况）
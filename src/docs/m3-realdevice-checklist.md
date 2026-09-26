# M3 安卓端·真机验证待办（设备到位后继续）

> 背景：M3.1–M3.5 已全部实施并通过模拟器验收（见 src/docs/m3{1..5}-*.md）。
> 用户将提供一台 USB 真机。本文是接机后按序执行的清单——每项标注前置状态
> （已实现待验 / 需先开发），做完即勾销。

## 0. 接机标准流程

1. 用户侧：设置 → 关于手机 → 连点「版本号」7 次开开发者模式 → 开 USB 调试
2. 插 USB → 手机弹「允许 USB 调试」→ 允许（部分品牌需装驱动）
3. 验证：adb devices 应显示 device（不是 unauthorized）

## 1. 真机验证清单（按依赖序，均为「已实现、只差真机」）

### 1.1 安装与首启（5 分钟）

- [ ] 卸载重装（M3.3 踩坑：adb install 在 Windows 会静默不替换）+ 核对 BUILD_TAG
- [ ] X25519Probe 探测输出（真机算法名注册集可能与模拟器不同）

### 1.2 生物锁正路径 + A/B 开关（本轮新实现，完全未验）

- [ ] 默认开（A）：打开 App → 弹系统生物识别面板 → 解锁 → 连接
- [ ] 取消解锁 → 「已取消解锁」不建链路；重开可重试
- [ ] 切 B：配对面板底部复选框取消 → 风险确认弹窗 → 重启 App 直接连接
      （日志「生物锁已由用户关闭」）
- [ ] 切回 A：重新勾选恢复解锁门
- [ ] 无硬件设备降级放行（模拟器已验，真机复确认）

### 1.3 配对与 Keystore（M3.3 模拟器已验，真机复跑）

- [ ] 粘贴二维码链接配对（扫码器未实现，见 §2.1）
- [ ] SAS 显示 → 核心端确认 → 设备上线（remote/devices online:true）
- [ ] run-as ls files/ → identity.enc 存在且 0600

### 1.4 在线态全链路（连用户真实核心端——补齐 LLM 流式遗留项）

模拟器没做成的原因：loopback 测试数据根无 LLM 凭据。真机连日常运行的核心端
（有 provider 配置）即可闭环：

- [ ] WebView 加载会话列表（真实数据）
- [ ] 发消息 → 流式回复（llm/delta 逐字出现）
- [ ] 飞行模式 10s → 恢复 → 自动重连 → 会话可用
- [ ] 切后台 30s → 断链 → 回前台 → 解锁 → 重连

### 1.5 版本提醒（M3.5 模拟器已验，真机复跑）

- [ ] 服务端 manifest 版本调高 → App 内更新提示出现

## 2. 需先开发的项（验证前决定要不要）

### 2.1 相机扫码器（建议做——配对入口该有它）

- 现状：M3.3 用深链模拟了扫码动作；真实扫码未实现。
- 方案：zxing-embedded（零 Google 服务依赖——国内真机可能无 GMS，不选 MLKit）。
  约半天。扫码后动作已就绪（pairWith(uri) 与深链同入口）。

### 2.2 wss + 证书钉扎（仅当要连生产 relay）

- 现状：本地验证走 ws:// + adb reverse。生产 relay（自签 wss）需 CertificatePinner。
  二维码已带 relay 地址，按 URI scheme 自动分支即可。真机走 PC 本机 relay 则可后置。

### 2.3 可选打磨（不阻塞）

- 桥大载荷分片（8MB 单帧上限的彻底解）
- 通知栏常驻图标点按回 App；App 图标 / 启动图（现为 Capacitor 默认）

## 3. 快速命令备忘

adb 设备确认：C:\Android\Sdk\platform-tools\adb.exe devices
卸载重装：adb uninstall com.agentchat.mobile && adb install <apk 路径>
日志：adb logcat -s AgentChatRemote AgentChatBio RemoteSession
界面状态：adb shell dumpsys activity top | findstr MainActivity

## 4. 已知环境坑备忘（M3.3–M3.5 实录）

1. adb install 不替换：关键回归一律卸载重装；BUILD_TAG 启动即打，先核对。
2. adb reverse 长时稳定性：模拟器约 2.5 分钟后 OkHttp ping 超时断链（reverse 通道
   抖动）。真机 USB 直连待观察；若复现改走 PC 局域网 IP 直连 relay。
3. 模拟器生物锁：无安全锁定可录 → 只验过降级分支。真机 §1.2 补齐。
4. loopback 数据根无 LLM 凭据：流式验收必须连真实核心端（§1.4）。

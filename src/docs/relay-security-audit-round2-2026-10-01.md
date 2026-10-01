# 哑中继安全审计第二轮：外部攻破服务器 → 用户 PC 入侵链路

> 审计日期：2026-10-01 · 纯审计，未改动任何代码
> **修复状态（cr-77，2026-10-01）**：R-1 已修（壳层侧）——桌面更新链双源校验：fetchUpdateManifest 拉下载面 manifest 后与 GitHub Releases tag 资产 manifest.json（CI desktop.yml 收尾 job 上传的信任锚）逐文件比对 sha256/size，锚不可达或单侧不一致即拒绝呈现更新（fail-closed）；install 端点拉起前对就位文件就地复核 sha256。R-2 已修——SAS 确认从「点按钮」改为「输入手机屏显 8 位数字」，服务端与握手产物核对（confirmPairing 第三参），拒绝路径不受限。遗留：HTTPS（需备案域名）与代码签名（EV 证书）为部署/成本项，未动。
> 问题定义：攻击者控制中继 VPS（root 失守）后，能否将入侵延伸到用户 PC？
> 审计面：`src/ac-noise-core`（Noise 协议库）、`src/ac-remote-link`（PC 核心端）、`desktop/main.mjs`（桌面壳更新链）、`src/ac-relay-server`（中继+下载面）

## 威胁模型

攻击者能力（VPS root 失守后）：

1. 完全控制 relay 进程：读写/注入/丢弃 ws 帧、伪造房间、观察密文与元数据、替换 TLS 证书；
2. 完全控制同机下载面：篡改 manifest.json、替换安装包字节、伪造版本号；
3. 无法获得：PC 核心端 X25519 静态私钥、已配对设备的静态私钥（二者都在用户侧磁盘）。

## 逐链路分析

### 链路 A：relay MITM → 伪装设备握手 PC（密码学上阻断）

- KK 重连：攻击者不持有已配对设备私钥 → m3 的 `se`（DH(静态私钥, 临时公钥)）无法构造，AEAD 解密失败或公钥与 known_devices 不匹配 → 握手失败。`getByPubkey` 查注册表门禁在落库之前（service.ts L327-333：SAS 确认后 upsert）。伪装不可行。
- XK 新配对：攻击者可抢在真手机前进房完成握手（XK 对 initiator 无预认证），但产物要过 **SAS 人工比对**（8 位数字，SHA256(handshake_hash) 前 4 字节）——攻击者握手的 hash 与真手机不同，SAS 必不一致。盲确认见 R-2。
- 传输帧：ChaCha20-Poly1305 AEAD + 严格递增 nonce（`n <= lastRecv` 即拒，noise-core L484）——relay 无密钥，注入/重放/乱序全部失败，只能丢弃（DoS）。
- TLS：`rejectUnauthorized:false`（自签）+ 可选 sha256 pin（cr-65 已实装，relay-connection L320-325）。未配 pin 时 TLS 仅混淆层——认证职责全在 Noise，与设计裁决一致。

**结论：relay 被攻破对链路 A 只剩 DoS 与元数据（在线时段/流量大小/IP），无法触碰 PC。**

### 链路 B：下载面 → 恶意更新推入 PC（高危，真实可行）

桌面壳更新链（desktop/main.mjs）：

1. `DOWNLOAD_BASE = http://47.110.63.135`——明文 HTTP，与 relay 同一台服务器；
2. 每 4h 取 `/manifest.json` 决定是否有新版；
3. 后台静默预下载，sha256 校验值 `asset.sha256` 取自同一个 manifest；
4. 用户点「安装」→ `spawn(file)` 直接执行 NSIS 向导。

设计文档 plan §4.6 原始裁决是「版本清单与信任锚分离：git 仓库存哈希（信任锚）、服务器存字节（数据源）——MITM 换掉服务器上的字节也过不了校验」。但 2026-09-21 演进裁决放宽：「不经 git raw 中转——检查走 HTTP manifest 本身，完整性校验在安装包下载页侧 sha256」。放宽后：

- **sha256 与字节同源同信道**——校验只防传输损坏，不防投毒；
- **门槛比攻破服务器更低**：网络路径任何 MITM（咖啡店 WiFi、劫持的运营商链路）即可伪造 manifest（抬高版本号 + 自带 sha256）+ 投毒安装包，全链明文 HTTP 无证书校验；
- 服务器 root 失守同效且更持久；
- Windows 产物无代码签名（electron-builder 未配证书；macOS 仅 ad-hoc）——操作系统层无兜底，用户看到的是「正常更新」。

**攻击链完整成立：MITM/服务器沦陷 → 伪造 manifest → 静默预下载 → 用户一键确认 → 任意代码以用户权限执行。这是本轮审计最高优先级发现（R-1）。**

### 链路 C：relay → 手机端

手机是 Noise initiator，握手绑定 PC 静态公钥（二维码带外预置）——relay 伪装 PC 同样不可行。手机 APK 更新走同一下载面，R-1 同效（安卓侧安装有系统确认对话框，略多一道摩擦）。

### 链路 D：relay 进程漏洞直接 RCE

第一轮已审（见 relay-security-audit-2026-10-01.md）：控制帧仅 4 个 op 的小 JSON、opaque 转发不解析、maxPayload 上限、单连接 error sink。未发现可 RCE 的输入面；F-1（download-gate 崩溃）为 DoS 级。

### 链路 E：PC 端收到合法远程指令后的爆炸半径（设计已知，明确边界）

chat 档允许 `conversation/deliver` = 恶意配对/被盗手机可与 Agent 对话 → Agent 的 bash/文件工具直达宿主。缓解现状：deliver 强制 sender=remote:<id> 且剥 elevation；files 档默认不开；admin 档显式禁用（SCOPE_ALLOWED_METHODS 空表）。这是「远程访问」的产品语义本身，不算漏洞，但 R-1 成立时攻击者根本不需要走这条链——直接推更新更省事。

## 发现清单

### R-1〔高〕更新信任链自指 + 明文 HTTP 分发

见链路 B。manifest 与 sha256 同源同信道，明文 HTTP，无代码签名。
建议（按性价比排序）：

1. **恢复哈希/字节分离**：manifest 至少双源对照（下载面主源 + git raw/GitHub 兜底源哈希核对——`ac-web-api/src/version.ts` 已有双源先例，桌面壳未跟进）；不一致即拒绝更新；
2. **启用 HTTPS**：公共 CA 证书需备案域名是已知约束；退而求其次自签 + 壳层 pin（技术已在链路 A 验证过）；
3. 长期：Windows 代码签名证书（EV 可过 SmartScreen）——操作系统层的最终兜底。

### R-2〔低〕SAS 盲确认残余（社会工程）

恶意 relay 可在用户发起新配对时抢先握手，赌用户不看手机上的 SAS 数字直接点确认（1e-8 撞对概率）。缓解：确认 UI 从「点按钮」改为「要求输入手机显示的 8 位数字」。

### R-3〔提示〕部署面落实核查

plan §4.5 加固清单（read-only fs / cap_drop / MemoryMax / SSH 收紧）在文档层已定——本轮代码审计无法验证服务器实际配置，建议上线 checklist 逐项打勾存档。

## 结论

| 攻击路径 | 可行性 | 依据 |
|---|---|---|
| relay MITM 伪装已配对设备 | ✗ | KK 双向认证，无私钥不可完成 m3 |
| relay MITM 新配对冒充手机 | ✗（SAS 比对）/ 残余（盲确认 R-2） | SAS 绑定 handshake hash |
| relay 注入/重放业务帧 | ✗ | AEAD + 严格递增 nonce |
| relay → PC 经 chat 档指挥 Agent | 需先过配对（同上阻断） | scopes 闸门 + 剥 elevation |
| **下载面/MITM → 恶意更新入 PC** | **✓ 高危** | **R-1：哈希与字节同源 + 明文 HTTP + 无签名** |
| relay 进程 RCE | 未发现 | 第一轮审计（DoS 级 F-1 除外） |

**总评：中继转发链路的密码学设计稳健，服务器被攻破也无法穿透 Noise 层触碰 PC；但同机下载面的更新信任链存在自指缺陷，攻击者根本不需要打转发链路——直接推恶意更新即可。修复优先级：R-1 双源校验 > HTTPS > 代码签名。**

# 哑中继安全审计报告（实战攻击验证）

日期：2026-10-17 · 审计范围：ac-relay-server / ac-remote-link / ac-noise-core
方法：7 个实战 PoC（.dsh/tmp/poc/poc*.mjs），全部针对本仓库真实代码/真实进程，无 DDOS/无流量攻击。

## P0 —— KK 重连握手是 NK 降级：任意拥公者可冒充已配对设备（致命）

PoC-1 / PoC-2 / PoC-7 三连实锤，端到端打通。

- ac-noise-core/src/index.ts 的 PATTERN_KK = [['e','es'],['e','ee']] —— 这是 Noise NK 的消息形状，不是 KK。
- 真 KK 应为 -> e,es,s,ss <- e,ee：发起方静态公钥 s 出现在 m1，且 ss = DH(发起方静态私钥, 响应方静态公钥) 把发起方身份搅进密钥。
- 现实现中发起方静态私钥从未参与任何 DH。responder 传入的 targetDevicePubkey 只用于 es 计算——攻击者只要知道 PC 公钥（公开信息）即可完成握手。
- 文档《握手时序图》声称「es/ee 隐式认证，只有真手机公钥能对上」是错误的：es 认证的是 PC（对手机方向），ee 是临时-临时 DH 无任何认证性。

### 实战结果

- PoC-1（纯密码学层）：全新身份与「期待 victim 公钥」的 PC responder 完成握手，双向解密成功。
- PoC-2（真 relay 进程 + PC 真实 RelayConnection 类）：攻击者冒充 dev-victim，注入 session/history（读全部会话）与 conversation/deliver（以主人身份向 Agent 下指令）均被 PC 接受处理。
- PoC-7（完整链路）：冒充后 PC 主动下发 llm/delta 流，攻击者实时解密——实时明文窃听全部 AI 输出（含 tool 轨迹）。

### 攻击者所需信息（全部公开）

relay 地址、PC 静态公钥、已配对设备公钥、deviceId。前两者来自二维码/信令流通，后两者可从任何一次泄漏获得。不需要任何私钥。

### 连带缺陷

- relay-connection.ts:200：KK 成功后 outcome.device.pubkey = targetDevicePubkey——用自己传入的期望值当验证结果（自我确认）。即使将来修好 KK，此写法也会让身份校验形同虚设。

### 修复方向

1. PATTERN_KK 改为真 KK [['e','es','s','ss'],['e','ee']]（安卓 Noise.kt 同步改）；responder 处理 m1 的 s 段后与注册表比对，不符即断。
2. outcome.device.pubkey 必须取握手实际解出的公钥。
3. 补回归测试：全新身份 initiator 与期待 victim 的 responder 握手必须失败（poc1 可直接改造）。

## P1 —— 确定性房间号 = 占座阻断 DoS（PoC-3a 实锤）

- KK 房间号 = SHA256(pc_pub || deviceId || device_pub) 公开可算。
- 攻击者先 join 占 1 席，PC responder 占另 1 席长驻等 m1（70s 窗口）→ 真手机 join 永远 2/2 满员被拒。
- 实测：攻击者一条每 15s 一个 ping 的空闲连接，真手机连续 4 轮 join 全部 room-unavailable。
- 非流量型攻击：成本 ≈ 1 条空闲连接/目标设备。PC 侧同时空转 KK 重试 + 指数退避循环。

修复方向：房间号掺入双方可同步重算的会话盐（如两端各自递增的 attempt 计数共同收敛）；或 PC 端对「joined 但长时间无 m1」的房间主动放弃 + 错峰重试，压缩攻击窗口。

## P1 —— relay 资源面（PoC-3b 实测 + 源码证明）

- maxRooms=10000 全局共享：500 个 IP × 20 房（burst 内合法）即可让全球所有用户新房间（含 KK 重连房）全灭。单点故障域 = 全租户。
- joinBuckets / frameBuckets 两个 Map 只增不减（全源码无删除路径）：每个出现过的高频 IP 永久残留一条 entry，缓慢内存泄漏。
- 孤儿房间（1 席等待期）占满 5min TTL 才被 sweep。

修复方向：sweep 顺带清扫「上次 take 超过 N 分钟」的 bucket entry；maxRooms 提升为按 IP 配额 + 全局软限报警；限制单 IP 未封闭房间数。

## P2 —— 授权模型（源码级实锤）

1. 下行事件不分 scopes（service.ts broadcastEvent 遍历全部 connections）：chat-only（无 read 档）设备照样实时收全部 llm/delta AI 回复明文 + 工具轨迹。「能发不能看」的权限设计被下行广播击穿。
2. read 档混入写操作：singles/update（改名/归档/改模型设置）、singles/fork（会话分支写入）都在 read 白名单。只读设备可篡改会话元数据。

修复方向：broadcastEvent 按 device.scopes 过滤；singles/update、singles/fork 移出 read 档。

## P2 —— 配对面（PoC-4：SAS 是唯一防线，成立但有磨损面）

- 抢先入房可行；设备名任意伪造（实测上报「妻子手机」照单全收）。
- SAS 数字比对是有效防线（PoC-4 确认环节拦住了）——但它防「中间人转接」，不防「攻击者直接当对端 + 钓鱼确认」。

修复方向：SAS 确认界面显著显示新设备公钥指纹；设备名不可作为信任提示；TTL 到期强制重生成房间号。

## P3 —— 记录在案

- 跨会话重放：无显式防线，靠每次握手新密钥隐式覆盖（可接受，PoC-6 验证）。
- TLS pin 缺省空：文档称「认证全在 Noise 层」，但 KCI 场景下手机无法验证 relay/PC 真伪。修好 KK 前是次要矛盾。
- relay-connection.ts:230 双重 find 写法有死代码异味（第一分支永 false）。
- download-gate：.. 用子串匹配会误拒合法文件名（过度拒绝，非漏洞）；路径清洗 + loopback 绑定扎实。

## 攻击成本总结（最致命链路）

信息收集（全公开）→ 占房（join 抢先）→ 冒充（KK 握手，无需私钥）→ 收割（读会话 / 指挥 Agent / 实时窃听）。
总成本：一段脚本 + 一条 WS 连接。建议在修复 KK 前不要将 relay 部署到任何不可信网络。

## PoC 清单

- poc1-nk-downgrade.mjs —— 纯密码学层 NK 降级 —— PWNED
- poc2-impersonation.mjs —— 真 relay + 真 RelayConnection 冒充 + RPC 注入 —— PWNED
- poc3a-room-squat.mjs —— 确定性房间占座阻断 —— 实锤
- poc3b-room-exhaust.mjs —— 房间池耗尽 + bucket 泄漏 —— 实锤
- poc4-pair-start-hijack.mjs —— 配对抢房 + 设备名伪造 —— SAS 拦截（社会工程面）
- poc5-authorization.mjs —— scopes 旁路源码级验证 —— 实锤
- poc6-replay.mjs —— 重放拷问 —— 会话内 OK
- poc7-live-tap.mjs —— 冒充 + 实时窃听下行流 —— 实锤

验证基线：ac-relay-server 现有 18 测试全过（攻击针对设计缺口，非实现回归）。relay 测试实例 127.0.0.1:18443 已清理。
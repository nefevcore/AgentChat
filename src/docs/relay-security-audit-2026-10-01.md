# 哑中继服务器安全审计报告（第一轮：代码面）

> 审计对象：`src/ac-relay-server/`（RelayCore + ws 传输层 + download-gate 下载面）
> 对照基准：`src/docs/remote-client-relay-plan.md` §2 威胁模型、§4.5 防滥用清单
> 审计日期：2026-10-01 · 纯审计，未改动任何代码
> **修复状态（cr-77，2026-10-01）**：F-1/F-2/F-3/F-4/F-8 已修——F-1 抽 parseGatePath 纯函数统一 400；F-2 房间配额含 everClosed + IPv6 /64 聚合（normalizeIp）+ maxTotalConns 兜底；F-3 所有 op 统一收帧速率桶费；F-4 envNum NaN 防护回退缺省；F-8 quota 单次读盘。F-5 维持现状（RELAY_DEBUG 联调专用）；F-7 维持静默降级（Noise 层兜底的设计裁决）。契约测试已补。

## 审计范围

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/index.ts` | 356 | RelayCore 纯逻辑（房间/限额/清扫） |
| `src/main.ts` | 117 | 传输层适配（ws + TLS + env 配置） |
| `src/download-gate.ts` | 101 | 下载面配额门（127.0.0.1 + Nginx X-Accel） |
| `tests/relay.test.ts` | 285 | 房间生命周期 + 防滥用限额契约测试 |
| `tests/download-gate.test.ts` | 131 | 配额门路径/配额测试 |

## 总体评价

设计哲学兑现度高。「不存储不探测」是结构性实现而非运营承诺：帧 opaque 转发不解析、零持久化、重启失忆、join 失败统一错误码（无存在性回声）。内容安全由 Noise E2E 层承担（TLS 仅为混淆层，文档有明确裁决），中继自身攻击面收敛得当。防滥用限额四重（连接/房间/帧/速率）+ join 频控 + 单房日流量，均有 CR 溯源（cr-43-13/cr-64/cr-70/cr-72）。测试覆盖全部限额契约。

## 做得好的地方（抽查确认）

- 反枚举三件套：room id 128-256 bit 熵正则（L108）、统一 `room-unavailable`、join 频控 30/min——暴力枚举数学与经济学双重不可行；
- TLS 仅前向保密套件 + `honorCipherOrder`（禁静态 RSA 回溯解密，sec-scan 2026-09-16 基线）；
- ws 层 error sink：单连接异常只 terminate 该连接，不带崩进程（M3.2 实测教训已固化）；
- cr-64/70/72 三轮腐化清理：bucket 泄漏、重试振荡器相位耦合、PC 独守误杀——补丁史干净，根因均有归档；
- download-gate 段级穿越判定（`..` 按段，不误伤 `My..App.exe`）+ NUL 检查 + 仅绑 127.0.0.1 + tmp+rename 原子计数。

## 发现（按严重度降序）

### F-1〔低-中〕download-gate：畸形输入可崩进程（DoS）

`download-gate.ts` L51-53 请求处理器顶部三个未捕获抛错点，任一命中即 uncaughtException 崩溃：

1. `decodeURIComponent(url.pathname)` —— `%ZZ` 类非法编码抛 URIError；
2. `new URL(req.url, host)` —— 畸形 Host（如 `Host: [`）或 CONNECT 类请求 req.url 为 undefined 时抛 TypeError，且发生在方法检查之前；
3. X-Accel-Redirect 头值 —— 解码后文本含 `%0d%0a` 解出的 CRLF 触发 ERR_INVALID_CHAR（Node 拦住头注入但以崩溃收场）。

缓解因素：仅绑 127.0.0.1，但 Nginx proxy_pass 原样透传攻击者控制的 URI/Host 字节，公网可达。
建议：处理器顶部 try/catch 统一 400；解码后字符白名单校验再进 sink。

### F-2〔低-中〕everClosed 房间绕过单 IP 占座配额 → 全局房间池可被耗尽

`index.ts` L234-240：maxOpenRoomsPerIp 只统计 peers.length < 2 的房间。攻击路径：同 IP 两连接先后 join 同一房间 → everClosed=true → 第二连接退出 → 剩 1 席房间不再计入 per-IP 配额，靠 ping 保活（cr-72 心跳保活语义）。单 IP 受 30 并发限制只能占约 29 间，但 IPv6 /64 内轮换源地址时 per-IP 桶全部按 /128 独立计，一台机器可刷满 maxRooms=10000 全局池，此后所有合法新建房间被拒。

建议：① per-IP 房间计数含 everClosed 房间；② IPv6 限额键聚合到 /64；③ 加全局总连接上限兜底。

### F-3〔低〕ping 绕过帧速率桶 → 无限 CPU 解析

`index.ts` L270：bucket.take() 仅在 frame 分支收取，ping（及一切 op）先走 L208 JSON.parse——单连接可不限速发 8MB 合法 JSON ping，帧桶全程不触发。非放大攻击（1:1 应答），但 CPU/内存无上界。
建议：onMessage 入口对所有消息统一收桶费。

### F-4〔低〕env 数值无 NaN 防护 → 限额静默失效

`main.ts` L16-19：Number(env) 对垃圾值产出 NaN，比较式 n >= NaN 恒 false → maxConnPerIp 等限额静默禁用。属运维脚枪（需操作者自己设错值），但失效方向是放行而非拒绝。
建议：Number.isFinite 校验，非法值回退缺省或启动时 fail-loud。

### 信息级

- F-5 RELAY_DEBUG=1 打印 room id + IP——内容永不落日志，但与「日志只允许错误码计数」的设计约束（plan §4.5）有张力，生产禁开；
- F-6 文档漂移：plan §4.5 表（5 连接/1MiB 帧/10min join）与代码 DEFAULT_LIMITS（30/8MB/30min burst20）不一致——均有 CR 裁决存档，属合理演进，建议文档标注「以 DEFAULT_LIMITS 为准，历次调整见 CR」；
- F-7 无证书时静默降级明文 ws——Noise 层兜底、TLS 仅混淆，设计上可接受；公网部署形态建议无 cert 即拒绝启动（fail-loud 优于静默降级）；
- F-8 /api/quota 每请求同步读盘两次且无频控——localhost-only 低危，顺手可修（读一次复用）。

## 结论（第一轮）

中继核心安全姿态良好，无内容泄露或注入类漏洞；问题集中在 download-gate 输入健壮性（F-1）与资源耗尽面（F-2/F-3）。F-1 最值得立即修——一个 GET 即可崩掉下载面。

## 第二轮预告

专项：外部攻破中继服务器 → 用户 PC 被入侵的完整链路分析（见同日第二轮报告）。

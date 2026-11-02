# post-office 独立进程预研（router 脱离 host 的裁决档案）

> 性质：**预研分析档案**（未实施）。回答「将 router（邮局服务进程）脱离 host、
> 单独起一个 boot app，会如何」。裁决：**顺序敏感——盘面会合（
> subagent-disk-rendezvous.md）是硬前置**；有底座再拆 = 纯增益的加速器升格，
> 没底座就拆 = 单点搬家、重蹈 47 条 CR 补丁覆辙。三触发线命中再动工。
> 2026-11-02 立（cr-858）。

## §零 拆的对象澄清

router.ts 本身是 79 行纯函数（uuid 校验 + 多播展开 + 查可达表出指令），无可拆。
真正拆的是**邮局服务进程整体**：ipc 服务端、连接池、可达表、uuid 注册表、
outbox flush——把 PostOffice 从「宿主的内脏」升格为「数据根里的独立常驻端点」。

## §一 核心裁决：顺序敏感

### 没有盘面底座就拆（否决形态）

- router 换代（重启/崩溃）→ 可达表蒸发、连接断、flush 停。cr-813 保壳保 run，
  但保不了邮局——信件滞留等 router 复活。
- 恢复矩阵的共同病根（「运行时态收敛回盘上事实没有单一 owner」）原样复发，
  只是从壳↔宿主的缝挪到 router↔宿主的缝，且这次是**两个中心进程之间的缝**，
  比前者更难测。
- 新崩溃窗口成群：双活竞态（宿主换代时旧 router 未死新 router 已起）、启动
  时序（router 晚于第一批投递需求）、registry 蒸发——每个都需要新恢复面对冲。

### 有盘面底座再拆（认可形态）

正确性已在盘面（锁即路由、信箱即兜底、幂等在接收方），router 变成**随时可死、
可换代、可缺席**的加速进程：死了退化「信等人」，活了获得连接池、中继扇出、
集中观测。「host 是加速器」的结论兑现——把加速器里最纯粹的一半（消息面）从
宿主析出单独供养。

## §二 收益（对着项目真实痛点）

| 收益 | 对应的今天痛点 |
|---|---|
| 消息面与宿主换代解耦 | restart_host/宿主崩溃期间投递中断（信落 outbox 等宿主回来 flush）； |
| | 邮局是宿主进程里最后一块「死了会疼」的内脏 |
| 崩溃隔离 | 邮局/投递面 bug 不拖死 webui/admin/编排面；反向亦然 |
| hostless 通信获得活体形态 | 无宿主时 agent 间仍有活体消息中枢（连接复用/扇出/重试）， |
| | 而非纯盘面等待——跨数据根中继（盘面会合 §四.1）的本地雏形 |
| 重启粒度细化 | 改消息面代码只重启 router（秒级、无状态可丢），不动宿主 web/admin 态 |

## §三 代价与化解（逐项）

1. **locals 面重新归属**：user 壳桩今天经 registerLocal 宿主进程内直调（local:
   通道）；router 独立后 user 桩不在 router 进程内。化解：宿主成为 router 的
   ipc 客户端，user 桩消息经 socket 转发——协议层不变（D2），local 直调降为
   ipc，损失可忽略。
2. **uuid 注册表蒸发**：registry 在 router 内存，换代即失。化解 = 读面工程：
   registry 完整事实源 = 全部账本信封 uuid 并集，router boot 扫账本重建
   （一次性，与 R1 恢复面同款 boot 对账）。这是宿主内脏里**最后一个没有盘面
   对应物**的内存态，拆分逼它落账——隐藏收益。
3. **拉起耦合**：ensureHook 跟 router 还是留宿主？裁决：**data plane / control
   plane 彻底分离**——router 只管消息（投递/滞留/扇出），永不拉进程；拉起留
   宿主 poller（扫 outbox/inbox 变化触发，链路已有）。ensureHook「缺钩子不
   阻塞投递」语义已定义好缺位形态，零新语义。
   > **2026-11 修订（supervisor-service-plan §四.2）**：「拉起留宿主 poller」
   > 修订为「拉起归 system 层」——router 生死 owner 上收 supervisor（配方
   > owner 字段；与 host 平级者不由 host 管生死）；宿主 poller 保留 shell
   > 按需拉起（宿主 owns agent 语义）。data/control 分离（router 永不拉进程）
   > 不变。
   >
   > **2026-11-02 落地（cr-859）**：配方盘面已运行（.runtime/recipes/，host
   > resident + shell:on-demand 双写者都在产）——router 并入时只需追加其配方
   > 行（§六 修订的「写一行配方」已具备物理载体）。
4. **发版/重启语义分叉**：宿主重启不再重载消息面代码。化解：同映像（cr-620
   单 exe 哲学）——router 不是新二进制，是 AgentChat.exe --router 的另一个
   argv 形态，与宿主/壳/子壳同映像多进程常态一致，版本漂移结构性消失。
5. **启动时序**：router 可能晚于第一批需求到。化解：壳已有 probePostOffice
   （boot.ts）——probe 失败走直投/盘面；宿主 boot 发现 router 缺席按需拉起
   （复用 adoptShell 同链）。**router 被当成一个「系统壳」供养**：
   activation.lock 单例自持、socket 地址数据根派生（socketPathFor 不变，
   **换进程不换地址**，全部壳与客户端无感）、supervise 监护循环直接套用
   （respawn/熔断白拿）。
   > **2026-11 修订（supervisor-service-plan §一）**：「系统壳」定位修正——
   > router 不是宿主管的壳，是宿主层 infra 对象（与 host 平级、system 直辖）：
   > 监护语义 = 崩溃监护（ac-supervisor-core：42/78/退避/熔断），非 warden
   > 业务监护（idle 收割与 router 无关）；单例锁自持、地址派生、换进程不换
   > 地址三点不变。supervisor 多子化（supervisor-service-plan §五.3，仍未
   > 落地）之前，宿主 boot 按需拉起为过渡冷启动路径——配方盘面（cr-859）
   > 已就位，多子化时 supervisor 扫盘接管即可。
6. **单例竞态**：socket bind 有 OS 仲裁（第二个 bind 即败）+ 活锁双保险，低风险。

## §四 拆后进程图景

```
router   信使：路由、投递、outbox flush、uuid 登记（账本重建）、扇出
host     管家+门面：webui/web-api、编排面（拉起/监护，含 router 本身）、admin、
         插件库、poller
shells   工人：会话状态机 + loop，各持活锁，经盘面或 router 会合
盘面     事实源：锁/信箱/账本/拓扑——任何进程的内存态都是它的投影
```

宿主被剥成纯 control plane + 用户面；三进程角色不再重叠。注意这**不违反「宿主
是进程生命周期唯一 owner」**——router 的生命周期仍归宿主编排面管（拉起/监护/
熔断），只是消息面不再寄宿宿主进程体内：「owner 管生死，信使管送达」。

> **2026-11 修订（supervisor-service-plan §四.2，本文最重的对账）**：router
> 生命周期 owner 再上收——从宿主编排面改归 system 层（supervisor）直辖，四角色：
> supervisor（infra 生死：host/router）/ router（信使）/ host（编排+用户面，
> shells 业务语义监护）/ shells（工人）。「宿主是进程生命周期唯一 owner」收窄为
> 「agent 生命周期的唯一 owner」；「owner 管生死，信使管送达」句式保留，owner 换人。

## §五 触发线（命中再动工）

1. 宿主换代窗口的投递延迟成为真实投诉（restart_host 频繁 + 异步任务回执延迟
   被用户感知）——今天它是「延迟」不是「丢失」，忍得住先忍。
2. hostless/多进程并发通信成为正式产品形态（CLI 直连、多宿主共享数据根）——
   router 是该形态的天然入口。
3. 消息面复杂度继续膨胀（重试策略、背压、跨数据根中继排上日程）——膨胀到
   值得独立进程隔离爆炸半径时。

## §六 工程形态预估

不是「新 boot app」从零写：catalog 加一条 post-office 行 + 同映像 argv 分支 +
registry 账本对账重建 + locals 改 ipc。装配对账测试（catalog↔boot 漂移锁定）
自动覆盖。改动面与一次中型 CR 相当；真正的成本不在代码，在**必须先落盘面会合
底座**（subagent-disk-rendezvous.md §六）——那是本题的先修课。

> **2026-11 修订（supervisor-service-plan §五）**：先修课追加两项——配方盘面
> （.runtime/recipes/）与 supervisor 退出码协议多子化。**配方盘面已落地
> （cr-859，双 supervisor 每代写 host 配方 + 宿主拉壳写 shell 配方）**；
> 退出码多子化仍在触发线上。命中触发线时 router 并入 = 写一行配方
> （owner: system），冷启动随 supervisor 扫盘，无需宿主 boot 特判。

一句话：router 独立不是「脱离 host」的延续，而是「host 已可被脱离」之后的
红利兑现——先证明没有它也行，再把它请出去单独供奉；顺序反了就是重蹈覆辙。

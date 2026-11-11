# webui 独立部署与宿主连接协议（webui-standalone）

> 性质：协议规范——webui 独立部署形态与宿主连接协议（断连降级语义）。
> 状态：**部分被取代**——装载与 wire 面由 [webui-v3.md](webui-v3.md)（cr-923）重造；本文的**独立部署形态与宿主连接协议（断连降级）仍现行**，是部署面的规范源 · cr-912 2026-11-05 成文 · cr-1008 2026-11-11 检阅归位。
> 读者：改 webui 部署 / 宿主连接 / 断连降级的人。

> cr-912（2026-11-05）——开放问题 #3 收口设计（plugin-architecture-v2
> §4.7「webui 独立部署定性」/ §九.3 的后继设计文档）。规范用语同 cr-901：
> **必须 / 禁止 / 仅可** = 强制；裁决条目记录结构性选择理由，偏离须先改本档。
> 前置：ui-plugin-form.md（web 面形态与 webui 基座装配）、ac-ws-protocol
> （帧协议）、ac-web-server（宿主传输基座）、processes.json（进程种类注册表）。

## 一、定性（承 cr-901 §三/§4.7）

webui = **可独立部署的前端产物**：静态文件集（SPA + 通道资产），可由任意
静态服务（含宿主 web-server 自身）托管。宿主缺席或断连 = **降级运行**
（只读快照 + 显式失效面），**禁止**白屏、**禁止**静默假装功能可用。
宿主是唯一事实源：会话/装配/插件状态全部住宿主侧，webui 零权威数据。

与既有链路的边界：remote-link / relay-server 是**壳→宿主**链路（mobile
场景，KK 加密中继），与本协议（**浏览器→宿主**）不混同、不复用传输；
webui 直连宿主 web-server 的 HTTP + WS 面。

## 二、现状基线（同源耦合三处——本协议要拆的面）

1. 静态托管：宿主 web-server `staticDir` 直接托管 SPA（同源部署形态，
   终态仍是合法形态之一——独立部署是**放宽**不是**替换**）。
2. boot-graph 拉取：`fetch('/api/ui/boot-graph')` 相对路径（apps/ui
   client/boot.ts）——隐含同源假设。
3. RPC/事件传输：WS 同源连接（rpc-wire.ts；vite dev 代理 ws://localhost:3830）。

三处均无独立 origin 支持：无宿主地址发现、无跨域 WS、无协议版本协商、
无断连降级语义。协议 = 把这三处从「同源隐式」升为「跨源显式」。

## 三、连接协议

### 3.1 宿主地址发现

**裁决：端点单值注入，不做服务发现**。解析序（前者赢）：

1. URL 参数 `?host=<origin>`（分享链接/调试用——显式、可审计）；
2. localStorage `ac.host`（设置 UI 写入——常规独立部署形态）；
3. 构建期注入 `window.__AC_HOST__`（固定部署点产物）；
4. `location.origin`（同源托管形态——现状行为零变化）。

禁止：mDNS/注册中心式自动发现（体量克制；单宿主形态下无收益面）。

### 3.2 握手与版本协商

**裁决：显式 hello 握手 + 协议轴 semver**。连接前先
`GET <host>/api/ui/hello`：

```json
{
  "protocol": 1,
  "hostVersion": "<app 版本>",
  "engines": { "agentchat": "^2" },
  "surfaces": { "bootGraph": true, "assets": true, "ws": true }
}
```

- `protocol` 轴：major 不匹配 = **fail-loud**（显式版本冲突页——「宿主
  需升级/产物需重建」双向指引，禁止静默半工作）；minor 差异向后兼容。
- hello 亦承担**宿主在场探测**：不可达 = 直接进断连降级态（§3.4），
  不进入「连上看运气」的模糊态。
- 独立部署的 boot-graph / 资产路由请求全部改走 `<host>` 前缀（发现值
  非同源时）；同源值 = 现状相对路径逐字节等价。

### 3.3 传输与鉴权

- RPC/事件传输复用 ac-ws-protocol 帧词汇（rpc/call、rpc/result、
  ws/ack、ws/ready + 事件名直转帧）——**零新帧型**；跨源 WS 由宿主
  allowedOrigins 校验（既有配置面，扩含 webui origin）。
- 鉴权：同源形态沿用现状；跨源形态 = **Bearer token**（宿主设置 UI
  生成、webui 存 localStorage、WS 查询串 + RPC 头携带）。token 撤销
  = 宿主侧重生成（旧 token 次连拒绝）。**禁止**跨站 cookie 依赖
  （第三方站点 cookie 语义不可依赖）。
- CSP：独立部署产物必须自带 CSP 头（静态服务配置项）——通道资产仅
  许从宿主资产路由 `/ui-plugin/:name/*` 加载（统一通道唯一化，cr-474）。

### 3.4 断连降级语义（两轴）

- **连接轴**：live / reconnecting / disconnected。断连即整窗进入
  reconnecting（重连退避复用 relay 先验：1s 起 60s 顶 ±20% 抖动）；
  hello 探测成功才回 live（不赌 WS 恢复）。
- **数据轴**：live 数据 / 本地快照（stale）。boot-graph 与名册最近一次
  成功响应留 localStorage 快照（带时戳）；断连态 UI 渲染快照并**逐面
  标注 stale**，写操作（发消息/改装配）入口禁用并说明原因。
- 审计对齐：快照**仅可**作展示兜底，**禁止**当作装配求值输入——
  webui 装配文档求值恒以宿主 boot-graph 端点为准（ui-plugin-form §四：
  文档是装配意志，目录是物化事实，对账住宿主侧）。

## 四、部署形态与注册表

- 产物：`pnpm webui:build` 产物目录（dist/webui）整体拷走即部署；
  同源托管（现状）与独立 origin 均为合法形态，产物同一份。
- processes.json webui 条目维持声明面（form/surfaces/approval 已就位）；
  独立部署不改注册表——注册表管**进程种类**，不管部署点。
- 宿主配置：allowedOrigins 增列 webui origin（config.json 既有面，
  声明式、无代码）。

## 五、实施切片（后继批——独立可交付，不阻塞 v2.1 主体验收）

1. **切片一**：端点发现四层解析 + hello 握手端点与协议轴 + 非同源
   请求前缀化（同源行为逐字节等价锁定）。
2. **切片二**：Bearer token 鉴权面 + allowedOrigins 跨源 WS 校验。
3. **切片三**：断连降级（连接轴状态机 + boot-graph/名册快照 + stale
   标注 + 写操作禁用）。
4. **切片四**：独立部署文档化（README 部署节）+ CSP 模板。

> **实施注记（cr-917，2026-11-05 切片一落地）**：端点发现四层
> （apps/ui/client/host-endpoint.ts——纯函数面 + 浏览器单例；非法层值
> 忽略落层，显式配置错误不静默顶替同源）+ hello 端点
> （apps/ui/src/webui-row.ts GET /api/ui/hello：protocol 1 +
> hostVersion + engines + surfaces）+ 非同源前缀化全链（boot-graph /
> 通道资产 JS+CSS / 主题包 CSS / isolated iframe / WS URL / auto-reload
> 指纹两源——统一经 hostUrl，同源返回原路径逐字节等价，回归测试锁定）+
> main.ts 跨源握手门（major 不匹配 = 版本冲突页 fail-loud；不可达 =
> warn 继续，降级态随切片三接线）。配套：web-server 跨源 CORS 放行回显
> （allowedOrigins 命中 → ACAO 回显 + OPTIONS 预检 204；serveFileRoute
> vary 合并 Origin 维度）；跨源 WS 的 Origin 校验既有面已覆盖（切片二
> 补 Bearer 鉴权轴）。

每片验收：apps/ui 相关 e2e + webui:typecheck；切片一须附「同源形态
回归零变化」测试。

## 六、开放问题

1. 多宿主切换（一个 webui 产物对多个宿主——localStorage 单值是否
   升清单）：待真实需求，先不做（体量克制）。
2. 断连态下 通道资产（宿主资产路由不可达）是否允许「最后快照资产」
   渲染：倾向禁止（资产 = 代码面，stale 代码执行无审计价值）——
   随切片三定。
3. hello 端点是否合并进 boot-graph（省一次往返）：倾向独立——握手
   语义（版本/在场）与装配语义（行集）分属两层，合并 = 断连态无法
   区分「宿主缺席」与「装配损坏」。

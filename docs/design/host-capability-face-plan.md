// 目标读者：实现本方案的人/Agent。事实源：本文件 + packages/ac-host-face/ 与
// packages/ac-host-face-client/ 包源码。

# 宿主能力面 host-capability-face（cr-886，2026-11-04）

> 前置：cr-881 system prompt 去中心化（段注册制）。用户裁决：双闸（壳门禁管可见性 +
> 宿主执行面复查越权兜底）；失效帧（boot 一次性 discover + 宿主侧变更 push 失效，壳重拉）。

## 1. 问题与方案

跨进程提供提示词与工具调用：宿主持有 facts（singles/group 注册表）、跨 Agent 投递仲裁、
timer 排程——壳进程内的段 provider 与 LLM 工具面够不着。方案 B（ipc 契约面）：宿主声明能力，
壳 boot 时 discover、按契约装配本地代理（MCP 同构：宿主 = server，壳 = client）。

否决项（防翻案）：A 信封注入（信封纯转发零会话态红线）；C web RPC 复用（UI 语义/授权模型
错位）；E spawn 快照（快照即陈旧，保留 cr-758 既有场景）。

## 2. 归属裁决（68 工具全量评估）

| 归宿 | 工具 | 依据 |
|---|---|---|
| 宿主 | timer（新建工具面）+ update_agent_profile（注册表写口收敛）+ list_agents/list_groups/read_agent_info（读面 → facts 投影，无代理） | 排程唤醒在宿主；agents 树 owning 写者在宿主编辑面 |
| 壳（不动） | send_agent/send_group/list_tools | 执行面深度耦合壳服务（subagents 会话机/session 回放/对桶状态机）——跨壳投递仲裁**已经**宿主化（邮局 ipc 路由），搬宿主 = 拆散挂起闭环 + 丢子投递面，纯损耗 |
| 壳 | 其余 60（fs/shell/web/math/run_code/memory/goal/todo/ask/session-query/sap-adt×32/harness/issue/subagent/plugin-dev/restart/skill） | 本地资源执行面/盘上数据面/已是宿主契约（plugin-dev·restart 信封模式保留） |

## 3. 契约（HostFaceContract）

- 帧协议：复用 ac-envelope-core ipc（长度前缀 JSON；socketPathFor(dataRoot, 'host-face')）。
- discover 帧响应完整契约；invalidate 帧单向通知（壳收到后重拉 discover）。
- tools 携带完整注册参数（name/description/parameters/requiredTags/needPermission）。
- sections 只引用具名段位（SECTION_ORDER 键名），不携带数值——位次单源住壳 sections.ts。
- facts：singles.get(conversationId)、group.get(gid)——投影为壳内 Shim 服务（ctx.get 消费口不变）。

## 4. 双闸

壳闸 = 代理工具注册面正常 requiredTags 门禁（可见性）；宿主闸 = host-face execute 帧处理内
重走 tags/档位判定（sessionCapsOf 同源）——越权拒绝，错误信息回执。

## 5. 异步语义

send_agent wait=true 与回执流不进契约帧（request-response 只承诺快操作）：受理即返，
回复迟到作为新消息经既有信封通道到达——契约面只搬执行请求，不重造回复流。

## 7. 实施教训（cr-886 落地记录）

- **fiber 域是同步作用域**：promise.then 回调脱离 fiber 域——域外 ctx.tools.register
  挂死（不抛错、pending 永悬）。两段式装配：异步链只拉契约暂存 staged，注册在
  before-run 回调同步段应用。
- **register 要求 tools 域在场**：未 inject ['tools'] 的行在 apply/回调内
  ctx.tools.register 同样挂死——inject 声明即依赖，跨 fiber 注册不是免费动作。
- **listenIpc 的 effect 语义**：then 链里 return close() 会立即关停——close 必须
  只发生在 dispose 函数内。

## 6. 实施序

契约纯库 → 宿主行（facts → timer 工具 → collab 搬家 → 远程段）→ 壳 client 行（discover/
代理/Shim/远程段/失效帧）→ 壳 collab 工具面退役 → catalog 双树 → 验证阶梯。
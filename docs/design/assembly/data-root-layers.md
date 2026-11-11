# 数据根分层契约（data-root-layers）

> 性质：规约——数据根顶层布局的裁决面（分层原则、顶层分类表、操作规则、兼容窗纪律）。
> 状态：现行 · 2026-11-07 立（上游事故与决策过程见
> [data-root-layering-handoff.md](../archive/assembly/data-root-layering-handoff.md)）；
> cr-1008 2026-11-11 批1 检阅：viewer 语义按 cr-973/cr-998 更新（物化账本退役、投影树物理删除）。
> 读者：新增数据域的写者（要么进本契约、要么住 meta/）、做数据根备份/清理操作的人。
> 机器面：boot doctor（ac-host-rows data-root-audit `auditDataRootLayers`）——顶层未知项 warn。

## 一、分层原则

按「丢了能不能重建」分三层，操作规则只由耐久性轴决定：

| 层 | 判据 | 处置 |
|---|---|---|
| 第一层 真值 | 消息、运行记录——丢了不可重建 | 必须备份 |
| 第二层 属性 | 用户域源数据——小而珍贵、不可重建 | 必须备份 |
| 第三层 投影 | 纯派生 | 整树可删、boot 自愈 |

事故本质：第二层（session.json）寄生在第三层目录里，「清投影」连源数据
一起清了。对照组：conv-settings/ 住在投影树外，1123 项毫发无损。

## 二、顶层分类表

| 顶层项 | 层 | 说明 |
|---|---|---|
| `agents/` | 第一层 | 真值账本（消息/运行记录/entries）——必须备份 |
| `meta/` | 第二层 | 用户域源数据（见下节）——必须备份 |
| `credentials/` | 第二层（特殊成员） | 加密凭据——独立隔离，备份策略不同 |
| `viewer/` | 第三层（历史） | ~~纯投影树~~——cr-973 物化账本退役（终稿层改 ac-ledger 读时投影 projectUserReplay）、cr-998 存量迁移归零后**整树物理删除**；此行仅存档认知（root README 数据根段同口径：viewer/sessions 为历史投影存量树、读面退役可整删） |
| `usage/` | 派生流水 | 半可重建（从账本重放近似恢复） |
| `files/` `file-snapshots/` `sap-adt/` | 第一层附件 | 工作产物——必须备份 |
| `profile/` | 装配文档 | 生成物 + 用户编辑件（webui-custom.patch.yml 等——迁 meta/profile 后只剩生成物） |
| `outbox/` | durable 队列 | **勿清！**在途 run（名字像运行态，实为持久队列） |
| `.runtime/` | 运行态 | 随时可丢 |
| `plugins/` `skills/` | 能力目录 | UI 插件 / 技能直读面 |
| `config.json` | 全局配置 | 留根级 |
| `host-rows.json` | 行集偏好 | 宿主行集派生输入 |

### meta/ 内部（第二层主存储）

| 路径 | 内容 | 迁入自 |
|---|---|---|
| `meta/sessions/<sid>.json` | 独立会话元数据（agentId/title/workspaceId/status） | viewer/sessions/<sid>/session.json |
| `meta/conv-settings/<id>.json` | 会话级覆盖（model/toolMode/…，D12 单源） | conv-settings/ |
| `meta/groups/<gid>/group.json` | 群成员表 | groups/ |
| `meta/timer/state.json` | 定时排程状态（停机补偿依据） | timer/state.json |
| `meta/remote/` | 配对身份/设备绑定（删了静默丢功能——配对失联） | remote/ |
| `meta/workspaces.json` | 工作区登记表 | workspaces.json |

**主存储形态 = 每会话/每域单文件**（conv-settings 模式）：单文件原子写、
坏一个丢一个、可 grep。单文件 JSON 清单被否——单点爆炸半径是本次事故
复刻。conv-settings 不合并文件、只统一父目录（保持单写者 D12 纪律，
生命周期不同步反而是优点）。

## 三、三条操作规则（boot doctor 校验依据）

1. **可整树删**：只有 `viewer/` 和 `.runtime/`；
2. **必须备份**：`agents/`、`meta/`、`credentials/`、`files/`、
   `file-snapshots/`、`sap-adt/`、`outbox/`；
3. **删了静默丢功能**：`outbox/`（在途 run）、`credentials/`、
   `meta/remote/`（配对失联）、`meta/timer/state.json`（停机补偿错乱）。

## 四、兼容窗（迁居期纪律）

迁居项一律**读旧写新**：读侧回落旧位置、写侧恒新位置、旧文件不物理
迁移（等版本后清理）。当前兼容窗旧位置（doctor 认知、不告警）：

- `viewer/sessions/<sid>/session.json` → `meta/sessions/<sid>.json`
- `conv-settings/` → `meta/conv-settings/`
- `groups/` → `meta/groups/`
- `timer/state.json` → `meta/timer/state.json`
- `remote/` → `meta/remote/`（单写者原子文件，boot 期一次性 rename 迁移）
- `workspaces.json` → `meta/workspaces.json`

例外语义：conv-settings 清空删键时**双位置一并清**（只清新位置会让旧
文件复活旧值）；singles delete 摘除双位置元数据。

## 五、boot 自愈与哨兵

- **投影对账自愈（历史形态，cr-973 演进）**：原设计 = 宿主 boot 跑一次
  `projectUserLedgers`（幂等只补缺席）——cr-973 起 viewer 物化账本整体退役，
  user 终稿层改为 ac-ledger **读时投影**（projectUserReplay），投影树不再是
  持久实体，自愈面随之消失（cr-998 存量迁移归零后 viewer/ 已物理删除）。
- **分层 doctor**：boot 扫顶层，未知目录/文件 warn（
  `auditDataRootLayers`，ac-host-rows）。新数据域要么进本契约，要么
  住进 `meta/`。

## 六、未来升级路径（未排期）

- 账本 header 下沉创建时不可变事实（初始 agentId / 创建时间 / 创建时
  workspaceId）——格式演进，需兼容旧 header；
- localStorage 草稿正文迁服务端第二层（agentchat.pendingSingle /
  drafts / lastContext / theme 是隐藏的同风险层——清浏览器数据即丢）。

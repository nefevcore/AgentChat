# ac-sap-adt — SAP ABAP ADT 工具行

AgentChat 的 **SAP ABAP 开发工具面**：46 个 `adt_*` 工具直连 SAP ADT REST 协议
（`/sap/bc/adt`，不依赖任何 SAP 闭源库），覆盖完整开发闭环
*搜索 → 读 → 改 → 激活 → 单测 → ATC → 传输 → 执行 → 调试 → 错误分析*，
外加代理尺度能力（协议级 `$batch`、整包发布门禁、DDIC 结构化编辑器、
一步建表、冲突检查本地快照、源码导出、离线 abaplint、co-change 分析）
与对话式建连接（从本机 SAP GUI 连接列表导入）。

## 引擎与单一事实源

引擎 = npm 包 [`@nefevcore/abap-adt-core`](https://github.com/nefevcore/dsh-adt)
（纯内核）——同一份代码同时服务 DeepSeek Harness 适配层（`abap-adt-dsh-plugin`）
与本行（源仓库 290 项测试锁定全部行为：策略/OCC 快照/$batch/调试器/quirk 回归）。
本行只做宿主适配（工具形状归一、能力门禁、fs/credentials/config 三缝），
**不含任何业务逻辑**——升级内核即升级两宿主。

## 启用方式

工具带 `requiredTags: ['sap-adt']` 门禁——只有 `tags` 里显式加了
`sap-adt` 的 Agent 可见/可调用（对齐 DSH 侧"默认不加载、按会话启用"的哲学；
未授权 Agent 的工具列表不会被 46 个工具淹没）：

```json
// <数据根>/agents/<id>/config.json
{
  "agent_id": "abap_dev",
  "name": "ABAP 开发",
  "tags": ["sap-adt"]
}
```

**demo 目的地默认开启**（进程内 mock ADT 服务器，零 SAP 系统端到端可用）。
直接对 Agent 说：`列出 ADT 目的地 → 搜索 ZCL_DEMO → 读取 → 修改 → 激活 → 跑单测`。

## 启停（settings['sap-adt'].enabled，热生效）

| 层 | 键 | 语义 |
|---|---|---|
| 行 config | `enabled: false` | 进程级硬停（boot 不注册工具；改后重载行生效） |
| 全局默认层 | `settings.sap-adt.enabled`（config.json，插件库弹窗） | 软停用：adt_* 从停用方暴露面移除 + 执行 veto；`config/changed` 热生效 |
| Agent 差异层 | `settings['sap-adt'].enabled`（Agent 页弹窗） | 覆盖全局层（`settingsOf` 合成——`true` 可在全局停用下单独放行本 Agent） |

## 引擎配置分层（热生效）

```
① 行 config（cordis.yml `sap-adt` 行 / bootTree）
② config.json 顶层 `sap-adt:` 段（引擎域：destinations/configFile/policy——
   进程级，非弹窗面；与 settings 域分工）
③ 显式 configFile（团队共享 YAML；相对路径锚定 AgentChat 数据根）
④ 工作区层（最近层——对话式 adt_create_destination 写这里；目录随宿主
   档案声明，AgentChat 不复用 DSH 的 .dsh-abap-adt）。**按调用方隔离**：
   Agent 调用 → <数据根>/.ac-sap-adt/agents/<agentId>/destinations.yaml
   （各 Agent 独立目的地表，互不可见）；宿主直调（无身份）→
   <数据根>/.ac-sap-adt/destinations.yaml
⑤ SAP_* 环境变量（仅权限开关，且仅在 ①-④ 均未设置时）
```

`config/changed` 事件热重载目的地表与策略（无需重启）。密码走
`passwordEnv` 引用（如 `ADT_DEV_PASSWORD`）：对话里直接告诉 Agent，
`adt_create_destination` 会存进 ac-credentials 全局级凭据（AES-GCM 加密），
配置文件只留引用。

```jsonc
// config.json 示例（`sap-adt:` 段）
{
  "sap-adt": {
    "demo": true,
    "defaultDestination": "dev",
    "destinations": [
      {
        "name": "dev",
        "url": "https://sap.example.com:44301",
        "client": "100",
        "username": "DEVELOPER",
        "passwordEnv": "ADT_DEV_PASSWORD",
        "strictSSL": false
      }
    ]
  }
}
```

## 宿主适配细节

| 缝 | 实现 |
|---|---|
| 工具注册 | 引擎 `DefinedTool`（参数已是标准 JSON Schema）→ `{name, description, parameters, requiredTags, execute}`；执行返回值经 `deepCompact` 去 `undefined` 后归一 `{ok, output}` / `{ok:false, error}` |
| 执行上下文 | `call.signal` → 引擎 `exec.signal`；`exec.agent.session.header.cwd` = `<数据根>/sap-adt`（工作区层锚点） |
| fs | `SapAdtFs`：node:fs 适配器，全部路径圈定 `<数据根>/sap-adt/`（快照 `.adt-snapshots/`、导出、abaplint 本地检查；越界即拒绝） |
| credentials | ac-credentials 全局级 ↔ 引擎密码引用词汇（`ADT_<NAME>_PASSWORD`） |
| 配置 | 行 config < `config.json` `sap-adt:` < configFile；`config/changed` 热重载；init 失败不拖垮宿主（无工具 + 日志，配置修复后热恢复） |
| 回收 | `ctx.effect` 反注册：调试会话 detach + mock 服务器关闭 |

写侧治理（per-destination policy 11 开关、dev/qa/prd 环境分级——prd 硬拒
执行/批量写/调试器、读侧敏感表黑名单）全部随引擎，`adt_permissions` 可查
每个目的地的生效策略。

# Agent 数据文档（cr-1004，2026-11-11）

> 状态：**已实施**（cr-1004 批2/批2b——agent.json 档案 + origin 块 +
> agent.patch.yml 差量化 + levels 归位装配条目 config 已落地，migrate v2
> 档收口存量）。本文讲 **Agent 身份与数据**：
> 装配之外的 everything else——档案、人设、各插件单元数据、积累性状态。
> 装配切面（assembly.patch.yml 的合成代数）见 `agent-assembly.md`；
> 本文只消费其结果、不管它怎么合成。

## 一、身份模型与分家

```
Agent = 装配切面（assembly.patch.yml → agent-assembly.md）
      + 数据（本文档：档案 + 插件单元 + 积累性状态）
```

- 身份 = 跨会话连续性：agents/<id>/ 是持久地址（记忆、锁、点对点投递锚）；
- 分家判据：**改变装什么/怎么配 → 装配；改变行为参数/展示/积累 → 数据**；
- 装配代数不知 Agent（单向依赖）；本文档的写者治理负责装配文档的存放与
  写权限（身份层事实）。

## 二、目录布局（agents/<id>/）

```
agents/<id>/
  agent.patch.yml        # 装配切面（名字沿用——差量文档，内容只剩装配；agent-assembly.md）
  agent.json            # 档案数据（§三）
  AGENTS.md             # 人设文档（裸名入口——persona 消费）
  persona.json          # 人设单元数据（persona 行消费）
  <unit>.json           # 插件配置单元（§四：mcp/goal/memory/… 各自单元）
  sessions/             # 会话账本（§五）
  memory/               # 记忆时间线（§五）
  files/                # Agent 文件沙箱基准
  entries/              # 条目数据
  children/             # 子壳域（影子形态）
  interactions.jsonl    # 在途交互追加账
  activation.lock       # 单壳互斥锁
```

## 三、档案数据（agent.json）

单文件承载**框架解释**的 Agent 档案（替换 agent.patch.yml 的非装配字段）：

| 域 | 字段 |
|---|---|
| 模型路由 | model / provider / llm-params / max-steps |
| 授权档 | tier（base/sandbox/full-access）/ tool-mode |
| 展示 | name / description / virtual |
| 模板溯源 | **origin**（template + hash + configHash + docs/skills 逐名指纹——从 agent.patch.yml 迁入全量块） |

**origin 与 rebase 策略住这层**（装配文档只带 base 指纹）：模板升级时由
origin 对账决定是否对 assembly.patch.yml 触发 rebase（agent-assembly.md §五
的调用方）；docs/skills 指纹继续服务 copy-on-write 升级判定。

## 四、插件单元数据（<unit>.json 机制——cr-906 切片二已落）

机制单源：**各插件自定自读**——框架不解释内容；单元文件赢、装配文档内联
为窗口兜底；单元名 param-case、锁保留字（config/auth/agent.patch/preset-origin）；
读写经 ac-agents-core readPluginConfig/writePluginConfig（原子写）。

各插件的数据形态（独立小节，随插件演进各自维护）：

### persona（人设）

- `persona.json`（单元）赢；装配 settings 内联 `{ text?, file? }` 兜底；
- `file` 词形：**裸文件名（如 AGENTS.md）→ Agent 目录内文档**；路径 → 文件系统；
  file 优先 text 回退（cr-912 裁决：现机制全覆盖，零码改收口）。

### mcp（服务器清单）

- `mcp.json`（缺省清单文件）：`{ servers: [...] }` 或裸数组——**文件存在即
  整体替换行基线**（cordis.yml mcp 行 config），改动下一 run 热生效；
- Agent 差异层 = 指向自己的清单文件即覆盖（可含池外服务器，run 时动态建连）；
  暴露面按生效清单收敛（非 MCP 工具不动）。

### goal / todo

- 会话桶状态（conversationId 寻址），住会话域非 Agent 域——列此仅为单元清单
  完整性；数据形态见各 owning 行。

### memory

- `memory/` 时间线目录（结构化条目——宿主铸造头，fs 裸写不承载）；
  工具面 memory_write / memory_grep。

> 新插件指南：需要 per-Agent 可编辑配置 → 声明单元名，走 <unit>.json；
> 需要积累性状态 → 自建目录（append-only 语义），勿混入配置单元。

## 五、积累性状态（非配置——不可重写面）

| 域 | 形态 | 说明 |
|---|---|---|
| sessions/<uuid>/ | 账本 messages.jsonl + inbox + journal | conversationId 寻址；ledger 行 owning |
| entries/ | 条目数据 | |
| interactions.jsonl | 追加账 | 在途交互 |
| children/ | 子壳域 | 影子形态嵌套 |
| memory/ | 时间线 | §四 |

这些是**事实记录**而非偏好声明：不参与文档合成、无「编辑」语义（归档/截断
走 owning 行的显式操作面）。判据：配置可以「改了就换」，事实只能「追加与
收束」。

## 六、写者治理（单一写者原则）

| 文档/域 | 写者 |
|---|---|
| assembly.patch.yml | 编辑面 / 创建流（preset 物化）/ rebase 策略 |
| agent.json | 编辑面 / update_agent_profile |
| <unit>.json | 各 owning 插件 + 编辑面 |
| AGENTS.md / 人设文档 | 用户 / persona 行操作面 |
| 积累性状态 | owning 行独占（ledger/persona/memory…） |

## 七、迁移注记（随 cr-1004 实施批）

agent.patch.yml 拆分三向：rows → agent.patch.yml 差量化（含 base 指纹）；
档案字段 → agent.json（origin 全量块随迁）；levels → 装配条目 config。
确定性转换、幂等可逆，migrate 脚本一档（与 agent-assembly.md §七 同批；
基座/登记改名 `<base>.patch.yml`→`<base>.yml`、`installed.patch.yml`→`installed.yml` 同批顺带）。

# preview 轨规范 —— 壳模型新架构（spec）

> 性质：preview 轨的规范文档（需求边界 + 核心断言 + 验收纪律）。事实源住
> `src/docs/`：本文只内联承重断言，不整段复述——与档案冲突时**以档案为准**，
> 本文负责回链。立项：cr-488；本文：cr-489（2026-10-17）。

# 1. 需求与产物形态

- **产物**：壳模型新架构完整实现（宿主树 48 行 + 壳树 36 行 + 纯库 6 + boot 编排骨架——35→34 为 dev-tools 勘误剔除 cr-520；47→46 / 34→35 为 session-query 改树入壳 cr-544；46→45 / 35→36 为 archive 改树入壳 cr-546〔D11 全壳内——宿主数据服务组移壳域服务组〕；36→37 / 81→82 为 plugin-dev 全新增〔creator 模板装卸三件套，cr-553〕；45→46 / 37→36 为 conv-settings 改树入宿主〔会话覆盖写权 = 用户动作面；壳侧只读垫片，cr-565〕；82→83 为 singles 全新增〔独立会话元数据面，cr-566〕；83→84 为 group 全新增〔群存储行：groups/<gid>/group.json 成员表 + group/* 九 RPC + 信封扇出 + 成员流合并读面，cr-576〕），
  旁路重建于 `preview/`，稳定后 cutover 覆盖主线（R-10 裁决形态：开发期零兼容、主线
  原样保留 = 终极回滚、迁移责任由 cutover 导入脚本一次性吸收）。
- **不变需求**（现状即正确的，分毫不动）：模型会话 / ReAct 编排 / 工具面 / 记忆人格 /
  定时唤醒 / 群聊 / webui 功能面——重构架构不改产品功能；行集按新架构自由重排
  （重构期不保持旧行集兼容）。
- **架构需求**（问题驱动）：故障隔离（一处 native crash 不再全宿主陪葬）、activation
  单例（同一 agent 恒一个执行实例）、授权数据面化（装载即信任 + 授权窄投影）、账本
  per-agent（视角主义 + 投影分层）、宿主变纯（邮局 + 监护 + webui + 授权写者）。

# 2. 核心断言（承重裁决内联——细目以档案为准）

| # | 断言 | 出处 |
|---|---|---|
| A1 | cell ≡ CLI 壳：两档案同一实体两视角；控制面退位（非补充） | shell-model S0（2026-10-17 裁决） |
| A2 | 壳恒为进程，从第一天起（无过渡态、无双轨、无宿主内子树）；壳:activation = 1:1 | shell-model P2①⑤（M4+M5） |
| A3 | activation = 逻辑单例（锁辖域恒 agent 级，跨壳跨形态同一把）；无 runtime 字段，选址 = 拉起方 × 授权宽度；迁移 = 放锁→取锁 | shell-model P2② |
| A4 | 影子 = 派生身份的新 agent（R-5 机制），非第二激活，各自单例 | shell-model P2③ |
| A5 | 账本身份键恒端点（agent）；壳 = 临时容器与写者执行体——壳不拥有账本、壳死账本在 | shell-model P2④（D4） |
| A6 | 投递原语恒一：信封（uuid/requestId/sender/to/kind/budget）为一切投递的统一载体；requestId 幂等、落账即确认、user 是预算之源 | 协议规格 A |
| A7 | 授权宽度 = 参数非角色：装载 = 授权动作（进信任域），无沙箱角色、无专用硬化协议层 | shell-model S3（M6） |
| A8 | 门禁链数据化：ac-security / plugin-gates / durable-interaction / usage / credentials 执行面由数据根 boot | per-agent D3 修订（M1 最大前置） |
| A9 | 行集派生全域单一：宿主 = 偏好文件→ac-rowset-core 派生；壳 = argv 清单引用；cordis.patch.yml / 热通道 / tag 词全链退役 | 行集清单 R3.2 + 裁决簿〈patch 退役〉〈tag 解体〉 |
| A10 | 声明面 = 行集引用（工具点名 ∨ 行名）；插壳即授权、拔壳即断权 | 裁决簿〈tag 机制解体〉 |
| A11 | 指纹主体 = boot 单元，Merkle 为体 git 为饰，两侧同算法（ac-fingerprint-core） | R-7 |
| A12 | 快照链：判定分层 + 事件触发 + GFS 分代；自进化不要求每次变更全量快照 | R-8 |
| A13 | timer / jobs 归属：壳内禀定时 unref 本地原语；持久唤醒恒宿主投递信；壳 job 完成直投本壳 inbox，跨壳走邮局 | 裁决簿〈timer 归属〉〈jobs 归属〉 |
| A14 | 门 = 工具调用 waterfall，每 run 前重读授权投影现算（非缓存） | ac-auth-core 判例 + A8 |

# 3. 事实源映射（本文档族之外的唯一权威）

| 主题 | 事实源 |
|---|---|
| 对象模型 / 监护 / 重启阶梯 | src/docs/shell-model-unification.md |
| 裁决链 R-1…R-12 / D1–D10 / D9 落地路径 | src/docs/per-agent-instance-architecture.md |
| 信封 schema / 锁 / 监护三节拍 | src/docs/protocol-spec-envelope-lock-guardian.md |
| 授权注册表 schema / 投影算法 | src/docs/auth-registry-data-format.md |
| 行集 47+35 / 纯库清单 / boot 编排 / 归并退役 | src/docs/host-shell-row-manifest.md |
| 行集定向论据 / 判例 | src/docs/host-shell-decisions.md |
| ui 树三树同构 / 骨架=协议持有者 | src/docs/ui-tree.md |

# 3.1 动手前值得重读的三个推演结论（防走样）

1. **每 activation 独占进程的内存代价被显式接受**（~50–80MB/活跃 agent，cell 档案实测）——不要在实现期以「省内存」为由重新引入共进程形态。
2. **过渡态不存在**（M5）：不要为「先跑通再说」实现宿主内子树或双 transport——终态从第一天起就是进程 + 单协议。
3. **承重件清单形态被否决**（D6）：不要成文「禁区清单」——守护机制 = 快照链两原子（快照点 = last known good + 回退通道物理外置）。

# 4. 验收纪律

- 每行交付 = 行集表回写 + 契约归位（服务/事件/纯库词汇）+ 定向测试 + 自查六问；
- 插槽-插头验收：摘一行 = 摘一个能力域，依赖方按明确定义降级，不搞坏系统；
- 级联验收（里程碑收口）：boot 两树 → 锁互斥 → 跨进程投递 → 药丸形端到端 → RSI 影子闭环 → cutover。

# 5. 红线（本轨全承）

cordis 三红线（跨行 import 实例 / 手动编排激活顺序 / 跨插件传引用）；Node 原生 TS
strip-only 加载器兼容（显式 .ts / 无类参数属性 / import type）；数据根隔离（preview
数据根恒 preview/sandbox/，绝不共用主线）；日期与 CR 纪律（真实日历日 + 动手前登记）。

## 变更登记

- cr-489（2026-10-17）：立稿。

# M19 规划：user 去特殊化——全对键桶模型（user = 虚拟 Agent 之一）

> 状态：**✅ 已落地（2026-08-26）**。落地记录见 `preview/README.md` M19 条目。
>
> **裁决结果**（与本文推荐的三处偏离，以用户拍板为准）：
> - **D1**：采用备选——`sender` 改为 **string 端点 id**，新增
>   `source: 'user'|'agent'|'event'` 拓扑词（全库改名，语义最净）。
> - **D2**：全局定时条目**不走 system 伪端点**，与个人自触发统一归
>   Agent 自会话桶 `pairKey(agent, agent)`（对角线）；job-wakeup 同规。
> - **D3**：按推荐——ac-web-api 边界显式算对键（`VIEWER_AGENT_ID`
>   单点声明；服务层不猜 viewer，前端直答透传）。
> - **D4**：**彻底统一为 `pair:`**（废 direct: 分区；直答 = 含 viewer
>   的可写对桶，agent 列表交互经 `directDialog()` viewer 相对糖保留）。
> - **D5**：preview 存量数据清空（备份 `data.bak-m19/`），升级
>   `scripts/migrate-workspace.ts` 从 src 轨道 `workspace/default` 重迁移
>   （对键桶 + 说话人 name + steps 工具对重建 + usage 对键流水）。
>
> 背景（用户原话的规约化）：**user = 虚拟 Agent = Agent 的一个类别**。
> 考虑后续允许多个虚拟 Agent，不应在桶/路由/统计任何一层特殊化。
> `direct:<agentId>` 本质是 `pair:user|<agentId>`。

---

## 1. 目标模型（一句话）

**一切双端会话都是对桶**：`conversationId = pairKey(a, b)`（两端排序
`~` 连接；自会话 = `a~a`）。user 只是其中一个端点 id，不占任何专属
代码路径。桶形态收敛为三种，全系统一套规则：

| 桶形态 | 键 | 构造方 | 分区（前端） |
|---|---|---|---|
| 双端对桶 | `a~b`（排序；含 `a~a` 自会话） | `pairKey(sender, target)` | 含 viewer → direct（交互视图）；不含 → pair（只读矩阵视图） |
| 群 | `gid` | group.create/post | `group:<gid>` |
| 独立会话 | `sid` | singles.create | `single:<sid>` |

singles/groups 靠各自名册消歧（前端 `chatPresence.knownSingles/
knownGroups` 既有机制）；对桶含 `~` 天然可辨，无需名册。

### 1.1 信封增强（硬前提）

"不特殊化 user"的前提是系统知道**每条消息是哪个端点发的**。现状
`LoopSender`（'user'|'agent'|'event'）是拓扑词，不携带身份——这是
"委托方身份缺失"（M18 已记录）的同源缺陷。调整：

```
LoopRunRequest / RouterSendOptions / ConversationDeliverOptions:
  sender:   'user' | 'agent' | 'event'   // 拓扑类（保留：ws-bridge 过滤
                                         // / MAX_AUTO_WAKES / session 事件行
                                         // 三个消费方依赖它，不可砍）
  senderId?: string                       // 发送方端点 id（新增）：
                                         // 用户直答 = viewer 虚拟 Agent id；
                                         // 委托 = 发起 Agent id；
                                         // 机制触发 = 'system'（推荐，见 D2）
```

- `sender` 回落规则不变（缺省 'user'）；`senderId` 缺省按 `sender`
  推导（'user'→viewer id、'agent'→未知[历史兼容]、'event'→'system'）。
- 事件载荷同步加位：`router/message-received` / `reply-completed` /
  `conversation/steered` / `loop/step-started` envelope 的 args 追加
  senderId（放末尾，向后兼容）。

### 1.2 对键构造与 id 约束

- `pairKey(a, b): string`（`[a,b].sort().join('~')`）住 **ac-agent-loop**
  并导出（该包已拥有 `runAddress` 与信封契约，conversationId 词汇归它）。
  ac-collab-tools 现有内联 `[from,to].sort().join('~')` 改调它。
- **Agent id 禁 `~` 从建议升级为承重墙**：id 含 `~` 会使 1v1 桶与对桶
  撞键。落点：`ctx.agents.register` 抛错 + ac-agent-admin sanitize 白名单
  校验 + ac-singles/ac-group create 校验（sid 是 uuid、gid 是 `g-*` 前缀，
  顺带覆盖）。`assertConversationId`（ac-session）已禁 `/` `\` `..`。

---

## 2. 特判清单（现状 → 目标）

动工时逐行核对，改完本表应全部清零：

| # | 位置 | 现状（特判） | 目标 |
|---|---|---|---|
| 1 | ac-conversation.deliver | `conversationId ?? agentId` | 缺省 = `pairKey(senderId ?? 'user', agentId)`；群/独立/机制路径本就显式传键 |
| 2 | ac-router.send | 同上缺省 | 同上（或保持透传，缺省只落 conversation 一处——见 D3） |
| 3 | ac-web-api conversation/deliver | 前端不传 conversationId 时透传缺省 | 直答路径显式算 `pairKey(VIEWER, agentId)` 传入（后端不猜 viewer） |
| 4 | webui stores/chat.ts deliver | 仅 single 传 conversationId | 直答也传对键（与 #3 二选一，见 D3） |
| 5 | ac-collab-tools send_agent 虚拟端点分支 | 专属代码：`conversationId = from` 复用发送方 1v1 桶 | **删除**。统一 `pairKey(from, to)`——to 是虚拟 Agent 时天然落 viewer 对桶（同桶！），仅剩"无回复"提示语按 `target.virtual` 生成 |
| 6 | ac-session message-received | `agentId==='user' && sender==='agent'` → 记桶主 assistant | **删除**。对桶统一：入站记 `role:user` + `name=senderId`（说话人），回复记 `role:assistant` + `name=回复方`——与群桶现行 name 标注规则完全同构 |
| 7 | ac-usage byPair | `conv===agent → {a:'user',b:agent}` 特判 | **删除**。对桶统一解析 `split('~')`；user 只是端点之一 |
| 8 | ac-system-prompt 对话信息 | sender 拓扑词 → 硬编码文案（"user - 用户"/"另一 Agent"） | `labelOf(senderId)`：`[当前对话对象] user - 风栗` / `writer - 写作助手`——委托方身份缺失顺带修复 |
| 9 | ac-timer 全局条目触发 | `conversationId = target`（agentId 桶） | `pairKey('system', target)` → 矩阵 system 轴（对齐 src 无主触发端点语义；个人自触发 `a~a` 对角线不变） |
| 10 | chat-ops routeDialog | `conv === agent` 才进 direct（M18 刚修） | 对桶统一：含 viewer → `direct:<另一端>`；不含 → `pair:a\|b`；sid/gid 名照旧 |
| 11 | runs.ts toRunsSnapshot | "无 `~` 且是 Agent → user 对" + running `conv===agentId→chat` | 对桶统一进 pairs；running 按"含 `~` → chat"分类 |
| 12 | runs.ts convKeyToId | `chat~` 前缀剥 user 特判 | 对键双向保留（M18 已改对的部分保留） |
| 13 | 前端 DialogId `direct:` vs `pair:` | 同一对话两种分区键（二象性） | 见 D4：direct 保留为"含 viewer 对桶"的 viewer 相对糖，路由统一按桶 |
| 14 | feed.ts message-received 处理 | `agentId !== 'user'` 早退 + from 推导 | 统一走 routeDialog（#10 改对后自然成立） |
| 15 | TokenUsage 弦图 user 过滤 | `a!=='user' && b!=='user'` | **保留**——user 是普通端点后这是纯视图选择，不是特判 |

---

## 3. 数据迁移（存量桶改名）

`<数据根>` 下按 conversationId 寻址的资产全部改名
（`sessions/<agentId>/` → `sessions/<pairKey>/`）：

| 资产 | owning | 迁移动作 |
|---|---|---|
| `sessions/<conv>/`（含 singles 上架子路径） | ac-session | 目录 rename；`.shelves.json` 键同步改写 |
| `memory/<conv>.md` | ac-memory | 文件 rename（键=conversationId 与桶统一） |
| `archive/<conv>/` | ac-archive | 目录 rename |
| `usage/usage-*.jsonl` 行内 conversationId | ac-usage | **双读兼容**（见下），不重写历史 |
| `conversation/pending-<handle>.jsonl` | ac-conversation | handle 含对键，rename；残留待投条目少，缺失可接受 |
| `groups/<gid>/`、`singles/<sid>/` | 各自 | 不动（键不变） |

- **usage 历史兼容**：旧流水行 `conversationId=agentId`，新代码 byPair
  解析不到 `~` → 归"迁移行"分支（现有逻辑：`[agent, conv].sort()` 兜底
  会把旧 user 对误判——迁移脚本跑完后**保留旧流水的 byPair 双读**：
  `conv===agent` 旧行仍按 `{a:'user',b:agent}` 记，仅新行走对键解析。
  半年后可清。）
- **脚本**：`preview/scripts/migrate-pair-buckets.ts`（仿
  migrate-workspace.ts：`--dry-run` 默认、marker 幂等、`--force` 重跑）。
  名册来源 = agents 目录 + 单 view 会话的 agentId 约定（全部按
  `pairKey('user', agentId)` 改名）。
- **多虚拟 Agent 的未来**：本迁移只处理单一 viewer('user') 存量；将来
  增加虚拟 Agent 是**新增对桶**，零迁移。

## 4. 分阶段落地（建议 4 步，每步独立可验证）

1. **信封与构造**（纯增量，零破坏）：ac-agent-loop `pairKey` 导出 +
   senderId 进三处信封 + 事件载荷加位 + agents.register id 校验。
   测试：pairKey/id 校验/senderId 透传。
2. **后端切桶**：#1-#3 #5-#9 特判删除 + conversation 缺省改对键推导 +
   一次性跑 migrate-pair-buckets（同一 PR）。测试：ac-session（对桶
   name 标注/agent→虚拟端点统一路径）/ac-usage（对键 byPair + 旧流水
   双读）/ac-system-prompt（senderId 对话对象）/ac-timer（system 对键）。
3. **前端切分区**：#10-#14。routeDialog 对桶统一 + direct 保留为
   viewer 相对糖 + 矩阵/弦图/历史装配跟进 + chat.ts deliver 传对键。
   测试：port-b（routeDialog/toRunsSnapshot/convKeyToId）+ portb-e2e
   全链路（直答对桶 → 流式 → 历史回放）。
4. **文档收口**：README（桶形态表/信封/分区）、src-to-preview-map
   （M19 条目）、本文标 ✅。

每步验收：`pnpm preview:typecheck && pnpm preview:test`，第 2/3 步
加跑 `pnpm preview:boot` 真数据手测（迁移后旧会话可读、直答落新桶）。

## 5. 裁决点（动工前需用户拍板）

- **D1｜senderId 命名与归属**：推荐 `senderId?: string`（加法、零改名
  churn）。备选：`sender` 改为 string 身份 + 新增 `source` 拓扑词
  （语义更净，全库改名 ~30 处）。
- **D2｜机制触发的伪端点**：推荐 `senderId='system'`，全局定时条目桶
  `pairKey('system', agent)` → 矩阵 system 轴（对齐 src 无主触发）。
  备选：维持 `conversationId=agentId`（保留一个特判，不推荐）。
- **D3｜缺省推导落点**：推荐 **ac-web-api 边界显式算对键**（后端服务
  不猜 viewer；前端已在连接上知道 VIEWER_ID）。备选：ac-conversation
  缺省推导（调用方省事，但服务层绑定 'user' 缺省值，与去特殊化精神
  相悖）。注意 #3/#4 是二选一：边界算则前端透传，服务算则边界不传。
- **D4｜direct: 分区去留**：推荐保留 `direct:<agentId>` 作为"含 viewer
  对桶"的 viewer 相对糖（左列表点 Agent → 直接可写会话的 UX 不变），
  路由层统一按桶键。备选：彻底统一为 `pair:`（UI 改动大，agent 列表
  交互全重接，收益纯审美）。
- **D5｜迁移时点**：推荐第 2 步同 PR 强制迁移（半新半旧桶并存会让
  routeDialog/迁移判定复杂化）。若用户数据宝贵，先
  `migrate-pair-buckets --dry-run` 输出清单人工确认。

## 6. 风险与不做的事

- **风险**：① 迁移脚本 rename 在 Windows 遇文件占用（杀软/编辑器）——
  copy+remove 兜底（ac-session setShelf 已有同款处理）；② 旧 usage
  流水双读窗口期 byPair 口径混合（弦图/矩阵数字前后期并存，可接受）；
 ③ agent→user 私信历史行（M18 记的 assistant 归属）在新模型下由
  name 标注承载，历史行无需改写（渲染语义兼容）。
- **不做**：多 viewer 鉴权（每连接身份）——本文只做"管道可承载"，
  VIEWER_ID 仍是前端单值；singles/groups 桶形态；chord 的 user 过滤
  开关（纯视图选择）。
- **回滚**：第 2 步前所有改动纯增量（第 1 步可独立上线）；第 2 步后
  回滚 = 反向 rename + revert，git 干净即可。

## 7. 完成判据

- §2 表 15 行清零（#15 除外——它不是特判）。
- 新增 Agent 为虚拟 Agent 时，与其对话自动成桶/成流/进矩阵，全链路
  零代码改动（验收：测试里注册第二个虚拟 Agent `user2` 走通直答）。
- `grep -rn "=== 'user'" preview/ac-*/src` 仅剩注释与测试。

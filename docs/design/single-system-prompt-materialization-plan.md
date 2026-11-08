// 目标读者：实现本方案的人/Agent。本文是设计定稿 + 实施清单（cr-888 登记，
// 2026-11-04 会话收敛；cr-889 实施完成——本文件已转裁决存档，历史裁决不是待办）。
// 取代关系：docs/design/session-design.md §5.2 旧轨疑点（prefix-snapshot.json 修订键
// 方案，cr-726 标注现行树未实现）由本方案取代——实施时应同步收口该节。

# singles system prompt 物化（cr-888）

> 裁决链：初议「全量快照 vs 修订键 vs 分层物化」→ 定 D（分层）→ 用户裁决「动态段也在
> system 里，都该物化；变化走上下文注入提示」→ 发现「配置变化即重拍」自相矛盾
> （重拍即破坏前缀）→ 收敛为四机制模型：物化 + diff + 模型切换重算 + 变化注入。
> 会话形态边界：agent 长会话（pair/group）**不物化**——压缩+记忆+归档轮转管上下文，
> 人格编辑即时生效是特性；**仅 singles 物化**。

## 0. 问题与不变量

现状：singles 的 system prompt 每 run 从「Agent 档案 + PromptSection 注册面」实时重组装
（ac-shell-conversation driveRun L547-551 读 config.system → ac-agent-loop run() 入口
assembleSystemPrompt）。任何段内容变化 = system 字节变 = 前缀从变化点全失效（S4）。

目标不变量：**singles 的 [system] 块跨 run 跨重启字节恒定**（tool schema / history 另算）。
变化不回写 system——通过**追加**通道（ledger context 行）通知 Agent。

## 1. 四机制

| # | 机制 | 触发 | 动作 | 缓存代价 |
|---|---|---|---|---|
| ① 物化 | 首 run | 全段求值落 `<sid>/prefix-snapshot.json`（段数组+指纹） | — |
| ② diff | 每 run 入口 | 指纹对比（§3 键面），不一致分流到 ③/④ | 零 |
| ③ 重算 | 仅 provider/model 变化 | 全量重组装落盘 + 指纹更新 | 零（换缓存域，白纸） |
| ④ 注入 | §4 清单变化 | ledger 落一条 context 通知行 + 指纹更新 | 一行追加 |

核心裁决：**③ 是唯一的快照重写通道，且只在缓存域必死时动快照**。此前讨论过的
「配置变了就重拍」被否——那会在缓存仍有效时打断前缀，与物化目的自相矛盾。

快照正文（人格层）**永不重写**：连「用户主动想刷新人格」也不提供入口——想换人格
= 开新会话（与归档语义一致）。指纹字段更新 ≠ 重写正文。

## 2. 快照形态与组装

快照存**求值后的段数组**（不是拼好的文本）：

```json
{
  "sections": [{ "name": "CALLER|PERSONA|...", "order": 0, "text": "..." }],
  "settingsFingerprint": { ... }
}
```

- 物化时机 = **首 run**（非 singles/create）：空会话 agentId 可空、默认预设 __standard__
  路由发生在首消息，「有消息即锁 Agent」（409）与物化锚点天然互补。
- 组装 = 快照段直接喂现有 assembleSystemPrompt（sections.ts，零改动）——跳过注册面
  求值，段序由快照内的 order 承载。
- 全段冻结（含 ENV_MODEL/GUIDELINES_*/SKILLS/ENV_WORKDIR）：换模型由 ③ 重建基线；
  工具面/技能/指引漂移由 ④ 引导 + 下次模型切换时顺带收编。
- 沉默的段漂移无害论证：工具 schema 就在眼前（Agent 可见工具面变化，旧指引自失效）；
  ENV_MODEL 由 ③ 保证对当前模型恒正确。
- previewSystemPrompt（壳内干跑面）同步读快照——预览 = 真实 run 装配面镜像不破。

## 3. diff 指纹键面（§4 的超集）

```
provider+model | 生效工具名清单（llmToolFace）| toolMode | browserTier | issueSubmit
| workspaceId | tier（权限档位）| elevation | PTC_SDK 文本 hash | 技能名清单
```

- 技能用**结构化名清单**比，不做文本 diff（描述性小改不触发）。
- PTC_SDK 存文本 hash（run_code SDK 投影漂移检测）。
- 红线测试：指纹缺 model 键 = ENV_MODEL 永久错误——必须测试锁定（快照 ENV_MODEL
  与 request.model 的一致性断言）。
- 扩展键（conv-settings registerKey）进指纹：值变 → 通用注入模板（§4-10）。

## 4. 变化注入清单（十类，ledger context 行）

原则：**凡 history 留下行为先验（模型成功做过/被告知过）、此刻不再成立、且无法从
眼前材料自悟的——注入**。措辞进测试锁定（对齐 system-prompt.test.ts 按条目锁措辞
先例，防渐进膨胀）。

| # | 变化源 | 幻觉先验 | 注入文本 |
|---|---|---|---|
| 1 | 工具集变化 | 成功调用轨迹，schema 中消失后仍会尝试/虚构调用 | `[会话设置] 生效工具集已变化：+web_search、-browser。` |
| 2 | toolMode 切换 | 直调轨迹，程序化模式下会模拟直调 | →tc-programmatic：`[会话设置] 工具调用模式已切换：程序化——一切工具调用经 run_code 编排完成，不再逐个直调。` / →tc-base：`…已恢复工具直调。` / →tc-none：`…工具已全部停用，纯对话。` |
| 3 | browserTier 调整 | 成功交互轨迹，降档后动作被拒 | `[会话设置] 浏览器能力档位已调整：manipulate → observe（交互动作不再可用）。` / `→disabled：[会话设置] 浏览器工具本会话已停用。` |
| 4 | issueSubmit 开关 | 成功提交 ISSUE 轨迹 | `[会话设置] ISSUE 提交已停用/已启用。` |
| 5 | workspaceId 切换 | 成功读写旧路径轨迹，会继续引用旧绝对路径 | `[会话设置] 工作区已切换：/old/path → /new/path。` / 移除：`[会话设置] 工作区已移除，回到默认工作目录 /path。` |
| 6 | 技能卸载 | load_skill 回执+正文在 history，仍按旧指引行事 | `[会话设置] 技能 x 已卸载，其指引不再适用。`（装载不注入——技能注入机制本身落 context 行已自明） |
| 7 | 权限档位（tier）变化 | 免授权直跑轨迹，降档后要授权/被拒 | `[会话设置] 权限档位已调整：full-access → base-access，部分工具调用将需要授权。` |
| 8 | elevation 变化 | 同 7 的机制唤醒面 | `[会话设置] 会话提权水位已调整：full-access → sandbox-access。` |
| 9 | PTC_SDK 漂移 | 按旧 SDK 签名写 run_code 程序的轨迹，行更新后必然报错 | `[会话设置] run_code SDK 已更新，以当前工具 schema 与运行报错为准。` |
| 10 | 生态扩展键 | 视键语义 | `[会话设置] <键名> 已变化：<旧值> → <新值>。`（留 per-key 模板 hook） |

合并规则：一次 diff 检出多项 → 合并**一条** context 行（多句并列）；toolMode 连带的
清单变化归 toolMode 一句，不重复报。

## 5. 明确不注入的（裁决存档）

| 变化源 | 理由 |
|---|---|
| 模型切换 | ③ 重算——新 ENV_MODEL 在 system 头部自明，头部覆盖旧陈述 |
| persona / Agent system / memory 指引编辑 | 冻结即隔离（物化目的）；通知泄露「你被改过」，破坏连续性 |
| GUIDELINES_*/TERMINOLOGY/CONDUCT 措辞漂移 | 散文引导不产生可执行行为先验，自纠成本低 |
| maxSteps / llmParams | 无 history 先验、模型不可见面 |
| 归档/轮转 | S5 显式 replace，有既有文案 |
| agentId 变化 | 不存在——409 锁定后引用恒定；物化前换 Agent 无 diff 可言 |

## 6. 机制细节

- **检测点**：driveRun 入口（readConfig 同拍、history 派生之前）——通知行落账在前，
  本 run messages 天然自带（无需 splice 注入）。singles 判定复用 ctx.get('singles')
  （壳内 SinglesShim，ac-host-face-client 提供，datetime 同款消费口）。
- **不选 conv-settings/updated 事件驱动**：写面跨进程；且「改了又改回（中间无 run）」
  不该产生通知噪音——run 入口对账只在变更真实生效于下一 run 时通知一次。
- **崩溃窗口**：先落账（await）后更新指纹——落账后崩 → 重复落同内容行（冗余但如实）；
  反序则漏通知。可加 message_id 幂等键收敛冗余。
- **通知行形态**：role='context'，source='event'，label=`会话设置变更`。
- **归位**：快照物化/重算/指纹 = ac-shell-conversation 新文件（driveRun 编排者同包）；
  diff 通知落账 = ctx.ledger 服务方法（规约 1）；动态段注册制（cr-881）零改动。
- **KV Cache effect**：快照 = Prefix-stable by construction（重算恰是 S5 白名单「快照重拍」
  项）；通知行 = Append-only。
- **设置域键面事实**（ac-conv-settings/src/contract.ts）：model 分流 singles session.json
  （自包含），toolMode/browserTier/elevation/issueSubmit/扩展键全形态含 sid——diff 读
  convSettings.get(sid) + session.json.model 合成全键面。

## 7. 实施顺序（动手前逐条对齐本文）

1. 快照文件读写 + 指纹（含崩溃顺序）——ac-shell-conversation 新文件；
2. driveRun 接线：singles 判定 → 首 run 物化 / 快照段替换注册面组装 / diff 分流；
3. 注入模板表 + ledger 落账（合并规则 + message_id 幂等）；
4. previewSystemPrompt 读快照；
5. 测试：物化/冻结/重算触发（仅 model）/十类注入文本/幂等/崩溃窗口/非 singles 不
   激活/预览镜像/指纹缺 model 红线；措辞按 §4 表逐条锁定；
6. 文档收口：session-design.md §5.2 疑点（cr-726）改判由本方案取代 + §4.4 失效面更新
   + 根 README 如有布局影响同步。

验证阶梯（契约/持久化/会话链路全动）：pnpm typecheck && pnpm test:unit &&
pnpm check:deps + 定向 lint + pnpm test 全量 + pnpm test:integration。

## 8.bis cr-944 增补：段集指纹三键与重算分流

§3 键面新增三键（求值口径与 ptcSdk 同——snapshotRequest 现算，CALLER 排除）：

- `sectionSet`（段名集 hash）：增删段检测 → ④ 通知（`[会话设置] 系统提示词
  段落构成已变化…以当前会话为准。`——hash 不可逆不定名）；
- `sectionOrders`（名+位序列 hash）：**名集相等但位变** → ③ 重算（快照正文序
  变 = system 字节变 = 缓存域必死）；名集增删不触发 ③（快照不含新段，system
  不变，缓存不死——走 ④）；
- `sectionTexts`（名+位+文本 hash）：纯文本漂移 → 不通知（cr-944 裁决 B：
  行为面变化已由十类键覆盖，残余是散文），键值进指纹 = 漂移只报一次。

§4 十类清单增第 11 类（段落构成变化）。原 §5「GUIDELINES_*/TERMINOLOGY/
CONDUCT 措辞漂移不注入」裁决维持——sectionTexts 键只做指纹对齐不做通知源。

## 8. 残余风险（显式接受）

- 段漂移累积窗口：技能/指引更新到下次模型切换之间，快照停留旧文本——靠 ④ 注入
  引导 + Agent 自悟（schema 在眼前），接受；
- 注入面收窄的演化空间：后续若要从不注入改为注入（如 GUIDELINES 措辞漂移），只需
  扩 §3 指纹键 + §4 加行——机制不变，调整面小（用户 2026-11-04 明示）；
- 通知行噪音：单 run 多项变化已合并收敛；跨 run 频繁切换属用户行为，不设防。


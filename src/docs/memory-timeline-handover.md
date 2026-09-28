# 记忆时间线与群聊转录流重构——交接文档（cr-4 施工交接）

> 本文承接 `src/docs/memory-timeline-plan.md`（设计与裁决）与 `src/docs/cr-log.md` cr-4 条目。
> 本轮会话完成了主体实施 + 三轮用户反馈迭代 + 生产数据迁移/清理，遗留测试验证工作给下一会话。

## 一、实施完成面（全部已落地并通过验证）

### 1. 记忆时间线（ac-memory / ac-memory-core）
- **存储**：`files/<agentId>/memory/timeline.md` 单文件；条目 = 头注释（宿主铸造 at/origin/peers）+ 正文
- **条目格式（log 形态，最终版）**：
  ```md
  <!-- at:2026-08-16T03:00:00.000Z | origin:admin~admin | peers:user -->
  [2026-08-16] [约定|档案] 正文……（标签段由 Agent 写进 content，从小词表取：约定/偏好/事实/教训/待办/档案）
  ```
  - 日期段 `[YYYY-MM-DD] ` 由工具铸造；**tags 参数已移除**，标签 = 正文前缀段（parse 侧提取为轴，头注释 tags 字段仅为存量兼容）
  - **date 参数**（可选）：事实发生日回填，`at = date当日 + 当前时刻`（同日排序稳定），缺省=今天
- **服务三口**：`write/entries/grep`（set/append/get/ids/remove/fileOf/memoryBucketOf/anchorOf 全退役）；persist=false 内存后端同语义
- **工具**：`memory_write`（requiredTags: ['memory']，needPermission: false）/ `memory_grep`（pattern/since/until/peer/tag 过滤轴）；BUILTIN_TOOL_NAMES 已增补
- **注入协议**：`conversation/before-start` seam（新 emit 事件，startRun 顶部、history 装配前）——
  锚检测状态机：无锚/H<S → 快照重定基线（尾行内嵌「记忆基线 seq=N」）；H>S → 他源 delta（origin ≠ 本会话）；H=S → 零注入
- **system 侧**：恒定 `<memory-guide>` 静态指引（字节恒定——写入内容不进 system）
- **迁移**：boot 延迟 100ms 触发；**指路形态提示词**（不内嵌旧桶——Agent 自读 ./memory 整理，
  双写入方式：memory_write 或按格式直写 timeline.md）；infra 等价授予（有存量桶 + infra tag + 无 memory →
  自动补 tag：agentStore.saveAgent + agents.reassign，预设豁免）；`.migrated` marker 幂等；
  旧桶键正向判定（含~/g-前缀/裸agentId——TODO/DONE/README 等工作文件不误扫）

### 2. 群聊成员转录流（ac-group）
- post 扇出：逐成员 `sessions/<gid>~<member>/` 追加 viewer 投影行（own=assistant 原文 / peer=user <msg> 包装+时间行）
- send 投递键 = 成员流键 `gid~member`（hint 只唤醒不携消息）；GROUP_CONTRACT_TEXT 判定键 = `isGroupConversation`（本体键+成员流键）
- 入群种子（join 时一次性投影本体尾部+归档摘要头）；leave/delete 清成员流
- 撞形双卡：群 id 禁 ~ + 撞 Agent 拒；agents.register 反向撞群拒
- 退役：派生窗全族（windowOf/deriveWindow/D6）、相邻 peer 合并、historyFor 派生视图、
  属主整理轮转全族（rotateWithReview/completeRotation/scanRotationPending/pending 读写族）、
  GroupFeed（readSince/currentAnchor）、setMemoryOwner、memoryOwner 契约字段、
  group/memory-owner-set 事件、group/set-memory-owner RPC、ws-bridge 帧
- 保留：本体机械轮转（archiveTokens/keepTokens + tailScan）

### 3. 配套改动
- ac-session：onReplyCompleted 去 isGroupHint 只留 isGroupBucket（成员流获得完整 settlement 转录，群本体零转录）
- ac-conversation：contextFor 删群桶派生分支（成员 run 恒走 session.history）；events.ts +conversation/before-start
- ac-singles：prefixRevision 记忆哈希段删除（memoryBucketOf/get 退役后唯一消费方同步删）
- ac-archive：整理提示词记忆条目删除 + 补「context 注入行是机制材料无需纳入概要」；memoryBudgetOf/memoryEnabledOf 退役
- ac-timer :737 注释改写；ac-agent-presets-builtin 三预设 tags +memory；WebUI 创建面默认 memory tag
- WebUI：GroupDrawer 群主 UI 删除 + 成员流查看入口（session/history Modal）；conversation 身份回落 memoryOwner → 首成员
- README 五处同步；event-catalog run 域清单 +conversation/before-start

## 二、验证状态（截至本会话末）

| 项 | 状态 |
|---|---|
| pnpm typecheck | ✅ 绿 |
| pnpm check:deps | ✅ 绿（清了 ac-group→cordis-timer、ac-memory→ac-singles 两处无用声明） |
| 定向 lint（全部改动包） | ✅ 绿 |
| pnpm webui:typecheck | ✅ 绿 |
| pnpm smoke | ✅ 绿 |
| pnpm test:unit | ✅ 2179 passed / 2 skipped |
| pnpm test:integration | ⚠️ 555/556——唯一失败 `src/webui/tests/portb-e2e.integration.test.ts` singles 用例「Agent helper 不存在」**已用 git stash 对照证实为存量问题（基线同样失败），与本重构无关**。下会话可顺手排查 |

测试重写面：ac-memory 29 用例（协议状态机/工具/迁移幂等/infra 授予/date 回填/标签通道）、
ac-memory-core 29 用例（解析容错/快照确定性/grep 轴/前缀去重/降级自愈）、
ac-group 28 用例（成员流扇出/沉默权/撞形双卡/isGroupConversation/blindspot 回归）。

## 三、生产数据迁移实况（workspace/home）

- 12 个 Agent 全部经历迁移；admin 已用最终形态（date 回填+标签通道）重迁，质量良好（28 条，历史日期准确）
- 其余 11 个的旧迁移产物已清理（timeline+marker+自会话迁移 run 3 行组），**等待用户下次重启全量重迁**
- 清理脚本按「context 角色提示行 → 其后首个 run-settled」成组删除；news 的 11:00 后业务 run 完整保留
- 旧记忆桶文件全部保留不删（供重迁读取 + 回查）

## 四、下会话工作清单

1. **测试问题处理**（用户指派的主任务）：portb-e2e singles 用例存量失败——线索：错误「Agent helper 不存在」
   出现在 createSingle RPC；该用例依赖同文件第一个用例建档 helper（顺序执行耦合）；stash 基线复现 = 非本轮引入。
   排查方向：bootTree 的 agents 行与 createSingle 的会话键解析；怀疑与时间/环境相关（历史上过过）
2. **重启后重迁观察**：11 个 Agent 用最终形态重迁——抽查 2-3 个的 timeline 质量（date 回填准确率、标签词表收敛度、
   有无三层重复残留）；news 这类业务繁忙 Agent 的迁移 run 是否被队列正常消费
3. **观察项**（plan §七，上线后验证）：KV 命中率、delta 空占比、memory_write 自主使用率、成员流压缩、M26 契约服从性
4. （可选）渲染层按 at 排序的裁决——用户已定「迁移就一次，不值得改」，维持现状（写入序渲染），整理归 sleep-time 二期

## 五、关键文件索引

| 文件 | 内容 |
|---|---|
| `src/docs/memory-timeline-plan.md` | 设计与裁决（头部有实施状态标注 + 两处落地偏差说明） |
| `src/docs/cr-log.md` cr-4 | 变更登记（含三轮追加裁决） |
| `src/ac-memory/src/index.ts` | 服务+工具+注入协议+迁移（~428 行） |
| `src/ac-memory-core/src/index.ts` | 渲染/解析纯库（~295 行） |
| `src/ac-group/src/service.ts` | 群服务（1486→约 870 行） |
| `src/ac-conversation/src/service.ts` | before-start seam + contextFor 简化 |
| `src/ac-conversation/src/events.ts` | conversation/before-start 事件声明 |

## 六、本轮用户裁决链（时间序）

1. 计划全量实施（cr-4 立项）
2. 迁移前置 infra 等价授予（存量 infra Agent 自动补 memory tag，预设豁免——覆盖 2026-09-16「手工补」默认）
3. 条目 log 形态前缀（[date] [tags]，工具铸造）
4. 迁移提示词改指路形态（不内嵌旧桶）
5. date 参数（事实发生日回填）+ tags 参数移除（标签 = 正文前缀段，单通道）
6. 存量迁移产物清理两轮（admin 单独 + 其余 11 个批量），待重启全量重迁
7. 渲染排序维持写入序（迁移一次性，不值得按日期排序改）
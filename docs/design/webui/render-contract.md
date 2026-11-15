# 渲染契约(render-contract)——第三阶段分析稿

> 性质:设计分析稿(待裁决项见 §六)——UI 如何从落盘事实取数投影,与回放契约彻底分面。
> 状态:**已实施完毕**(cr-1109 切片 A:bytes 派生+注册声明优先+数据面透传+skill 文案退役;cr-1110 切片 B:ViewRow 类型化+恒等化判据修正+face-shell 对齐;cr-1111 切片 C:resume 收编(none 机制词集)+直播行 agent_id 真值;cr-1112 切片 D:MessageSourceKind 开放化+as never ×2 退役)· 前序:replay-contract.md(cr-1101~1108)。
> 读者:动 foldViewRecords / web-api / historyApi / feed 的人。

## 一、现状事实(2026-11-15 复核)

**取数双路径**:
- 刷新/历史:rpc session/history → ac-host-webui/web-api → assembleSessionView → `foldViewRecords`(ac-ledger/fold.ts)→ historyApi.toHistoryMessages → feed;
- 直播:`session/context-injected` 帧(feed-core showEventNotice)→ run/settled 时重拉权威行汇流;
- 同形机制:injectionId 同锚(帧铸 = 物化行 message_id)+ label 同源落盘(records.ts cr-707)+ payload 同源(cr-1107 起公共数据面)。

**判据污染矩阵(收敛对象)**:
| 位置 | 现状 | 问题 |
|---|---|---|
| fold.ts:311-312 | `isInjectCard = source==='inject' || source!=='error'` | 恒等化写法(前项永真)——黑名单「不属 error」|
| fold.ts:317/319 | label/source 回落黑名单(∉{inject,event}) | source 词兜底文案 = UI 语义寄生落盘词 |
| fold.ts:398/406/428 | error 红条 / 直落 context / event 分隔符三段特判 | 按词硬编码 |
| historyApi.ts:257 | `isInjectionRow = source∉{event,error}`(cr-890 补丁双在场) | 第二处同词异写 |
| feed.ts:205 | isInjectEvent 第三处同词异写 | — |
| feed-core.ts:2181 + historyApi.ts:267 | `as never` 宽化 ×2 | source meta 塞存储词,值域宽于枚举 |
| feed-core.ts:2634 | skill 写死文案 | label 数据面已同源,特判多余 |
| feed-core.ts:2177 附近 | 直播行 agent_id 写死 'system' | 与刷新行不同形 |

**已就位资产(一/二期带来)**:inject-card:view 注册表(injectCardViews.ts,kind=source 精确匹配+priority+通用卡兜底+问答卡首例);payload 公共数据面(cr-1107);回放声明注册制(cr-1104——`none` 词有了合法落点);词表 watchdog(cr-1106)。

**Gap**:bytes(帧有、盘无、投影未派生);resume/resume-degraded 帧不落账(刷新永久丢);foldViewRecords 返回 `Array<Record<string,unknown>>` 无契约类型;MessageSourceKind 六死值。

## 二、设计支柱

### 2.1 ViewRow 判别联合(契约 owning = ac-ledger)

foldViewRecords 输出从裸 Record 升为显式判别联合(ProjectedStep 先例——字段即契约):

```ts
export type ViewRow =
  | { kind: 'message'; role: 'user'|'assistant'; content; agent_id?; run?; runMs?; seq?; steps?; partial? }
  | { kind: 'inject-card'; source: string; content; label?; payload?; injectionId; bytes; agent_id; run?; requestId?; seq? }
  | { kind: 'event-sep'; content; message_id; timestamp; agent_id; requestId?; seq? }
  | { kind: 'error'; content; message_id; timestamp; agent_id; run?; seq? };
```

- **kind = 渲染通道(封闭 4 值)**;**source = 身份键(开放)**——卡片注册 match 键不变。与回放契约「判定按行类别、身份键开放」同构,但两契约词汇不混(回放档 ≠ 渲染 kind,各自独立演化)。
- **判定声明制(用户裁决 2026-11-15),声明落点 = 前端席位注册**(2026-11-15 二次裁决:ctx.ledger 管不了 UI):
  - **跨进程硬约束**:渲染投影消费方在宿主进程(web-api.ts:230 + face-shell.ts:422/451 第四处判据复制),声明方(注入源行)在壳进程——ctx.ledger 运行时注册表跨不过进程边界(对照 registerReplayPolicy 合法性:historyMessagesFor 与声明方同在壳进程)。
  - **通道判断移前端**:`inject-card:view` 席位注册即声明——注册专用卡的词 → 卡;未注册走兜底链(role:'error' → 红条;role:'event' → 分隔符;数据面在场 context → 通用卡)。声明优先、启发式兜底。
  - **后端不做渲染裁决**:foldViewRecords 输出类型化数据行(role/source/label/payload/injectionId/bytes 派生——盘上事实 + 确定性派生,无 ViewKind 词)。后端四处判据(fold 三段 + face-shell 复制)全删,判断单点收敛前端。
  - **远期静态正名(方案 B,后续批)**:package.json `ac.sources`(cr-901 包即插件正脉)——宿主装配期静态可读、跨进程免疫、可进 catalog 生成投影;可反向给 replay 声明提供静态种子。需接宿主读行包元数据机制,独立管线不挡切片 A。
- **bytes 投影派生**(content.length,与帧定义恒等)——零落盘。
- 落盘事实仍不掺 UI 语义:kind 住投影层(读时纯函数),合规。

### 2.2 resume/resume-degraded 收编(二期注册制的新解)

resume 帧改落账 context 行(source='resume',label 照旧)+ `registerReplayPolicy({source:'resume', replay:'none'})`:
- UI 刷新可恢复(经投影 inject-card 通道,数据面 label 在场);
- LLM 不受扰(none 档);
- 词表经 watchdog 纳管。
直播帧继续同锚发射(injectionId),mergeHistoryPage 双键去重照常。

### 2.3 直播/刷新同形收口

- 直播行 agent_id 用帧 agentId(去 'system' 写死);
- skill 写死文案删除——label 数据面已同源,通用文案回落;
- 同形对拍测试:recordContext 帧构造的直播行 vs foldViewRecords 投影行,label/kind/payload/bytes 等值。

### 2.4 降级矩阵(插槽-插头,与回放声明降级同构)

| 缺失 | 降级 |
|---|---|
| source 未注册专用卡 | 通用注入卡(数据面渲染 label/content/payload/bytes) |
| kind 未识别(未来新值) | event-sep 回落(不崩) |
| 数据面缺席 | 纯文本 content |
| 注册行卸载 | 通用卡 |

## 三、实施切片(各自独立 CR)

- **A(地基)**:ViewRow 类型化数据行(无渲染裁决)+ bytes 派生 + 后端四处判据删除 + 前端通道映射(注册表 > 兜底链)+ fold 快照测试(全词表夹具)。foldViewRecords 消费方(web-api/historyApi)先兼容读(新旧字段并存一轮)。
- **B(前端切换)**:historyApi/feed 判据删、as never ×2 清、前端直读 kind;同形对拍测试。
- **C(收编)**:resume 落账 + none 词注册 + 直播行 agent_id/skill 文案清理。
- **D(退休收尾)**:MessageSourceKind 死值退役、shim 瘦身(kind 判据坍缩后安全)。

A→B 顺序依赖;C/D 可与 A 并行。

## 四、验证设计

1. fold 快照:全词表 v2 夹具 → ViewRow.kind/字段面断言(渲染契约锁,防判据回潮);
2. 同形对拍:直播帧行 ≡ 投影行(label/kind/payload/bytes);
3. 数据根扫描:现有 v1/v2 会话经投影,kind 分布对拍(行为变化点显式列出);
4. 注册表:未注册 kind 通用卡不崩(扩 inject-card.test);
5. 词表 watchdog 补 'resume'。

## 五、行为变化点(需在切片 A 快照测试中显式钉住)

1. 带数据面的 event 行(如 singles 设置变更通知,label:'会话设置变更')从「event 分隔符」升为 inject-card——**待裁决 §六-2**;
2. 无 run 锚的直落 context 行(cr-1106 兜底产物)从尾段直落行归入 inject-card 通道;
3. v1 存量 skill context 行(无 run 键)从「尾段直落 context 行」变为 inject-card(带 label 数据面)。

## 六、待裁决

1. **error 通道是否开放注册**(自定义错误卡)?建议不——错误红条是系统级语义,保持核心渲染;未来有需求再开。
2. ~~event 升卡边界~~ **已随声明制消解**(2026-11-15):不再统一规则,逐词声明——设置变更通知要卡就声明卡,不声明走兜底;行为变化从全局切换变为各词自主选择,无全局回归面。
3. **ViewRow 契约 owning**:ac-ledger(foldViewRecords 旁,ProjectedStep 先例)vs 独立 webui 域包。倾向 ac-ledger——投影产出方即契约方,前端仅消费。
4. event-sep 通道的未来:cr-946 机制通知(重启「已重启」)现走 event 分隔符——声明制下由其 owning 方(壳)自行声明升卡或维持;裸 event(v1 无 label 遗产)继续兜底走分隔符。通道保留(兜底语义),是否逐步收编归后续观测。

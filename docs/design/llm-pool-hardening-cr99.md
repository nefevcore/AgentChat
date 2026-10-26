# 模型池加固记录（cr-99，2026-10-01）

背景：模型池设计评估（对齐 pi-ai 对照）识别出三个真实缺口与三个结构性
脆弱点。本批全量修复——设计骨架（连接池 = 唯一事实源）经评估确认保持，
不动结构只补强度。

## 脆弱点修复

### A. 观测状态与连接意图同体（伤害链：发现回写 → 热重挂 → close 杀在途流）

修法：意图/观测双签名 + replaceMeta 通道。`LlmService.replaceMeta(name, meta)`
原位更新注册元数据（不撤挂不 close）；`intentSignatureOf` 剔除纯展示性观测
字段（modelMeta 的 hidden 位——最高频观测回写），其余变化仍走撤/挂。

边界裁决：models 清单与 vision 位留在意图签名。vision 探测位改变
effectiveVision（物化门控在实例上）——必须重挂才生效；宁可多挂，不可门控
过期。发现缓存刷新若带新 vision 位会重挂（小概率、语义正确），纯清单扩容
与 hidden 切换不重挂。

### B. 传输层键靠约定剥离（每加一键 × 4 协议库 = 静默 400 面）

修法：`TRANSPORT_KEYS` + `stripTransportKeys` 单源（住 ac-openai-completions，
其余三库依赖或复制语义——分层纪律：协议库不依赖 ac-llm）。各库序列化边界
兜底过滤；显式解构保留（第一道防线），单源过滤是第二道。

### C. 路由的注册序是隐式全局状态（config 键序悄悄决定路由）

修法：`resolveByModels` 同名命中收集全部 provider，字典序最小者胜 +
logger.warn 报歧义（提示 name@model 显式引用）。路由结果不再依赖注册序。

## 缺口修复

### ① 改名/删除的引用完整性（缺口①，bug 级）

修法：`llm/pool-references` RPC（agents 名册扫 provider@model 引用），
PoolManager 删除确认弹窗与改名守门消费——列出引用方清单再决策，静默断路
变可见提示。引用不自动迁移（字面量引用语义保持——迁移需用户确认，留待
真实诉求）。

### ② 容量元数据（缺口②窄版）

修法：`PoolModelEntry.contextWindow`（手配声明；正整数收）。经 modelMeta →
stats 透出（观测面）。发现端点容量回写（协议库 listModels 返回对象化）留
待实测需要——本批只落数据面与归一。

### ③ 连接健康面（缺口③）

修法：`LlmService.lastErrors`（provider → {kind, at, message}），dispatch 最终
失败时记录（LlmHttpError 结构化分类，其余 UNKNOWN），`LlmProviderStats.lastError`
透出。前端徽章消费（AUTH=换 key / RATE_LIMIT=稍后 / QUOTA=充值）待 UI 批次。

### ④ 同名模型静默歧义（缺口④）

由脆弱点 C 修复覆盖（字典序 + warn）。

## 遗留（挂 gap-backlog）

- per-route 重试策略（transientRetry 仍服务级全局量）
- 发现端点容量回写（listModels 返回对象化）
- 健康面前端徽章呈现
- 改名引用自动迁移（需用户确认交互设计）

## 验证

typecheck ✓ check:deps ✓ 单测 2312 通过（新增 8 用例：消歧 1 / 传输键含于既有 /
观测分离 1 / 健康面 1 / 容量 1 / pool mock 语义更新 4）✓ webui:typecheck ✓
定向 lint ✓ smoke ✓
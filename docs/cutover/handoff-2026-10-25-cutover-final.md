# 交接：cutover 终态收尾（2026-10-25，cr-680…689 会话）

> **本文为 cutover 收敛期交接（历史）**：路径口径为当时布局（文中 `preview/`、`src/` 路径已随 cr-703 单轨重组消灭）；现行事实源 = 根 `README.md` + `docs/design/`。只读历史，不再更新。

> 下一个会话的入口。**先加载 agentchat-dev 技能**，再读 preview/docs/plan.md §5 尾部（cr-680…689 行）与本文。
> 上一代交接：handoff-2026-10-23.md（切换后收敛期）+ handoff-2026-10-24-restart.md（restart 双件）+ handoff-2026-10-24-workspace-files.md——均已被本文取代，细节仍可查。

## 0. 一句话现状

**切换判据三件套两闭一续**：会话续跑 ✅（cr-667 原地续跑）、bench 门 ✅（cr-680 真 LLM 门过，见 §1.1）、真实使用期观察（进行中）。cutover 终态收尾五件里 **两件已完成**（虚胖词 cr-683、通道设计 cr-687），**三件被用户裁决悬置**（见 §2——新会话第一件事是拿到裁决）。

工作树干净、cr-681…688 已入库（HEAD 221b4c5f），**push 待用户确认**（origin/main 落后约 30 commits）。

## 1. 本会话完成（细节在 plan.md §5 对应行）

### 1.1 cr-680 bench 门判据兑现（切换判据闭项）

- 预演根 preview/sandbox/bench-gate-680/（隔离数据根：config.json + credentials/ 拷贝自产品根）+ 专用 agent bench-vetted（tools:[bench] 点名行集）。
- evolve 五步闭环真跑：指纹对拍一致 → 微变更换装（benchRound r1→r2）→ 新壳拉起（rows=11）→ 真 LLM bench 验收门 → 快照点 + 回执。
- **门过轮 = glm-5.3-flash 真凭据 BFCL 7/7（accuracy 1.0）**，snap-000002（evidence=bench-gate）+ evolve-receipt.json。
- 对照：deepseek-flash 5/7、deepseek-v4-pro 6/7——**#2 用例重复调用（两步双发同调用）是 deepseek 模型行为特性非管线缺陷**（glm 同例单发过、deepseek 单例轮也过；行为样本留档 bench-report-final.json，未来 deepseek 生产会话重复工具调用可回查）。
- 修了一件：preview/apps/host/bench-gate.ts 补 model/provider 可选参——传入即真跑档，缺省维持 scripted mock 冒烟档（原签名无真跑入口，判据跑批只能手拼控制帧）。
- **预演根可整目录删**（判据证据已固化在快照链与报告文件）。

### 1.2 cr-683 row-catalog 死词清理

fs-tools 行去 fs_read/fs_write/fs_edit/file-snapshots、fs-search 行去 fs_glob/fs_grep（点名展开不在注册面 = 纯死词；全仓求证零存量消费）。留词裁定：bash（存量兼容锚）、datetime（点名命中提示注入行，活词）。涟漪一处：boot.test seed 词形 fs_read→read。

### 1.3 cr-687 R7-9 插件 client 通道设计成文（R7 板最后一个 ◐ 收口）

设计文档 preview/docs/design-plugin-client-channel.md（**新会话做 B1-B4 实施批时先读它**）：
- 关键实测：seats 字段只声明不消费（校验/下发有、装载器从不读）——注入语义空洞的实体；
- 注入语义裁决 = seats 与 SlotCore 注册面双向对账（warning 不拒载），不做宿主代理注册；
- 挂拓扑 = new:&lt;key&gt; 新席位 + view 视角挂载（layout 增 registerView 唯一 API）；
- 换壳三级：主题包本批开 / 渲染管线 ◐ / 形态壳 v2 不做；
- 存量四批 B1-B4（B4 前置 = 迁出 + 退役）。

### 1.4 混批（另一会话同窗完成，已入库）

cr-681 manage 探针 boot 窗口竞态 / cr-682 singles/list 摘要缓存 / cr-684 待答徽标 / cr-685 链跑队列双丢 / cr-686 账本双行清理 / cr-688 排队 turn 唤醒消费。

## 2. 三项悬置的用户裁决（新会话第一件事）

本会话经 interaction dur-mvnjaof5-qy8tmyv7 发起两问 + 勘察出第三问，用户答「系统出了一些问题，稍后再回复」——**未裁决**。新会话开场直接重新发起（问题与选项见下）：

### ◐a 行内档位词终态（web observe/manipulate/inject、collab admin、dev）

背景：ac-import 迁移映射表 ROW_LEVEL_TAGS 已实现（observe→settings.browser 等），但消费端 web-tools/collab-tools 行内监听器**仍读 tags**（sessionCapsOf 合成）；活体数据根 tags 还是混居词形（__standard__ 带 fs,shell,web,observe,...）。真正收口 = 消费端改读 settings + 活体数据换轨。
- **A. settings X1 单源**（裁决簿倾向）：行内监听器改读 settingsOf(agent, browser/collab)——conv-settings 会话覆盖优先级不变；活体 tags 词清除改写 settings。
- **B. 行 config 自治**：档位词留 AgentConfig.tags 约定词表（不动 settings）——最小改动但保留 tag 词汇残留。

### ◐b requiredTags 迁移范围 + cr-618 tools→rows 改名是否同批

背景（勘察重估）：**主线 193 处 requiredTags 不是战场**——旧树是冻结回滚线（R6.1 钉界整批退役），随退役批自然消亡。真实战场 = preview 树 9 处 + 主线行包被 preview 壳运行时消费的软链（toolsCatalog 回显、loop 越面判定辅助）。preview 壳 LLM 面（llmToolFace）已不消费 requiredTags/tags——行集引用即授权已落地。
- **A. 同批做改名**：preview 全链 tools→rows（AgentConfig 契约、rowset 派生、模板/活体 config 数据、boot 读取）——影响面 preview 12 处读点 + 主线行包 35 处（后者随旧树退役免动）；名实相符一次性收口。
- **B. 只清 requiredTags，改名缓行**——减少本批变量。

### ◐c 29 通道包物理迁出路径（item 3）

勘察实锤（详见 design-plugin-client-channel.md §6）：旧树 cordis.yml 明文引用全部 29 个 ac-client-ui-* 包，dev:legacy 是终极回滚线——包移出 src/ 连带回滚线断；双占名回收（ac-credentials/ac-conversation/ac-webui-app）只能退役后做。量化：31 包/247 文件/~2.3MB。
- **A. 与退役同批**：一次完成移出+撤行+删旧树——风险集中一个批。
- **B.（本会话建议）提前迁出保回滚**：目录移 preview/packages/ac-client-ui-* 但**保留包名**（workspace globs 已覆盖、按名 import 全不变、旧树仍可解析）；随后单批补 typecheck 覆盖面（根 tsconfig 的 src/*/client/**/*.ts 失盖 → 挂 preview/packages/tsconfig.json 的 ac-*/client/**/*.ts，并显式决定是否纳入主线 CI 门禁）。

## 3. 判据与清单全景

| 判据 | 状态 |
|---|---|
| 会话续跑 | ✅ cr-667（原地续跑 + 未提交调用合成结果未知） |
| bench 门 | ✅ cr-680（glm 真 LLM 7/7 + evolve 快照回执） |
| 真实使用期观察 | 进行中（日常使用 + 用户报告驱动修复持续积累） |

| cutover 收尾项 | 状态 |
|---|---|
| 1. requiredTags 迁移 + 改名（◐b） | ⏸ 等裁决 |
| 2. 行内档位词（◐a） | ⏸ 等裁决 |
| 3. 通道包物理迁出 + 双占名回收（◐c） | ⏸ 等裁决（双占名恒后置退役） |
| 4. 插件 client 通道设计 | ✅ 设计成文 cr-687；实施 B1-B4 未开始 |
| 5. 旧树退役归档 | ⏸ 判据余「观察」+ 不可逆需用户确认；R6.1 台账已钉界 |

非阻塞：push 待确认（约 30 commits）；webui 审批卡 / 插件市场 UI（cr-543/545）；存量会话标题回填评估；性能债按需。

## 4. 现场环境（沿用，坑位全文见 handoff-2026-10-23.md §4）

- 产品入口 pnpm dev:supervised（3830，数据根 workspace/home）；/api/healthz 唯一可信探活；行集恒等式 86 = 宿主 48 + 壳 38。
- %TEMP% 偶发 EPERM：vitest/长命令前把 TEMP/TMP 指到 preview/sandbox/tmp（后台 job 包装器自身写 %TEMP% 日志，重定向无效——用前台 + 输出重定向文件）。
- workspace/home 对 Agent 读写双禁（黑名单）——需要读产品根配置走 pwsh 拷贝到 preview/sandbox 再读。
- 改宿主/壳代码后须重启才生效；杀进程先列 pid 再按号杀。

## 5. 下一步（优先序）

1. 重新发起三项裁决（§2 的 ◐a/◐b/◐c——问题文案可直接复用）；
2. 按裁决结果推进：◐a/◐b 一个语义批（半天-1 天）；◐c 路径 B 一个迁移批（物理移动 + typecheck 覆盖面 + catalog webui 行同步，半天）；
3. 通道设计实施 B1（seats 对账 + schema 三词形）起步——独立于裁决，可并行；
4. push（用户确认后）；
5. 旧树退役批（判据「观察」积累 + 用户明确确认后——归档不可逆，先跑 R6.1 传递闭包重算）。
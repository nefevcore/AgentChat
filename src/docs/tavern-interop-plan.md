# 酒馆（SillyTavern）互通方案：角色卡导入 + 世界书注入

> 状态：**方案稿（用户立项，待实施）**。方向已裁决：AgentChat 侧对接——
> 把酒馆生态资产接进 AgentChat（角色卡 → Agent、世界书 → 运行时注入），
> 不做酒馆侧扩展。两大功能面：
> **角色卡互通**（chara card v1/v2/v3 导入 → AgentChat Agent + 反向导出）
> 与**世界书 / Lorebook**（ST world_info / 卡内嵌 character_book 导入 +
> 关键字触发注入）。本文档给出目标形态、数据形状、分批落地与裁决点。
>
> 总立场：**零框架改动，纯增量行**——不新增事件、不动 core 四层
> （llm/loop/router/conversation）、不改 AgentConfig；全部能力长在
> 既有插槽上（`loop/before-run` waterfall、`agentAdmin` 写口、
> `agentStore` 文档/头像、`workspace.agentWorkdir`、`ac-text-budget`）。

---

## 一、目标与范围

### 1.1 目标

1. **角色卡导入**：PNG 内嵌卡（tEXt `chara`/`ccv3`）与 JSON 卡 → 一个
   完整 AgentChat Agent：AGENT.md 人设文档 + `settings.persona.file` 指锚 +
   卡图原样存头像 + 卡内嵌世界书抽离入库；导入前可 dry-run 预览。
2. **角色卡导出**：AgentChat Agent → chara card v3 JSON / PNG（头像回嵌
   tEXt `ccv3`），世界书随卡 round-trip。
3. **世界书域**：归一化的书库存储 + `loop/before-run` 关键字触发注入
   `<world_book>` 块（constant 恒注入 + 主/副关键字 selective 逻辑 +
   token 预算 + per-Agent settings 管控）。
4. **Agent 自维护**：per-Agent 书落 Agent 专用空间，fs 工具（read/write/
   edit）直接可达——对齐 2026-09 memory「fs 工具直写」收敛裁决。

### 1.2 非目标（显式不做，首期）

- 酒馆侧扩展（ST extension 本体）——方向已裁死，不做桥接酒馆前端；
- ST 预设（preset）/ 正则（regex）/ 提示词排序（prompt manager）等其余
  酒馆资产格式；
- 世界书 `position`/`depth` 定点注入（只做 system 末尾统一块——见 D10）；
- `probability` 概率注入、vectorized 向量检索、递归扫描
  （`recursiveScanning`/`excludeRecursion` 等语义不实现，字段透传保留
  供导出 round-trip——见 D7）；
- 卡 `tags` → `AgentConfig.tags` 能力映射（语义不同 + 越权风险——见 D3）；
- 酒馆群聊/多角色卡（group chat）形态。

---

## 二、现状对齐（落点插槽盘点）

| 插槽 | 现状 | 本方案怎么用 |
|---|---|---|
| `loop/before-run` waterfall | persona 前置 `<persona>` 块 / memory 追加 `<memory>` 块 / skill 追加 `<available_skills>`，顺序无关收敛规约（各声明位置语义） | lorebook 注入 = 第 4 个组装器：**追加**语义，`<world_book>` 块进 system 末尾 |
| `agentGate`（ac-gate-core） | per-Agent 软停用统一门控，`agentOfRunRequest` 身份读取器住 ac-agent-loop | lorebook 行监听器整体过 `agentGate(ctx,'lorebook',…)` |
| `ctx.agentAdmin` 写口 | `createAgent`（白名单 sanitize + model 引用归一 + 默认池回落 + saveAgent + reassign）+ `saveDoc`（AGENT.md 唯一写口）+ 预设写口拦截在 **RPC 层**（`assertNotPreset` 住 ac-agent-admin/index.ts） | charcard 导入经 `admin.createAgent` + `admin.saveDoc`；**行内自持同款预设守卫**（直接调 service 会绕过 RPC 层守卫——坑位见 §6.4） |
| `ctx.agentStore` | Agent 数据目录 owning：config.json / 机制 entry / 文档 / `saveAvatar`（M17-E） | 卡 PNG 原样 `saveAvatar`（卡即头像，零转换）；AGENT.md 落文档面 |
| `workspace.agentWorkdir` | Agent 专用空间唯一事实源（常规 = `<root>/files/<id>`；无 workspace 行回落同款约定） | per-Agent 书 = `<agentWorkdir>/lorebooks/<slug>.json`（memory/skill 同款定位与回落） |
| `ac-text-budget` | `estimateTokens` / `safeClipByTokens` 纯函数 | 世界书预算估算与截断（不新写 token 估算） |
| `ctx.webServer` | `registerRpc` + `web.route`（multipart 由传输层解析为 `MultipartBody`，avatar 上传先例） | 两行各自注册自有 RPC/路由（注册即归属——对齐 ac-agent-admin 模式，不动 ac-web-api） |
| 服务名空间 | 已占用 30 键（README 契约归属总表） | 新服务键 **`lorebook`**（已查表未占用）；charcard 无服务（纯编排行） |

---

## 三、总体形态（三包分工）

```
ac-tavern-core/     纯库（零 cordis）：格式归一 + 匹配/预算纯函数 + PNG 读写
ac-lorebook/        世界书行（ctx.lorebook 服务 + before-run 注入 + RPC）
ac-charcard/        角色卡行（导入/导出编排：parse → 预览/物化，无服务）
```

- **纯库/行分工**（设计决策 #4 惯例）：解析/归一/匹配算法全部住
  `ac-tavern-core`，行只做装配与 per-Agent 管控；纯库可独立单测、可被
  未来动态插件复用。
- **两行而非一行**（D1）：inject 面不同——charcard 硬依赖
  `['webServer','agentAdmin','agents']`，lorebook 零硬依赖（webServer 可选、
  agents 经 `agentGate` 软依赖）。装配自由：只要导入不要注入（或反之）
  均成立；charcard 抽书经 `ctx.get('lorebook')` 可选能力，lorebook 行
  未装时降级为警告（书不丢——返回体带归一书 JSON，用户可手工入库）。
- **挂载**：`src/cordis.yml` 两行（带稳定 id：`lorebook` / `charcard`）+
  `ac-app/src/index.ts` TREE 同步；行包声明
  `"agentchat": { "plugin": true }` + `"keywords": ["agentchat"]`
  （ac-tavern-core 纯库不加——fail-closed）。

---

## 四、数据形状与格式归一（ac-tavern-core）

### 4.1 归一类型（库的公共词汇，行与存储共用）

```ts
/** 归一世界书条目（ST world_info 与 card character_book 的公共形状） */
export interface LorebookEntry {
  id: string;                 // 归一 uid（来源 uid / 数组下标）
  keys: string[];             // 主关键字（ANY 命中即候选）
  secondaryKeys: string[];    // 副关键字（selective 逻辑用）
  content: string;            // 注入正文
  enabled: boolean;           // ST disable 取反
  constant: boolean;          // 恒注入（不看关键字）
  selective: boolean;         // 副关键字是否参与判定
  /** 副关键字组合逻辑（ST selectiveLogic 0-3 归一为词表） */
  logic: 'AND_ANY' | 'AND_ALL' | 'NOT_ANY' | 'NOT_ALL';
  order: number;              // 优先序：数值大优先（预算紧张先保留；方向待校准 D6）
  caseSensitive?: boolean;    // 缺省 false
  comment?: string;           // 备注名（UI/诊断用）
  /** 未实现语义的 ST 原字段整包透传（probability/depth/position/递归族…）——导出 round-trip 用 */
  raw?: Record<string, unknown>;
}

/** 归一世界书（存储格式 = 本形状 + spec 头） */
export interface Lorebook {
  spec: 'agentchat-lorebook/1';
  name: string;               // 展示名（原文名保留）
  description?: string;
  scanDepth?: number;         // 扫描最近 N 条消息（缺省行/Agent 配置）
  tokenBudget?: number;       // 书级预算（缺省 settings.maxTokens）
  entries: LorebookEntry[];
}

/** 归一角色卡（v1/v2/v3 → 单一形状；字段缺失 = undefined，组装时跳段） */
export interface CharCard {
  name: string;
  nickname?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  firstMes?: string;
  alternateGreetings?: string[];
  mesExample?: string;
  systemPrompt?: string;          // 卡内 system_prompt（默认不激活——D4）
  postHistoryInstructions?: string;
  creatorNotes?: string;
  creator?: string;
  characterVersion?: string;
  tags?: string[];
  book?: Lorebook;                // v2 data.character_book / v3 同名（归一）
  spec: 'chara_card_v1' | 'chara_card_v2' | 'chara_card_v3';
}
```

### 4.2 输入格式矩阵（归一入口，宽容双形态对齐 models[] 先例）

| 来源 | 形状特征 | 归一路径 |
|---|---|---|
| PNG 卡（v1/v2） | tEXt chunk keyword `chara`，值 = base64 JSON | 提取 → `parseCardJson` |
| PNG 卡（v3） | tEXt keyword `ccv3` | 同上（两关键字都扫，命中即用） |
| JSON 卡 | `spec: 'chara_card_v2'/'v3'` 带 `data` 包裹；v1 无 spec 平铺 | `data` 解包 + 字段平移；v1 直接平移 |
| ST world_info 导出 | `entries: { [uid]: {key[], keysecondary[], …} }` + 书级 scanDepth/tokenBudget | uid 表 → 数组；`key/keysecondary` → `keys/secondaryKeys`；`selectiveLogic` 0-3 → 词表；`disable` 取反 |
| 卡内 character_book | `entries: [{keys[], secondary_keys[], insertion_order, selective, constant, enabled…}]` | 数组直映；`secondary_keys` → `secondaryKeys`；`insertion_order` → `order` |
| 已归一书（本域存储） | `spec: 'agentchat-lorebook/1'` | 恒等校验直通（重导入幂等） |

- 未知 spec / 无关键字 / base64 或 JSON 损坏 → **fail-loud**，报错带
  诊断上下文（PNG 里实际找到的 tEXt keyword 清单 / JSON 顶层键）。
- v1 卡（平铺）自动升格：`spec: 'chara_card_v1'`，字段同名直映。

### 4.3 匹配与预算（纯函数，注入器唯一算法源）

```ts
/** 关键字命中：大小写不敏感（caseSensitive 例外）；拉丁词整词边界（\b），
 *  CJK/其余子串——单点实现，测试锁定 */
export function matchKey(text: string, key: string, caseSensitive: boolean): boolean;

/** 条目级判定：constant 恒真；keys ANY 命中 + selective 副关键字逻辑
 *  （AND_ANY/AND_ALL/NOT_ANY/NOT_ALL 四形态） */
export function entryTriggered(entry: LorebookEntry, scanText: string): boolean;

/** 书级选择 + 预算：constant 先占预算（order 降序），再 keyed 命中条
 *  （order 降序）填至 tokenBudget；超预算截断 + 标记行（对齐
 *  clipMemoryForInjection 截断标记风格）；estimateTokens 计量 */
export function selectForInjection(
  book: Lorebook, scanText: string, tokenBudget: number,
): { entries: LorebookEntry[]; clipped: boolean };
```

### 4.4 AGENT.md 组装（确定性纯函数，golden 测试锁定）

```md
# {name}

## 简介
{description}

## 性格
{personality}

## 场景
{scenario}

## 对话示例
{mes_example}

## 开场白
{first_mes}
（备选开场白 N 条，`### 备选 i` 分节）

<!-- 来源卡元信息：creator / character_version / tags / spec——注释段，不进人设正文 -->

## 原卡提示词（未激活）
system_prompt 与 post_history_instructions 原文收录于此（默认不生效——D4）
```

空段跳过；输出字节确定（同卡同字节——导入可重放）。人格正文 = 前 five
章节；「原卡提示词」章节供用户自行搬运，防越狱模板直接上位。

### 4.5 PNG 读写（零依赖字节工程，不解码像素）

- **读**：chunk 游标（8 字节签名 → IHDR → … → IEND），CRC **跳过校验**
  （卡图常见 CRC 不规范），收集全部 tEXt keyword/value；`chara`/`ccv3`
  命中即 base64 解码。护栏：文件 ≤ 行配置上限（缺省 20 MiB）、chunk 数
  ≤ 4096、tEXt 值长度 ≤ 64 MiB——防解压/解析炸弹。
- **写**（导出用）：取头像 PNG 字节，在 IEND 前插入
  `tEXt(ccv3, base64(JSON.stringify(cardV3)))`，重算该 chunk CRC。
- zTXt/iTXt 不支持（D9）——ST/RisuAI 导出均为 tEXt，遇到再加
  （zTXt 需 node:zlib inflate，纯库可用但首期不做）。

---

## 五、ac-lorebook 行设计（世界书域 owning）

### 5.1 存储（D2：fs 空间双层，对齐 skill 双层 + memory fs 收敛）

```
<root>/lorebooks/<slug>.json                      全局共享书（UI/RPC 管理，沙箱外）
<workspace.agentWorkdir(id)>/lorebooks/<slug>.json  per-Agent 书（fs 工具直达——Agent 自维护）
```

- 文件 = 归一 Lorebook JSON + 换行；`slug` = 书名 slugify（CJK 保留，
  禁路径分隔/遍历，`assertBookSlug` 单点执法，agentStore 文档名同款风格）。
- **读写归本服务**（`ctx.lorebook`：`listBooks(agentId?)` / `readBook` /
  `saveBook` / `removeBook`）；注入时**每次直读文件无缓存**（memory 同款
  理由：Agent 经 fs 工具的外写即时可见）。
- 无 workspace 行回落 `<dataRoot>/files/<id>/lorebooks/`（memory 同款回落）。

### 5.2 注入（loop/before-run，第 4 个组装器）

```
ctx.on('loop/before-run', agentGate(ctx, 'lorebook', agentOfRunRequest, (call, next) => {
  // 1. 身份：request.agent 缺失（loop 直连/子 Agent）→ 不注入（persona 同款）
  // 2. 书集：per-Agent 书 ∩ settings.whitelist（空 = 全部）+ 全局书 ∩ whitelist
  // 3. 扫描窗：request.messages 尾部 scanDepth 条（缺省 2，ST world_info_depth 同值）
  //    拼接为 scanText（role:content 纯文本，工具步不参与）
  // 4. 每书 selectForInjection（书 tokenBudget ?? settings.maxTokens ?? 1000）
  // 5. 拼块：书名分节，条目按 order 降序；总预算二次钳制（settings.maxTokens）
  call.request = { ...call.request,
    system: `${call.request.system ?? ''}\n\n<world_book>\n…\n</world_book>` };
  return next();
}))
```

- **顺序无关收敛**：本行位置语义 = system **末尾追加**；与 `<memory>` 块
  相对顺序不保证、不依赖（规约原文）。命中零条目 = 不注入（system 字节不动）。
- **KV Cache 声明（M21/D9 纪律）**：Prefix-stable per 触发集——同扫描窗
  同书库 = 同字节；触发集逐轮漂移 = system 逐轮变化 → 单桶一次全量前缀
  reset。这是世界书语义的固有成本（ST 同款），按 §4.4「显式接受」口径
  声明，不做尾部注入优化。
- **agentOfRunRequest**：ac-agent-loop 导出的身份读取器（M25）；监听器
  注册自述 `{ description: '<world_book> 世界书关键字触发注入', respectsEnabled: true }`。

### 5.3 settings 与扩展自述

```ts
/** settings['lorebook']（per-Agent；M24 A1 经 settingsOf 合成全局层） */
export interface LorebookSettings {
  enabled?: boolean;      // agentGate 消费（缺省 true）
  maxTokens?: number;     // 注入总预算缺省 1000（<=0 不截断）
  scanDepth?: number;     // 扫描窗缺省 2 条
  whitelist?: string[];   // 书名命中（全局+per-Agent 同过滤；空 = 全部）
}

export const extension: ExtensionMeta = {
  name: 'lorebook', label: '世界书注入',
  description: '关键字触发 <world_book> 块注入（constant 恒注入 + 副关键字逻辑 + token 预算）；per-Agent 书落 Agent 专用空间可自维护',
  fields: [maxTokens / scanDepth / whitelist / enabled 四字段级描述],
  listeners: [{ event: 'loop/before-run', role: '<world_book> 块注入', respectsEnabled: true, … }],
};
```

### 5.4 RPC（本行自注册，注册即归属）

```
lorebook/list    {agentId?}          → 全局书 + 该 Agent 书（名/条目数/描述/来源层）
lorebook/get     {agentId?, name}    → 归一书 JSON
lorebook/save    {agentId?, name, book}   （agentId 空 = 全局书；sanitize 校验归一形状）
lorebook/delete  {agentId?, name}
```

webui 首期只做最小管理面（Agent 配置弹窗 fields 自动渲染 + 设置页书列表/
删除）；上传导入走 charcard 行的通用入口（§6.3）。

---

## 六、ac-charcard 行设计（导入/导出编排）

### 6.1 导入管道（dry-run 先行）

```
① parse   PNG 字节 / JSON 文本 → CharCard（ac-tavern-core，fail-loud）
② derive  Agent id = slugify(name)；冲突探测（ctx.agents.has + agentStore.agentIds）
③ preview charcard/parse RPC：字段摘要 + 派生 id + 冲突报告 + 内嵌书摘要（不落盘）
④ commit  charcard/import（idOverride 可选）：
          a. agentAdmin.createAgent({ id, description: 一句话摘要,
             settings: { persona: { file: 'AGENT.md' } } })   // 默认池回落内建
          b. agentAdmin.saveDoc(id, 'AGENT.md', composeAgentMd(card))
          c. PNG 卡 → agentStore.saveAvatar(id, buf, '.png')（卡即头像）
          d. card.book && ctx.get('lorebook') → saveBook(id, book.name, book)
             （lorebook 行未装 → 跳过 + warnings 携带归一书 JSON 供手工入库）
          e. 返回 { agent, bookImported, warnings[] }
```

### 6.2 字段映射表（导入）

| 卡字段 | AgentChat 落点 |
|---|---|
| name | Agent id（slugify；CJK 保留）+ AGENT.md 标题 |
| description / personality / scenario / mes_example | AGENT.md 章节（人设正文） |
| first_mes / alternate_greetings | AGENT.md「开场白」章节（会话种子 = P4，D5） |
| system_prompt / post_history_instructions | AGENT.md「原卡提示词（未激活）」章节（D4） |
| character_book | 抽离 → lorebook 域 per-Agent 书 |
| creator / character_version / tags / spec | AGENT.md 注释段元信息（tags **不**进 AgentConfig.tags——D3） |
| 卡 PNG 本体 | agentStore 头像（零转换） |
| 模型 | 不映射——createAgent 默认池回落（「默认/继承全局」语义内建） |

### 6.3 RPC / 路由（本行自注册）

```
POST /api/charcard/import   multipart file=card.png|card.json[&idOverride=…]   → §6.1 ④
POST /api/charcard/parse    同上（multipart，dry-run）                          → §6.1 ③
charcard/parse   RPC { json?: string }                    → JSON 粘贴路径的 dry-run
charcard/import  RPC { json: string, idOverride?: string } → JSON 粘贴路径的落盘
charcard/export  RPC { agentId, format: 'json'|'png' }    → v3 JSON（+头像回嵌 PNG）
```

multipart 走传输层既有解析（avatar 路由同款）；PNG 走 HTTP 路由避免
WS 帧塞 base64 大包，JSON 粘贴走 RPC 即可。

### 6.4 导出与守卫

- **导出**：AGENT.md 正文 → description；persona settings 回读；该 Agent
  lorebooks → character_book.entries（归一 → v3 卡形状）；无头像或 format
  =json → 纯 JSON；有头像 → PNG 回嵌 `ccv3`。v3 是导出唯一版本（v2/v3
  读入、v3 写出——spec 向上归一）。
- **预设守卫**：行内自持 `assertNotPreset`（与 ac-agent-admin/index.ts
  RPC 层同款：`ctx.agents.get(id)?.preset === true` 即拒）——service 层
  `createAgent` 不拦预设，直接调 service 会绕过 RPC 层守卫，本行必须自带。
- **幂等**：同 id 重复导入 = 冲突拒绝（D8：不 overwrite，预览先行）；
  导出→再导入 round-trip 字节近似（注释段/raw 透传保真）。

---

## 七、分批落地

| 批 | 内容 | 交付物 |
|---|---|---|
| **P1** | `ac-tavern-core` 纯库 | 格式矩阵归一 + matchKey/entryTriggered/selectForInjection + composeAgentMd + PNG tEXt 读/写 + 单测（PNG fixture 程序化构造：手写签名+IHDR+tEXt+IEND，不引图片库） |
| **P2** | `ac-lorebook` 行 | LorebookService（双层存储/写口/无缓存直读）+ agentGate 注入 + settings + extension 自述 + 4 个 RPC + yml/TREE 挂载 + 行测试 |
| **P3** | `ac-charcard` 行 | parse/import/export + multipart 路由 + 预设守卫 + 头像/书联动 + webui 入口（名册「导入角色卡」文件流 + Agent 卡「导出角色卡」）+ 行测试 |
| **P4**（后议） | 增强 | 开场白会话种子（singles 创建预填 first_mes）、递归扫描、probability、load_lorebook 工具（load_skill 同款）、webui 书编辑器 |

每批收口跑 `pnpm typecheck && pnpm test`，P2/P3 后 `pnpm smoke` 端到端。

---

## 八、裁决点（带推荐，实施前可复议）

| # | 决策 | 选项与推荐 |
|---|---|---|
| D1 | 包划分 | **推荐三包**（core 纯库 + lorebook 行 + charcard 行）：inject 面不同、装配自由、纯库可复用；单行大包会强行耦合「导入编排」与「运行时注入」两类生命周期 |
| D2 | 世界书存储 | **推荐 fs 空间双层**（全局 `<root>/lorebooks` + 专用空间 `files/<id>/lorebooks`）：对齐 skill 双层与 memory fs 收敛，Agent 可经 fs 工具自维护；agentStore entry 方案败于 Agent 不可自编辑 + 大 JSON 进 config 族目录语义不符 |
| D3 | 卡 tags 映射 | **推荐不映射** `AgentConfig.tags`（能力门禁词表，卡标签是内容分类——映射 = 意外授予工具能力）；落 AGENT.md 元信息段 |
| D4 | 原卡提示词 | **推荐默认不激活**（AGENT.md 收录章节）：system_prompt/post_history_instructions 常含越狱模板，导入即激活 = 未审 prompt 直达 system；备选「system_prompt 非空 → AgentConfig.system」列为导入弹窗可选开关（P4） |
| D5 | 开场白承载 | **推荐 P1 落 AGENT.md 章节**；singles 创建时预填 first_mes 为会话首条消息 = P4（涉及 singles 域写路径，另议） |
| D6 | order 语义 | 推荐「数值大 = 优先」；实施时对照 ST 源码校准方向（ST insertion order 与 UI 呈现关系有版本史），纯库单点改向零成本 |
| D7 | 未实现的 ST 语义 | probability（随机注入破坏 KV 字节稳定性——同触发集同字节是本域红线）/ vectorized / 递归族 / position / depth：**首期全不实现**，`raw` 透传保 round-trip |
| D8 | id 冲突策略 | **推荐 dry-run 预览强制先行 + 冲突即拒**（错误文案带建议 id：`<id>-2`）；不做 overwrite（重导入 = 新 id 或先删旧） |
| D9 | 压缩文本块 | 首期 tEXt only（`chara`/`ccv3`）；zTXt 遇到真实样本再补（node:zlib 可用，非技术障碍） |
| D10 | 注入块位置 | system 末尾统一 `<world_book>` 块；ST position/depth 不还原——多点注入面扩大 KV 漂移 + 组装器复杂度，收益首期不成立 |

---

## 九、影响面清单（实施时照此展开）

```
src/ac-tavern-core/             新纯库（package.json 无 agentchat.plugin 标记）
src/ac-lorebook/                新行包（service.ts + index.ts + tests/）
src/ac-charcard/                新行包（index.ts + tests/）
src/cordis.yml                  +2 行（id: lorebook / charcard）
src/ac-app/src/index.ts         TREE +2 行（两表行集一致）
src/README.md                   契约归属总表 +lorebook 行；布局图 +2 行；头部索引加本文档
src/webui/src/api/              charcard parse/import/export 客户端封装
src/webui/（名册/AgentPane）     「导入角色卡」「导出角色卡」入口（P3）
既有域（core 四层/agents/admin/store/web-api）   零改动
```

---

## 十、测试计划

- **core 单测**：PNG fixture 构造器（签名/IHDR/tEXt×2/IEND 拼字节）→
  v1/v2/v3/损坏 CRC/无关键字/超限矩阵；world_info 与 character_book
  归一矩阵（selectiveLogic 四态、disable、constant、大小写）；matchKey
  拉丁整词 vs CJK 子串边界；selectForInjection 预算/截断/constant 优先；
  composeAgentMd golden 锁字节。
- **lorebook 行测试**（boot 脚手架 + mock 行，router.test.ts 姿势）：
  注入块落位与字节、scanDepth 窗口、agentGate 停用（settings.enabled=false
  / 全局层）、whitelist 过滤、fs 直改即时可见（写文件后下一 run 生效）、
  dispose 回收（监听器摘除）。
- **charcard 行测试**：临时数据根真行 boot——导入产物断言（config.json/
  AGENT.md/avatar/书文件四件套）、预设 id 拒绝、id 冲突拒绝、JSON 粘贴
  路径、导出 round-trip（导出 JSON → 再 parse 字段等价）。

---

## 十一、风险与边界

1. **Prompt 注入面**：卡/书内容 = 用户主动导入的不可信文本，进 system
   与 persona 同信任级（导入即信任声明）；D4 默认不激活越狱字段是首道
   缓解，导入预览展示完整字段是第二道。
2. **PNG 解析安全**：仅 chunk 字节扫描、不解码像素、零原生依赖；三层
   护栏（文件/chunk 数/tEXt 长度上限）防畸形文件；CRC 跳过是兼容性取舍
   （不构成完整性承诺——卡内容本就不受信）。
3. **性能**：匹配 = O(entries × keys × 窗口)，千级条目 × 短窗毫秒级；
   注入每次直读文件（对齐 memory 无缓存）；不做向量检索（D7）。
4. **KV 前缀成本**：触发集逐轮漂移 = 逐轮 system 变化（世界书固有语义，
   ST 同款）——已在 §5.2 按 M21 口径显式声明并接受；预算内确定性排序保
   「同状态同字节」。
5. **词汇防撞**：服务键 `lorebook` 已查契约归属总表未占用；settings 键
   与行名同词；书目录 `lorebooks/` 与 `skills/` 平级不冲突。

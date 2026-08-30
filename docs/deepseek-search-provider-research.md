# 研究笔记：为 AgentChat 新增 DeepSeek 搜索 Provider

> **状态：已实施**（见第三节改动清单，全部落地）。新增
> `src/web/web/src/web-search/deepseek.ts` + 单测 `src/web/web/tests/deepseek.test.ts`（12 用例全过）。
> 实施时额外发现并处理的接线点：`loader.ts` 的 `resolveSearchPool` hasApiKey 判断与
> `collectConfigSecrets` 脱敏列表也需补 `deepseekApiKey`；`tools.ts` 的 provider
> 选择补了"按 key 字段推断 + 池 default 条目回退"（否则默认池设 deepseek 而 Agent
> 未显式配置时不生效）。
>
> **追加修复（池"设为默认"不生效 bug）**：测试反馈切 deepseek 后返回 provider 仍为
> tavily。根因是全局 `tool.web_search` ns 残留旧版写入的显式 `provider: "tavily"`
> （连同 `quota`/`creditsFile` 死字段），解析优先级高于池 `default:true`，于是
> "在全局配置里设默认搜索项"被静默遮蔽。修复分两层：
> 1. 数据层：全局 ns 改为 `{"$ref": "deepseek"}`（已热重载生效）；
> 2. UI 层（防复发）：`applySearchPoolDefault`（webui settings/schema.ts）在池每次
>    更新时把全局 ns 同步指向默认条目——剥离遮蔽字段与死字段、保留中性覆盖；
>    SettingsPanel 搜索池 handler 接线；`tools.ts` 池回退对齐 loader 语义
>    （default 优先、无则首项）。单测 `src/ui/webui/tests/search-pool-default.test.ts`。
>
> **再追加（LLM 模型池同构断层修复）**：全局 `llm` 存在完全相同的遮蔽问题，且多一个
> 放大器——GET /api/config 会把 `$ref` 展开成完整对象（`{$ref, provider, model, ...}`），
> 而 `saveGlobal` 此前 POST 原始对象（`sanitizeGlobalConfig` 只用于 dirty 快照，写盘
> 未接线），展开对象被原样写回 config.json 后即冻结在旧条目上。修复：
> 1. `applyLlmPoolDefault` 与搜索池共用核心（`collectKeepOverrides`）：重写全局 llm
>    为 `{$ref: 默认条目}`，遮蔽字段（provider/model/base_url/api_key）剥离、目标条目
>    自带字段丢弃（防旧条目 reasoning_effort 反客为主）、与旧条目值相同的字段视为
>    GET 展开残留丢弃、其余视为用户调优保留；
> 2. `saveGlobal` 改为 POST `sanitizeGlobalConfig(...)`：$ref 折叠防展开回写
>    （该函数 llm 分支同时修正——显式内嵌对象不再被误删，可能是非池独立配置）；
> 3. SettingsPanel 模型池 handler 接线 `onLlmPoolsUpdate`。
> 单测 `src/ui/webui/tests/llm-pool-default.test.ts`（12 用例，含真实池配置端到端
> 冒烟：展开冻结对象 → 纯 {$ref} → resolveLLMPool 正确解析新默认）。
>
> **再追加（content 为空的根因与修复）**：实测 DeepSeek 响应发现两个硬事实——
> ① `web_search_result` 项只有 `title/url/page_age` + `encrypted_content`（**密文**，
> 仅模型服务端可解，客户端拿不到明文）；② text 块 **不返回 `citations[]`**，DSH 那套
> "从 cited_text 回填 snippet"的路径在 DeepSeek 实际响应下永远为空。修复：把固定指令
> 升级为**结构化输出协议**——搜索完成后要求模型按 `SOURCE: <url>` / `SUMMARY: <2-3 句
> 摘要>` 逐源输出（模型能读解密后的页面内容），末尾 `ANSWER: <综合段>`；provider 用
> 逐行状态机（`parseSourceSummaries`）按 URL 解析回填每条结果的 `content`，
> `extractAnswer` 提取 ANSWER 段作为 `answer`（无标记时回落最后一个 text 块）。
> citations 回填保留为 snippet 首选（DeepSeek 日后补齐该字段则自动优先）。
> 模型只对它引用的源产出 SUMMARY，未引用的源 content 为空但 answer 覆盖综合信息；
> content 软上限 1200 字符。单测扩至 18 用例（含解析器与实测形态回填），
> 真实 API 端到端验证 content/answer 均有实质内容。
>
> 结论先行：完全可行，且 AgentChat 的 provider 架构为此预留了清晰接缝。
> 参考实现是 DSH（DeepSeek Harness）自带的 `@deepseek-ai/dsh-web-search-deepseek` 包
> （本机位于 `C:\Users\xiaofeng\node_modules\@deepseek-ai\dsh-web-search-deepseek`）。
> DeepSeek **没有独立搜索端点**，DSH 的做法是调用 DeepSeek 的
> **Anthropic 兼容 Messages API** 并启用原生 `web_search_20250305` 服务端工具，
> 从返回的结构化 `web_search_tool_result` 块解析搜索结果。

---

## 一、DSH 的实现机制（`dsh-web-search-deepseek`）

### 1.1 核心原理

DeepSeek 不像 Tavily/Exa/Perplexity 那样提供专用检索端点，而是提供一个带原生联网搜索
server tool 的 Messages API。一次搜索 = 一次完整模型调用：

- **端点**：`POST {baseURL}/messages`，默认 baseURL =
  `https://api.deepseek.com/anthropic/v1`（Anthropic 兼容层，**不是**
  `https://api.deepseek.com` 这个 OpenAI 兼容层——LLM 聊天用的那个）
- **请求体**：
  ```json
  {
    "model": "deepseek-v4-flash",
    "max_tokens": 4096,
    "messages": [{
      "role": "user",
      "content": [{ "type": "text", "text": "Perform a web search for the query: <query>" }]
    }],
    "tools": [{ "type": "web_search_20250305", "name": "web_search", "max_uses": 5 }]
  }
  ```
- **请求头**：`x-api-key: <key>`、`authorization: Bearer <key>`、
  `anthropic-version: 2023-06-01`、`content-type/accept: application/json`
- **模型默认**：`deepseek-v4-flash`（轻量快档，搜索场景够用且便宜）

### 1.2 响应映射（关键逻辑）

响应 `content[]` 是块数组，DSH 的解析规则：

1. 过滤出 `type === "web_search_tool_result"` 的块；**一个都没有 → 直接报错**
   （严格模式，绝不退化去模型散文里抠 URL）
2. 块内 `content[]` 中 `type === "web_search_result"` 的项携带
   `url` / `title` / `page_age`（注意：**没有内联 snippet**）
3. snippet 的真实来源是各 `type === "text"` 块的 `citations[]`：
   每个 citation 有 `url` + `cited_text`，按 url 建映射（首个出现优先），
   再回填到对应搜索结果的 `snippet`
4. 按 `url` 去重（`max_uses > 1` 时同一页面可能多次出现）
5. 模型生成的散文**不被信任为答案**（`answer` 不产出）
6. API 没有"结果条数"参数，`maxResults` 由调用方本地截断

### 1.3 凭据与配置

| 键 | 默认 | 说明 |
|---|---|---|
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 与 LLM 适配器**共用同一个 key**（无新秘密） |
| `baseURL` | `https://api.deepseek.com/anthropic/v1` | 环境变量 `DEEPSEEK_SEARCH_BASE_URL`；**不要复用** LLM 的 `DEEPSEEK_BASE_URL` |
| `model` | `deepseek-v4-flash` | Anthropic 格式模型名 |
| `maxTokens` | `4096` | 单次请求生成 token 上限 |
| `maxUses` | `5` | 服务端搜索工具最多使用次数 |

### 1.4 成本特性（务必知晓）

- 一次搜索 = 一次完整模型回合：**有输入/输出 token 计费 + 模型回合延迟**，
  比 Tavily 这种纯检索端点重
- 结果条数不可控（最多 `max_uses × 每次若干条`），本地截断
- 未被引用的页面没有 snippet（只有被 `citations` 引到的 url 才有 `cited_text`）

---

## 二、AgentChat 现有搜索 Provider 架构

代码位置：`src/web/web/src/`（`@agentchat/web` 插件包）。

```
src/web/web/src/
├── tools.ts                  # web_search 工具 + PROVIDER_REGISTRY + key 解析链
└── web-search/
    ├── types.ts              # SearchProvider 接口（标准化输入/输出）
    ├── tavily.ts             # API-key 型 provider 模板（POST + Bearer）
    ├── serpapi.ts
    ├── brave.ts
    └── duckduckgo.ts         # 无 key 型 + score 合成参考
```

### 2.1 接口契约（`web-search/types.ts`）

```ts
interface SearchProvider {
  readonly id: string;            // 注册名，如 'tavily'
  readonly label: string;         // 展示名
  readonly description: string;
  validateConfig(cfg: ProviderConfig): void;      // 缺 key 时 throw
  search(params: SearchParams, cfg: ProviderConfig): Promise<SearchResponse>;
  configuration: unknown[];       // 目前均为 []（UI schema 另有来源，见 2.3）
}
```

标准化输出 `SearchResponse`：`{ query, results: {title,url,content,score,raw_content?}[], answer?, response_time, credits_used? }`。

### 2.2 API Key 解析链（`tools.ts` `resolveApiKey`，按优先级）

1. 命名空间配置直填字段（如 `cfg.tavilyApiKey`）→ **每个 provider 一个硬编码字段名**
2. 命名空间 `cfg.$ref` → 凭据库 `getCredential('__global__', 'searchpool:<池名>')`
3. `cfg._searchProviders` 池中 `default: true` 的条目 → 同上
4. 凭据库直查 `getCredential('__global__', providerId)`
5. 环境变量（`envMap`：tavily/serpapi/brave 各一个）→ **需补 `DEEPSEEK_API_KEY`**

### 2.3 设置 UI 的 provider 清单来源（schema 驱动，无需改 Vue）

- 后端：`src/boot/boot/src/llm-schemas.ts` 的 `SEARCH_PROVIDER_SCHEMAS`
  （`Record<providerId, ConfigField[]>`）
- 端点：`GET /api/plugins/search-schemas`（`src/host/server/src/api/plugins.ts`）
- 前端：`PoolManager.vue` 用 schema keys 动态生成下拉 + 表单字段（**零硬编码**，
  加了 schema 就自动出现在"搜索引擎"池里）

### 2.4 Key 的落盘/掩码链（`src/host/server/src/api/config.ts`）

- `POST /api/config`：把池条目里的 apiKey 字段**提取**到凭据库
  `searchpool:<池名>`，config.json 不存明文。apiKey 字段名是硬编码三元判断
  （`tavilyApiKey/serpapiApiKey/braveApiKey`）→ **两处都要补 `deepseekApiKey`**
- `GET /api/config`：回填 `••••••••` 掩码（同一硬编码列表）
- 前端 `src/ui/webui/src/settings/schema.ts` `sanitizeGlobalConfig`：保存前清理
  掩码残留（同一列表）→ **要补**

---

## 三、改动清单（按依赖顺序）

### ① 新建 `src/web/web/src/web-search/deepseek.ts`

实现 `SearchProvider`，移植 DSH 的 `mapAnthropicResponse` 逻辑：

```ts
import type { SearchProvider, SearchParams, SearchResponse, ProviderConfig } from './types';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';

export function createDeepSeekProvider(): SearchProvider {
  return {
    id: 'deepseek',
    label: 'DeepSeek 联网搜索',
    description: 'DeepSeek 官方联网搜索（Anthropic 兼容 Messages API + 原生 web_search 工具）',

    validateConfig(cfg) {
      if (!cfg.apiKey) throw new Error(
        '未配置 DeepSeek API 密钥。请在池条目的 API 密钥字段中设置（与 DeepSeek 模型共用同一 Key），' +
        '或设置环境变量 DEEPSEEK_API_KEY。可前往 https://platform.deepseek.com 获取。');
    },

    async search(params, cfg) {
      const extra = (cfg as any)._extra ?? {};          // baseURL/model/maxUses 经池配置传入（见 ②）
      const endpoint = `${extra.baseURL || DEFAULT_BASE_URL}/messages`;
      const body = {
        model: extra.model || 'deepseek-v4-flash',
        max_tokens: 4096,
        messages: [{ role: 'user', content: [
          { type: 'text', text: `Perform a web search for the query: ${params.query}` },
        ]}],
        tools: [{ type: 'web_search_20250305', name: 'web_search',
                  max_uses: extra.maxUses || 5 }],
      };
      // fetch：headers 含 x-api-key + authorization Bearer + anthropic-version: 2023-06-01
      //      redirect: 'error'（DSH 同款：拒绝重定向）
      // 映射（照搬 DSH）：
      //  - 无 web_search_tool_result 块 → throw（严格模式）
      //  - text 块 citations[] 的 url→cited_text 建 snippet 映射（首现优先）
      //  - 结果项 url 去重；content = snippet ?? ''；score 按名次递减合成
      //    （参考 duckduckgo：Math.max(0.9 - i*0.1, 0.1)）
      //  - answer = null（不信任模型散文，DSH 同款）
      //  - page_age → 可拼进 content 或丢弃（SearchResult 无日期字段）
      //  - include_domains/exclude_domains/time_range 等参数 API 不支持，忽略
      //    （duckduckgo 同样忽略不适用参数）
    },
    configuration: [],
  };
}
```

要点：
- `response_time` 用 `Date.now()` 差值（同 tavily）
- `credits_used: null`
- HTTP 非 2xx 时解析 `error.message` 附加到错误信息（DSH 同款）

### ② 注册与接线：`src/web/web/src/tools.ts`

```ts
import { createDeepSeekProvider } from './web-search/deepseek';

const PROVIDER_REGISTRY = {
  tavily: createTavilyProvider,
  serpapi: createSerpApiProvider,
  brave: createBraveProvider,
  duckduckgo: createDuckDuckGoProvider,
  deepseek: createDeepSeekProvider,          // ← 新增
};
```

- `resolveApiKey` 的 `cfgMap` 加 `deepseek: cfg.deepseekApiKey ?? ''`
- `envMap` 加 `deepseek: 'DEEPSEEK_API_KEY'`
- `makeWebSearchTool` 的 `wsCfg` 加透传 `deepseekApiKey: ns.deepseekApiKey`
  （如池条目要支持 baseURL/model/maxUses，还需把池条目其余字段并入
  `buildProviderConfig`——现状 `ProviderConfig` 只有 `apiKey`，最小改动是
  在 `ProviderConfig` 上加可选扩展字段）

### ③ UI Schema：`src/boot/boot/src/llm-schemas.ts`

`SEARCH_PROVIDER_SCHEMAS` 加：

```ts
deepseek: [
  { name: 'deepseekApiKey', label: 'DeepSeek API Key',
    description: '与 DeepSeek 模型池共用同一 Key（留空则用环境变量 DEEPSEEK_API_KEY）',
    type: 'password', default: '' },
  RESULTS_FIELD,
  { name: 'baseURL', label: 'API 地址',
    description: 'Anthropic 兼容端点（注意与模型聊天的 https://api.deepseek.com 不同）',
    type: 'text', default: 'https://api.deepseek.com/anthropic/v1' },
  { name: 'model', label: '搜索模型', description: '执行搜索的模型 ID',
    type: 'text', default: 'deepseek-v4-flash' },
  { name: 'maxUses', label: '最大搜索次数',
    description: '单次请求内服务端搜索工具最多使用次数', type: 'number', default: 5, min: 1, max: 10 },
],
```

加完即自动出现在设置 → 搜索引擎 → Provider 下拉（PoolManager 动态生成）。

### ④ Key 提取/掩码：`src/host/server/src/api/config.ts`（两处）

```ts
const apiKeyField = entry.tavilyApiKey !== undefined ? 'tavilyApiKey'
  : entry.serpapiApiKey !== undefined ? 'serpapiApiKey'
  : entry.braveApiKey !== undefined ? 'braveApiKey'
  : entry.deepseekApiKey !== undefined ? 'deepseekApiKey'   // ← GET 掩码处 + POST 提取处各补一次
  : null;
```

### ⑤ 前端掩码清理：`src/ui/webui/src/settings/schema.ts`

`sanitizeGlobalConfig` 的数组 `['tavilyApiKey','serpapiApiKey','braveApiKey']`
追加 `'deepseekApiKey'`。

### ⑥ 测试（可选但建议）

仿 `src/core/llm-factory/tests` 风格为映射函数写单测：mock 一个含
`web_search_tool_result` + `citations` 的响应，断言去重/snippet 回填/无结果块时
throw/名次 score。

---

## 四、设计决策与风险提示

| 决策点 | 建议 | 依据 |
|---|---|---|
| baseURL | 独立默认值，不复用 LLM 池的 `base_url` | DSH 明确区分：搜索走 Anthropic 兼容层，聊天走 OpenAI 兼容层，一个变量不能两用 |
| answer | 恒 `null` | DSH 不信任模型散文作为答案；AgentChat 的 `include_answer` 对该 provider 无效 |
| score | 名次递减合成 | 接口无相关性评分；duckduckgo 已有同款约定 |
| include/exclude_domains、time_range | 静默忽略 | API 无对应参数；duckduckgo 先例 |
| 结果为空 | throw 严格错误 | DSH 严格模式：无 `web_search_tool_result` = 原生搜索未触发，属异常而非空结果 |
| 成本 | UI description 提示"每次搜索消耗模型 token" | 一次搜索 = 一次完整模型回合，比 Tavily 贵且慢 |
| key 复用 | 与 DeepSeek LLM 池共用 `DEEPSEEK_API_KEY` | DSH 同款：同一 key 两个端点 |

## 五、工作量评估

- 新文件 1 个（`deepseek.ts`，约 150 行，大头是响应映射）
- 修改 4 个文件各 1~5 行（tools.ts / llm-schemas.ts / config.ts×2处 / webui schema.ts）
- UI **零改动**（PoolManager 全动态）
- 半天内可完成含单测

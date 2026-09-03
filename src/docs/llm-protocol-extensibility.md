# LLM 自定义协议扩展 —— 设计备忘（未实施）

> 状态：**备忘稿（用户立项意向，暂不实施——2026-09-01 记）**。背景：
> 池 v2 落地后（`llm-provider-model-plan.md` ✅），"自定义连接"仅支持
> OpenAI 兼容协议；本文档收录扩展为多协议（Anthropic / Gemini / Ollama
> 原生等）的目标形态与决策点，供后续优化时直接取用。

---

## 一、现状（三层"兼容格式"，已在役）

| 层 | 定义处 | 覆盖内容 | 协议耦合点 |
|---|---|---|---|
| 协议层 | `ac-openai-completions` `CompletionsOptions` | baseUrl / apiKey / defaultModel / **headers** / **timeoutMs** / fetchImpl | 类名即协议（OpenAI 兼容） |
| 请求层 | `ac-llm/src/contract.ts` `LlmChatInput` | model/messages/tools + 采样白名单透传 + 单次 api_key | 协议中立（`[key: string]: unknown` 透传） |
| 持久层 | `ac-llm-pool` `LlmPoolEntry` | base_url / defaultModel / models / api_key（凭据侧信道） | **ac-llm-pool 注册时硬编码构造 `OpenAICompletions`** |

两个已确认的缺口：
1. **小缺口**：池条目未透出协议层的 `headers`（自定义鉴权头，部分网关
   需要）与 `timeoutMs`——加两个可选字段即可，无架构影响；
2. **大缺口（本文档主题）**：协议写死为 OpenAI 兼容——非兼容端点
   （Anthropic 原生 `/v1/messages`、Gemini 原生 `generateContent`、
   Ollama 原生 `/api/chat` 等）无法经池配置，只能走适配器行
   （`templates/provider-row`，每协议一个手写行）。

## 二、目标形态（草案）

### 2.1 池条目增 `protocol` 字段（缺省 = openai-compat，零迁移）

```jsonc
// config.json llmProviders 条目
"my-claude": {
  "protocol": "anthropic",        // 缺省 'openai-compat'——存量条目零改动
  "base_url": "https://api.anthropic.com",
  "defaultModel": "claude-sonnet-4-5",
  "models": ["..."]               // 各协议自己的清单端点拉取
}
```

### 2.2 协议注册表：name → { 工厂, 探测, 清单端点 }

- **纯库形态**（每协议一个，零 cordis 依赖，对齐 ac-openai-completions）：
  `ac-anthropic-completions` / `ac-gemini-completions` / …——返回形状
  结构化兼容 `LlmProvider`（stream 分片契约：delta/reasoning/toolCalls/
  finish/usage——协议库负责把原生响应映射成这套中性分片）。
- **注册表住 ac-llm-pool**（域 owning 行）：`PROTOCOLS: Record<string,
  { create(entry): LlmProvider; listModels(baseUrl, apiKey): Promise<string[]> }>`；
  `desiredProviders` → `registerOne` 按 `entry.protocol ?? 'openai-compat'`
  分发构造。**首期内置表即可，不引入运行时注册面**——动态协议 =
  动态插件行注册 provider（既有 `provides.llmProviders` 通道），两机制不叠加。
- `LlmRegisterMeta.baseUrl` 等诊断不变；stats 可加 `protocol` 透出。

### 2.3 免注册探测按协议分发

`llm/probe-models { base_url, api_key, protocol? }` → 注册表分发到对应
协议的 `listModels`（Anthropic `/v1/models`、Gemini `/v1beta/models`、
Ollama `/api/tags`——各协议清单端点不同，形状由协议库归一）。
PoolManager 弹窗"提供方"下拉增协议维度（内置提供方自带协议；自定义
需先选协议再填地址）。

### 2.4 其余不变量（明确锁定）

- **请求层零改动**：`LlmChatInput`/`LlmChatCall`/`llm/before-chat` 凭据
  注入链协议中立——`api_key` 传输层键由各协议库自行消费（header 形态
  协议库内定：Bearer vs x-api-key）。
- **凭据链不变**：`pool:<name>` 单级锚定连接，与协议无关。
- **路由不变**：name@model / 裸名精确>前缀，与协议无关。
- **usage 归一**：各协议库负责把原生用量映射成 `LlmUsage`（缓存字段
  归一已 openai-completions 有先例）。

## 三、待裁决策点（实施时再定）

| # | 决策 | 选项与倾向 |
|---|---|---|
| D1 | 协议库命名与归属 | `ac-<proto>-completions` 纯库 ×N（对齐 openai 先例）；不合并成单包多协议（单包会重新引入"协议住在框架里"的耦合） |
| D2 | reasoning/toolCalls 分片映射深度 | 各协议原生能力差异大（Anthropic thinking 块、Gemini functionDeclarations）——首期只保 delta/text/finish/usage 映射，推理/工具分片按协议逐个补 |
| D3 | headers / timeoutMs 小缺口是否同批 | 倾向同批（都是 `LlmPoolEntry` 可选字段 + 工厂透传，一次动池条目形状） |
| D4 | 协议字段校验 | 未知 protocol → 注册时 fail-loud（对齐"缺 base_url 跳过+warn"风格，但协议错是硬错不是残留） |
| D5 | 保留字表 | `BUILTIN_LLM_PROVIDER_NAMES` 维持现状；协议名（openai-compat/anthropic/…）建议另设小表防池条目协议名与未来内置提供方撞语义 |

## 四、影响面清单（实施时照此展开）

```
ac-llm-pool/src/index.ts        PROTOCOLS 注册表 + protocol 分发 +（D3 条目字段）
ac-<proto>-completions/         新纯库 ×N（stream/listModels/usage 归一）
ac-web-api/src/index.ts         probe-models 增 protocol 参数
ac-llm（可选）                  LlmRegisterMeta.stats 透 protocol
webui/settings/api.ts           LLM_PROVIDER_TEMPLATES 增协议维度
webui PoolManager.vue           提供方下拉/自定义流程带协议选择
scripts/migrate-llm-pool-v2.ts  无需迁移（缺省 openai-compat）
docs/llm-provider-model-plan.md 落地后补"协议扩展已实施"批注
```

## 五、非目标（显式不做）

- 每协议的采样参数差异校验（透传白名单维持协议中立）；
- 运行时动态协议注册（走动态插件行通道，见 §2.2）；
- 协议级重试/降级策略（属调用编排域，不属连接定义域）。

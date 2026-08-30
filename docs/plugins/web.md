# @agentchat/web
> 包路径 `src/web/web` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
网络工具包（web_search + browser），领域独立。`web_search` 走 4 个可插拔搜索 provider（Tavily/SerpAPI/Brave/DuckDuckGo），默认 Tavily，API Key 支持 config → 凭据存储 → 环境变量三级解析；`browser` 操作真实 Chromium（Python 守护进程），支持单动作与 `steps` 批量动作序列。

## 目录（关键源文件 + 一句话）
| 文件 | 职责 |
| --- | --- |
| `plugin.ts` | cordis 插件行：`registerWebTools(ctx.tools, name)` |
| `register.ts` | `registerWebTools`：注册工厂 `(config, services) => makeWebTools` |
| `tools.ts` | `makeWebSearchTool` / `makeBrowserTool` / provider 注册表与 Key 解析 / browser 守护进程 |
| `web-search/types.ts` | `SearchProvider` 接口 + `SearchParams`/`SearchResponse`/`SearchResult` |
| `web-search/tavily.ts` | Tavily provider（POST + Bearer） |
| `web-search/serpapi.ts` | SerpAPI provider（GET，Google/Bing 结构化结果） |
| `web-search/brave.ts` | Brave Search provider（GET + `X-Subscription-Token`） |
| `web-search/duckduckgo.ts` | DuckDuckGo Instant Answer（免费、无需 Key） |
| `index.ts` | re-export tools + register + web-search/types |

## 插件行
| 模块文件 | 插件 name | inject | 注册内容 |
| --- | --- | --- | --- |
| `src/web/web/src/plugin.ts` | `agentchat-web-tools` | `['tools']` | `tools.registerFactory(owner, (config, services) => makeWebTools(config, services))` → **web_search + browser** |

## 提供的能力
| API | 说明 |
| --- | --- |
| `registerWebTools(tools, owner)` | 注册网络工具工厂（`services` 传入 `ToolContext`，取 `searchProviders`） |
| `makeWebSearchTool(config, services)` | web_search 工具 |
| `makeBrowserTool(config)` | browser 工具 |
| `makeWebTools(config, services)` | `[makeWebSearchTool, makeBrowserTool]` |
| `PROVIDER_REGISTRY` | `tavily` / `serpapi` / `brave` / `duckduckgo` 工厂注册表 |
| `createTavilyProvider()` 等 | 各 provider 工厂 |

## 工具参考
| 工具 | name | label | requires | ns | 主要参数 | 行为要点 |
| --- | --- | --- | --- | --- | --- | --- |
| 搜索 | `web_search` | 网络搜索 | `['base']` | `tool.web_search` | `query`（必填）、`description`（任务列表展示） | 读 `tool.web_search` ns + `services.searchProviders` 构建 wsCfg → 选 provider → `validateConfig` → `search` → 返回 `{status,provider,data:{query,results,answer,response_time,credits_used}}`；extractLabel 优先取 description。**2026-08-20 简化**：主用 DeepSeek 搜索（仅消费 query），其余参数（max_results/search_depth/topic/time_range/include_*/exclude_domains）移出 schema——provider 级调优走命名空间配置（defaultResults/defaultDepth/defaultTopic/rawContentMaxLen），execute 层兼容旧参数（其他 provider 部署可用） |
| 浏览器 | `browser` | 浏览器 | `['base']` | — | `action`（open/click/type/press/content/screenshot/html/eval/close）、`url`、`selector`、`text`、`key`、`name`、`js`、`steps[]`（每项含上述字段 + `repeat` 1–20、`delay_ms`）、`continue_on_error` | `steps` 非空走批量；单动作发 JSON 行命令给 Python 守护进程 `files/shared/scripts/browser_daemon.py`；单命令 35s 超时；screenshot 附加 `relPath`；close 置空 daemon |

## 关键契约 / API
### SearchProvider 接口（web-search/types.ts）
```ts
interface SearchProvider {
  id: string; label: string; description: string;
  validateConfig(cfg: ProviderConfig): void;
  search(params: SearchParams, cfg: ProviderConfig): Promise<SearchResponse>;
  configuration: unknown[];
}
```
`ProviderConfig = { apiKey }`；`SearchParams` 字段即 web_search 工具参数；`SearchResponse` 含 `query/results/answer?/response_time/credits_used?`。

### API Key 解析顺序（resolveApiKey）
1. `tool.web_search` 命名空间内的 `tavilyApiKey` / `serpapiApiKey` / `braveApiKey`（DuckDuckGo 恒为空）。
2. `tool.web_search.$ref` → 凭据 `searchpool:<$ref>`。
3. `services.searchProviders` 池中带 `default: true` 的条目 → 凭据 `searchpool:<entryName>`。
4. 全局凭据直接键 `<providerId>`。
5. 环境变量 `TAVILY_API_KEY` / `SERPAPI_API_KEY` / `BRAVE_API_KEY`。

### 默认合并池规则
`makeWebSearchTool` 构建 wsCfg 时把 `ns` 配置与默认值合并，并注入 `_searchProviders: services.searchProviders ?? {}`；provider 缺省为 `tavily`（`DEFAULT_PROVIDER`）。额度字段：当前源码**没有 quota/creditsFile**；Tavily 返回 `credits_used`（来自 `usage.credits`），其余 provider 为 `null`。

### 4 个 Search Provider 差异
| Provider | 端点/方法 | Key | 特点与差异 |
| --- | --- | --- | --- |
| Tavily | `https://api.tavily.com/search` POST | Bearer | 面向 AI Agent；`search_depth`、`topic`、`include_answer: 'advanced'`、`include_raw_content`；`credits_used` 来自 usage |
| SerpAPI | `https://serpapi.com/search` GET | `api_key` 查询参数 | `engine=google`（topic=news → `google_news`）；`num`；`hl=zh-CN`、`gl=cn`；`time_range` → `tbs:qdr:*`；`include_domains` 用 `site:` OR 拼进 q；answer 来自 answer_box/knowledge_graph |
| Brave | `https://api.search.brave.com/res/v1/web/search` GET | `X-Subscription-Token` | `count=min(max_results,20)`；`country=CN`、`search_lang=zh`；`freshness` 映射时间范围；advanced → `extra_snippets=true`；news → `result_filter=news`；raw_content 来自 extra_snippets |
| DuckDuckGo | `https://api.duckduckgo.com` GET | 无需 Key | Instant Answer：Abstract/Answer/RelatedTopics/Infobox；无结果时返回搜索链接兜底 |

### browser 守护进程要点
- 启动：`python <workspace>/files/shared/scripts/browser_daemon.py`，stdout JSON 行协议，`ready` 前缓存 boot 状态；多代并发退出按 `daemonGen` 忽略旧代。
- 单动作与批量都经 `send()` 写 stdin；`steps` 支持 `repeat`（默认 1，最大 20）与 `delay_ms`；`continue_on_error=true` 时错误记为结果继续。

## 配置
- `tool.web_search`：`provider`（默认 `tavily`）、`tavilyApiKey` / `serpapiApiKey` / `braveApiKey`、`$ref`（凭据池引用）；默认值 `defaultResults=5`、`defaultDepth='advanced'`、`defaultTopic='general'`、`rawContentMaxLen=2000`。
- 凭据存储：`@agentchat/agents` 的 `getCredential('__global__', key)`（全局搜索池凭据）。
- browser 无命名空间配置；Python 脚本路径固定在 `<workspace>/files/shared/scripts/browser_daemon.py`。

## 与其他插件的关系
- 依赖（package.json）：`@agentchat/agent-loop`、`@agentchat/agents`、`@agentchat/toolkit`、`@agentchat/tools`、`@agentchat/util`、`@agentchat/cordis`、`@agentchat/agent-config`。
- 使用方：boot/host 装配层把 `agentchat-web-tools` 加入 presets/目录；`ToolContext.searchProviders` 由装配层（L5）注入搜索 provider 池。

## 测试
package.json 仅 `typecheck`（tsc --noEmit），无 test 脚本与本包测试文件。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)

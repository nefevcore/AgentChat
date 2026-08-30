# AgentChat 文本 + 视觉融合方案（图像理解优先，预留生成契约）

> 调研来源：
> - DeepSeek 图像理解指南 <https://api-docs.deepseek.com/zh-cn/guides/vision>（deepseek-v4-flash-vision-exp，仅理解、无生成）
> - GLM 对话补全 API <https://docs.bigmodel.cn/api-reference/模型-api/对话补全>（含视觉模型分支，OpenAPI 规范 `docs.bigmodel.cn/openapi/openapi.json`）
> - GLM-4.6V / GLM-5V-Turbo 模型页、DeepSeek 模型与价格页
>
> 结论先行：**以 OpenAI 兼容 `content blocks`（`[{type:"text"},{type:"image_url"}]`）为两家公共分母，
> AgentChat 主推 GLM 视觉矩阵做 Agent 主力（glm-5v-turbo），DeepSeek vision 做批量/GIF/WebP 便宜补充；
> 消息契约在 `AgentMessage` 上扩展 `attachments`（content 保持纯文本），provider 层按能力位分叉渲染；
> 生成能力只留契约不实现。**

---

## 1. 两家视觉模型事实对比

### 1.1 模型矩阵

| | DeepSeek | GLM（智谱） |
|---|---|---|
| 视觉模型 | `deepseek-v4-flash-vision-exp`（实验版，唯一） | `glm-5v-turbo`（多模态 Coding 基座，200K 上下文/128K 输出）、`glm-4.6v`（106B 视觉推理）、`glm-4.6v-flashx`（9B 轻量高速）、`glm-4.6v-flash`（**完全免费**）、`glm-4v-flash`（免费，限 1 图、不支持 base64）、`glm-4.1v-thinking-flash/flashx` |
| 端点 | `https://api.deepseek.com`（OpenAI 兼容）+ `/anthropic` + Responses API | `https://open.bigmodel.cn/api/paas/v4`（OpenAI 兼容）；编码套餐专属端点 `/api/coding/paas/v4`（视觉模型是否享套餐额度**需验证**） |
| 输入模态 | 图像 + 文本 | 图像、视频（`video_url` ≤200MB mp4/mkv/mov）、文件（`file_url`：pdf/word/xlsx/pptx/jsonl/txt，≤50 个，**不能与 image_url/video_url 混用**）+ 文本 |
| 输出 | 纯文本 | 纯文本 |
| 上下文 | 1M，输出 384K | 5V-Turbo 200K/128K；4.6V 系列 128K |
| 思考模式 | 支持开/关（默认开） | 4.6V/5V-Turbo 支持开/关；glm-4.5v 为强制思考（现有 `FORCED_THINKING_PATTERN` 已覆盖） |
| 工具调用 | 支持（含 JSON Output） | 支持，且 GLM-4.6V/5V-Turbo **原生多模态 Function Calling**（截图可作为工具输出再次理解，Agent 闭环友好） |
| 价格 | 与 deepseek-v4-flash 同价：输入缓存未命中 1.5 元/M（空闲）～3 元/M（高峰），输出 4.5～9 元/M；**每图 token 封顶 384**（自动缩放到约 800×800 等效） | 按 token 计费，图片按分辨率换算；`glm-4.6v-flash` / `glm-4v-flash` 免费；5V-Turbo 价格见官方价格页 |
| 并发 | 2500 | 按套餐等级 |

### 1.2 图像输入协议（关键差异，实现必须分叉）

| 维度 | DeepSeek | GLM |
|---|---|---|
| 内容块 | `{type:"image_url", image_url:{url, detail?}}`、`{type:"file", file_id \| file_data}` | `{type:"image_url", image_url:{url}}`（schema `additionalProperties:false`，**只有 url 字段**） |
| base64 格式 | **必须** `data:image/jpeg;base64,<B64>`（data URL） | **纯 base64 字符串，不带 `data:` 前缀**（官方 SDK 示例 `url: img_base`） |
| `detail` 档位 | `low`（缩到 512×512 省 token）/`high`/`original`/`auto` | **不支持，传了可能 400**（schema 层禁止额外属性） |
| 图片格式 | JPEG/PNG/GIF/WebP（按文件实际内容嗅探，不看扩展名） | jpg/jpeg/png **三族**，无 GIF/WebP |
| 单图大小 | base64/URL ≤32MB；Files API `file_id` ≤64MB | ≤5MB（base64 或 URL），像素 ≤6000×6000 |
| 单请求图数 | ≤600 张（≥15 张时单边像素限 4096） | 5V-Turbo/4.6V 系列 ≤50 张；glm-4v-flash 仅 1 张且仅 URL |
| 请求体 | ≤48MB（内联计） | —（按单图 5MB×50 保守推） |
| URL 输入 | http(s) 外链，URL ≤8192 字符、60s 内下载完 | http(s) 外链 |
| 图片复用 | Files API `file_id`（跨请求复用、免重复上传） | 无对应物（知识库/文件解析 API 是另一条路） |
| 图片所在消息 | 仅 `user`（system/assistant 带图 → 400） | 仅 `user`（OpenAPI 中多模态 content 只出现在用户消息分支） |
| token 计费 | 每图**封顶 384 token**，小图放大到 ~384×384、大图缩到 ~800×800 等效 | 按分辨率换算，无封顶说明（免费模型忽略） |

> 共同点：都走 `POST /chat/completions`、`content` 为块数组、`image_url.url` 语义一致、图片仅 user 消息、流式/工具调用/usage 结构一致 —— **这足以用一套内部契约覆盖两家**。

---

## 2. AgentChat 现状盘点（改动锚点）

| 环节 | 现状 | 视觉缺口 |
|---|---|---|
| 上传 | `src/ui/webui/src/components/ChatInput.vue` → `POST /api/upload`（`src/host/server/src/api/upload.ts`，multer 50MB，落盘 `files/<agentId>/_tmp/`，返回 hash/path/mime） | **链路完好可复用**，图片已被正确落盘 |
| 发送 | `chat.send` 的 `attachments/files` 在 `src/host/server/src/ws/handler.ts:727-740` 被拼成文本引用 `[用户上传了文件：./files/...]` | 图片与文本文件不区分，模型只看到路径 |
| 消息契约 | `AgentMessage.content` 为纯 string（`src/core/types/src/index.ts:108`），`LLMRequestMessage = AgentMessage` | 无多模态承载位 |
| 循环装配 | `src/core/agent-loop/src/loop.ts:239` `system + history + currentMessage` 直传 | 天然可透传新字段 |
| Provider | `OpenAIChatLLM.toProviderMessages`（`src/core/llm-openai/src/openai.ts:507`）恒产出 `content: string`；GLM/DeepSeek 子类只覆写 `buildRequestBody`（`src/core/llm-glm/src/glm.ts:97`） | 无 content blocks 渲染、无能力声明 |
| 模型池 | provider 枚举 `openai|deepseek|glm|ollama`（`src/core/llm/src/contracts.ts:31`），schema 在 `src/boot/boot/src/llm-schemas.ts` | 无 `vision` 能力位 |
| 文件工具 | `read` 工具（`src/fs/fs/src/tools.ts:41`）按 utf-8 读文件 | **读图片会产出乱码**（缺二进制防护，顺手要修） |
| 浏览器 | `src/web/web/src/tools.ts` 已有 `screenshot` 动作，截图落盘并回传 relPath | 截图目前只能人看，模型看不了（二期闭环点） |
| 工作区 API | `/api/workspace/file` 对图片返回 base64（前端预览用） | 前端展示已就绪 |

---

## 3. 融合方案设计

### 3.1 核心原则

1. **公共分母协议**：内部统一用 OpenAI 风格 content blocks 作为"渲染目标"，附件原始数据（路径/mime/hash）作为"存储格式"，provider 负责两者间的翻译。
2. **能力位 + 优雅降级**：模型池声明 `vision` 能力；不具备时图片自动降级为文本占位（现行为），不阻断、不报错。
3. **存储引用而非内联**：附件在 `AgentMessage` 上只存 `{kind, path, mime, hash, name, size}` 元数据；base64 在 provider 发请求那一刻才从磁盘读取。持久化体积不变、可审计、agent 可用 read 工具复读文件。
4. **生成只留契约**：`kind` 枚举与 `LLMResponse.artifacts` 字段本期只定义不实现。

### 3.2 消息契约扩展（`src/core/types/src/index.ts`）

```ts
/** 多模态附件（存储引用式：不内联 base64，发送时才读取） */
export interface MessageAttachment {
  id: string;                    // 短 id（消息内去重/引用）
  kind: 'image' | 'video' | 'audio' | 'file'
      | 'image-gen';             // ← 生成预留：模型产出的图（本期不实现）
  path: string;                  // 工作区相对路径（./files/<agentId>/_tmp/x.png）
  mime?: string;                 // 上传时的 mimeType（仅参考，嗅探为准）
  hash?: string;                 // /api/upload 已返回的 SHA-256
  name?: string;                 // 原始文件名
  size?: number;
  /** 生成产物预留（kind='image-gen' 时）：URL 或落盘 path + 产生它的 prompt */
  generated?: { url?: string; prompt?: string; model?: string };
}

export interface AgentMessage {
  // ...现有字段不动，content 仍为纯文本正文...
  attachments?: MessageAttachment[];
}
```

- 持久化（session writer / 历史加载）按现有 JSON 直通，旧数据无字段即无附件，**零迁移**。
- `toProviderMessages` / `toPersisted` 需同步保留该字段（现有实现会丢弃未知字段，要显式透传）。

### 3.3 Provider 层改造

**(a) 能力声明**（`src/core/llm/src/contracts.ts`）：

```ts
export interface LLMConfig {
  // ...
  /** 模型是否接受图像输入（缺省按模型名启发式：/(-v\b|vision|glm-.*v$|4\.6v|5v)/i） */
  vision?: boolean;
}

export interface LLMProvider {
  readonly model: string;
  readonly capabilities: { vision: boolean; imageGeneration: boolean };
  // ...
}
```

池配置（`llm-schemas.ts`）给三家 schema 各加一个 `vision` checkbox + 视觉模型名提示。

**(b) content blocks 渲染**（基类 `OpenAIChatLLM.toProviderMessages`）：

```ts
// 伪代码：仅当 vision=true 且消息解析为 user 时启用块数组
function renderContent(m, apiRole, caps): string | Array {
  const imgs = caps.vision && apiRole === 'user'
    ? (m.attachments ?? []).filter(a => a.kind === 'image')
    : [];
  if (!imgs.length) return sourceTag + m.content;            // 现行为不变
  return [
    ...(sourceTag || m.content ? [{ type: 'text', text: sourceTag + (m.content ?? '') }] : []),
    ...imgs.map(a => ({ type: 'image_url', image_url: { url: readAsDataUrl(a) } })),
  ];
}
```

要点：
- **assistant/tool/system 消息永不带图**（两家都会 400），防御性过滤沿用现有两遍扫描框架。
- 图片读取做在 provider 侧的共享工具函数（见 3.4 预处理），读取失败降级为文本占位 `[图片读取失败: path]`。

**(c) 两家差异适配**：

| 差异点 | DeepSeek 子类 | GLM 子类 |
|---|---|---|
| base64 | `data:${mime};base64,${b64}`（data URL，规范要求） | **纯 base64**（剥掉 `data:` 前缀），失败时回退 data URL 重试一次（新版端点对 data URI 的兼容性**需实测**） |
| `detail` | 支持；上量场景可传 `low`（截图 OCR 类任务收益大） | **必须剥离**（schema `additionalProperties:false`） |
| 格式 | GIF/WebP 直传 | GIF 取首帧转 JPEG；WebP 转 PNG/JPEG（服务端 `sharp` 或轻量解码；无依赖时直接拒收并提示） |
| 大小/数量 | 32MB/600 张 | 5MB/50 张（glm-4v-flash 1 张仅 URL） |
| 重复上传 | 可选接 Files API `file_id` 缓存（按 hash 复用） | 无，每次内联 |

建议把"每请求图片预算"做成统一常量：**≤10 张/请求、单图发送前压到 ≤4.5MB、长边 ≤2048px**（两家交集内的保守值；DeepSeek 每图 token 封顶 384、GLM 按分辨率计费，2048px 对 OCR/截图够用且成本可控）。

### 3.4 预处理管线（发送前，provider 共享工具）

```
附件元数据 → 存在性/扩展名校验 → 内容嗅探（魔数：JPEG/PNG/GIF/WebP，不信 mime 字段）
  → [GLM] GIF→首帧 JPEG、WebP→转码
  → 长边 >2048px 等比降采样（JPEG q85）
  → 单图 >4.5MB 再压；仍超 → 拒发该图并占位
  → 读 bytes → base64 → provider 特定 URL 格式
```

- 降采样结果**缓存到 `files/<agentId>/_tmp/.vision/<hash>.jpg`**：多轮重发同一图零重复编码，DeepSeek 上下文缓存对相同 data URL 才命中，稳定字节 = 稳定缓存。
- 外链 http(s) URL 一律**不主动抓取**（默认策略；本地部署优先内联，避免 SSRF）。

### 3.5 历史与缓存策略

- **近 3 轮**（可配 `visionHistoryWindow`）user 消息携带图片块；更早轮次渲染为 `[图片：files/.../x.png]` 文本占位。
- 理由：① 两家上下文缓存都按前缀字节命中，老图反复内联会持续吃 token/费用；② DeepSeek 每图 ≤384 token、GLM 按分辨率计费，窗口外的图占位即可；③ 文件仍在磁盘，模型可用 read/浏览器工具"回去看"。
- 会话压缩/归档逻辑无需感知附件（占位符是纯文本）。

### 3.6 入口链路（ws handler 改造，最小侵入）

`src/host/server/src/ws/handler.ts` 附件分流：

```
fileList = files ?? attachments
文本类（.txt/.md/.csv/.json...）→ 维持现有 "[用户上传了文件：...]" 文本引用
图片类（嗅探 .png/.jpg/.jpeg/.gif/.webp）→ AgentMessage.attachments（不再拼文本引用）
```

- `AgentMessage`（park 注入、router.inject、正常 send 三条路径）统一带上 `attachments`。
- 前端 ChatInput 已有上传；补图片**缩略图预览 + 粘贴/拖拽图片**（`paste` 事件里 `clipboardData.files` 直接走 `/api/upload`）。

### 3.7 工具视觉闭环（二期，顺 GLM 原生能力）

1. `read` 工具图片防护：扩展名/魔数命中图片 → 返回 `{status:'binary', kind:'image', path, size}` 结构化提示而非 utf-8 乱码（**一期顺手修**，独立于视觉功能）。
2. `browser.screenshot` / `read`（图片）结果在 vision 模型会话中作为附件回传下一轮（GLM-4.6V/5V-Turbo 的"输出多模态"正是为此设计）：tool 消息 content 保持文本摘要 + `attachments` 挂截图，provider 渲染时并入 user 轮之后的 tool 结果旁（实现上可并入**下一条 user 消息**块数组，规避"仅 user 带图"的协议限制）。
3. 屏幕质检/UI 调试等 Agent 场景由此自然获得"看截图→改代码→再截图"循环，这是选 GLM 做主力的最大理由。

### 3.8 生成契约预留（本期不实现）

```ts
// types：MessageAttachment.kind 已含 'image-gen' + generated 元数据
// LLM 响应侧（contracts.ts）：
export interface LLMResponse {
  // ...
  artifacts?: GeneratedArtifact[];   // 预留：模型生成的媒体产物
}
export interface GeneratedArtifact {
  kind: 'image';                     // 后续可扩 'video' | 'audio'
  url?: string;                      // 远端 URL（GLM 图像生成返回 url）
  path?: string;                     // 落盘后的工作区路径
  mime: string;
  prompt?: string;                   // 产生它的提示词
  model?: string;                    // cogview / 第三方
}
// 工具侧预留：generate_image 工具（接 GLM 图像生成 API /paas/v4/images/generations
// 与异步图像生成端点；DeepSeek 无生成能力，不接）
// UI 预留：消息气泡按 kind='image-gen' 渲染 <img>（workspace /raw 端点已可直出图片）
```

---

## 4. 部署选型建议

**主推组合：GLM 视觉矩阵为主力、DeepSeek vision 为补充，一套契约双后端。**

| 角色 | 模型 | 理由 |
|---|---|---|
| Agent 主力（看图对话/前端复刻/截图调试） | `glm-5v-turbo` | 原生多模态 Function Calling + 深度适配 Agent 工作流；200K 上下文；与现有 GLM 池同 Key/端点；若编码套餐端点可用则边际成本近零（**需验证**） |
| 免费兜底 / 高频 OCR | `glm-4.6v-flash` | 完全免费，128K，50 图/请求；截图问答、批量打标的零成本选项 |
| 精细视觉推理 / 文档表格 | `glm-4.6v`（106B） | OCR/表格/跨页文档 SOTA 级；可关思考控成本 |
| 批量图理解 / GIF / WebP / 超长图文 | `deepseek-v4-flash-vision-exp` | 每图 token **封顶 384**（1.5 元/M 空闲价 ≈ 每图 0.0006 元），600 图/请求 + 1M 上下文，批量场景单价最低；支持 GIF/WebP；与现有 DeepSeek 池同 Key |
| 混合路由（可选二期） | 文本主力 + vision 池 `$ref` | Agent 配置 `vision_model` 独立指向视觉池条目；检测到附件含图片时 agent-loop 切换/追加调用，避免全员换视觉模型 |

**模型池配置示例**（复用现有 `llmProviders` 结构，仅加 `vision` 位）：

```jsonc
{
  "glm-vision": { "provider": "glm", "model": "glm-5v-turbo", "base_url": "https://open.bigmodel.cn/api/paas/v4", "api_key": "${GLM_API_KEY}", "vision": true },
  "glm-vision-free": { "provider": "glm", "model": "glm-4.6v-flash", "base_url": "https://open.bigmodel.cn/api/paas/v4", "api_key": "${GLM_API_KEY}", "vision": true },
  "deepseek-vision": { "provider": "deepseek", "model": "deepseek-v4-flash-vision-exp", "base_url": "https://api.deepseek.com", "api_key": "${DEEPSEEK_API_KEY}", "vision": true }
}
```

---

## 5. 分期落地

| 阶段 | 内容 | 涉及文件 |
|---|---|---|
| **P0（一期）** | ① `MessageAttachment` 契约 + AgentMessage 扩展；② `vision` 能力位（config + provider.capabilities）；③ 基类 content blocks 渲染 + DeepSeek/GLM 差异适配（base64 格式、detail 剥离、格式转换）；④ 预处理管线（嗅探/降采样/预算/缓存）；⑤ ws handler 图片分流；⑥ read 工具图片防护；⑦ UI 缩略图 + 粘贴上传；⑧ 近 N 轮带图 + 占位降级 | types、llm/contracts、llm-openai、llm-glm、llm-deepseek、ws/handler、fs/tools、webui/ChatInput、llm-schemas |
| **P1（二期）** | 工具输出视觉闭环（screenshot/read 图片作为附件回传）；混合路由（vision_model $ref）；DeepSeek Files API 图片复用；`detail:low` 场景开关 | web/tools、agent-loop、llm-deepseek |
| **P2（三期）** | 生成契约实现：`generate_image` 工具（GLM 图像生成 API）、`artifacts` 渲染、`kind='image-gen'` 消息气泡 | tools、webui |

## 6. 风险与上线前验证清单

- [ ] **GLM base64 格式**：先纯 base64，报错回退 data URL（两版实测一次定死）。
- [ ] **GLM detail 字段**：确认携带 `detail` 是否 400（按 schema 应拒绝，剥离逻辑必须先行）。
- [ ] **GLM 编码套餐端点**（`/api/coding/paas/v4`）对 `glm-5v-turbo` 是否放行套餐额度（影响主力模型成本结论）。
- [ ] glm-5v-turbo 思考开关行为（能力表称可开关，实测 `thinking:{type:"disabled"}`）。
- [ ] GIF→首帧 / WebP 转码在无原生依赖下的实现选型（`sharp` 引入成本 vs 纯 JS 解码器）。
- [ ] DeepSeek 上下文缓存与图片块：降采样缓存的字节稳定性是否稳定命中（对比 usage 的 cache_hit）。
- [ ] 多图会话 token 预算：GLM 按分辨率计费，2048px 上限下实测单图 token，校准 `visionHistoryWindow` 与单请求图数上限。
- [ ] 旧会话兼容：无 attachments 字段的历史加载（应零感知）；带图新会话回滚到纯文本模型（应只见占位符不报错）。

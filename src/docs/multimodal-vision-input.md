# 多模态视觉输入（M1-M4 已实施）——attachments 引用旁挂 + provider 边界物化

> 状态：**M1（传输层）+ M2（入口与落盘）+ M3（UI/体验）+ M4（缓存/词表/
> 群聊）均已实施**。参考：DeepSeek 图像理解（`deepseek-v4-flash-vision-exp`，
> api-docs.deepseek.com/zh-cn/guides/vision）、BigModel 对话补全视觉系
> （GLM-5V/GLM4.6V/GLM4.5V/GLM-4V-Plus/GLM-4V-Flash，docs.bigmodel.cn
> 对话补全 OpenAPI）。两者均为 OpenAI 兼容 `content` 块数组形态
> （`[{type:'text'},{type:'image_url',image_url:{url}}]`）。

## 一、设计决策（两条主线）

1. **引用旁挂，不内联 base64**：`LlmMessage.attachments?: LlmImageAttachment[]`
   （ac-llm 契约 owning 包）携带几十字节的 `ref`（http(s) URL 直传 /
   workspace 相对路径），信封、落盘、事件、审计全链零膨胀；singles 前缀
   快照（prefixRevision 只哈希装配输入不含 messages）天然不受影响。
   `content` 保持 `string`——20+ 处纯文本消费方（archive 摘要 /
   session-query / text-budget / group / UI）零改动。
2. **物化收敛在 provider 传输边界**：`ac-openai-completions` 构造请求体前
   把 attachments 物化成 OpenAI content 块（与 `api_key`/`meta` 剥离同居
   "传输层键"纪律）；**visionModels 门控 fail-closed**——非视觉模型一律
   剥离（DeepSeek/GLM 非视觉模型收到图片块即 400），图片仅物化在
   user 消息（两家协议约束）。

## 二、链路落点

| 层 | 落点 |
|---|---|
| 契约 | `ac-llm/src/contract.ts` `LlmImageAttachment`（kind 开放词表，后续 video/file 同构）+ `LlmMessage.attachments?` |
| 纯库 | `ac-openai-completions`：`visionModels`（精确 > 前缀 `m-`/`m/` > 通配 `*`）+ `resolveMedia`（注入式，纯库保持零 cordis）；物化失败降级文本占位块（单图缺失不炸整轮）；attachments 键永不进 body（GLM 消息对象 `additionalProperties:false`） |
| 池 | `ac-llm-pool` `LlmPoolEntry.visionModels`（进内容签名——热更改清单即重挂）；visionModels 非空时注入 workspace 媒体物化器（`ctx.get('workspace')` 软依赖 → `resolveFile` → data: base64；图片扩展名白名单 png/jpg/jpeg/gif/webp） |
| 入口 | `ac-web-api` `conversation/deliver`：顶层 `attachments` 参数白名单校验（kind=image + ref 必填、mime/filename/detail 选填、≤50 张、ref ≤2048）并入消息 |
| 落盘 | `ac-session` `SessionRecord.attachments?`（record 落盘 / parseRecordLine 宽容解析 / projectRecord 回放带回 LlmMessage）——刷新后 UI 恢复附件 chips（顺手修复"附件 chips 刷新即丢"） |
| 视图 | `ac-conversation` 上下文视图 project 闭包透传 attachments（忙路径 steer 与闲路径 message-received 同形） |
| 前端 | webui deliver RPC 携带 attachments（仅图片文件且能解析出 workspace 路径）；`[附件] path` 文本行保留——非视觉模型靠 read 工具的既有路径不回归；history 记录 → ChatMessage.files 恢复；展示转换层 `splitAttachmentLines`（utils/feed）把正文尾部的 `[附件]` 行剥回 chips（安全门：仅 chips 覆盖 / `files/` 前缀 / 降级形；LLM 与落盘零变化）——刷新后气泡与实况同形，不露路径行 |
| 零改动 | ac-router / ac-agent-loop / ac-conversation deliver 主体（LlmMessage 引用透传；输出侧本就纯文本）；usage（图片 token 计入 prompt_tokens，mapUsage 归一已就绪） |

## 三、配置示例

```jsonc
// config.json llmProviders
"deepseek": {
  "base_url": "https://api.deepseek.com/",
  "defaultModel": "deepseek-v4-flash",
  "models": ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"],
  "visionModels": ["deepseek-v4-flash-vision-exp"]
},
"glm": {
  "base_url": "https://open.bigmodel.cn/api/paas/v4/",
  "visionModels": ["glm-5.3-flash", "glm-5v-turbo", "glm-4.6v", "glm-4.5v", "glm-4v"]
  // 前缀匹配：glm-4.6v-flash 等衍生名命中；整条视觉专用连接可用 ["*"]
}
```

## 四、两家约束速查（物化层已按 fail-closed 收敛，校验留待 M3）

| 项 | DeepSeek vision-exp | GLM 视觉系 |
|---|---|---|
| 格式 | JPEG/PNG/GIF/WebP | jpg/png/jpeg |
| 单图 | 32 MiB（file_id 64 MiB） | 5M、≤6000×6000 |
| 张数 | 600/请求 | 50（4V-Flash 仅 1 且**不支持 Base64**——需 URL 引用） |
| 请求体 | 48 MiB | — |
| 位置 | 仅 user 消息 | GLM-4V-Plus-0111 video_url 须在首位 |
| 其他 | detail: low/high/original/auto；图片 token ≤384/张（缩放 ~800×800） | video_url（≤200M mp4/mkv/mov）/ file 块（≤50M）——attachments.kind 词表二期扩展 |

## 五、分期状态与后续

- ✅ M1 传输层：契约 + 纯库物化/剥离 + 池接线 + 单测（body 形状断言）。
- ✅ M2 入口与落盘：deliver 校验透传 + session 落盘/回放/视图透传 + webui
  发送引用与刷新恢复。
- ✅ M3 UI/体验（2026-10 第二批）：
  - 附件上限三道闸——webui 发送侧截断告警（50）→ deliver 入口校验拒收
    （50）→ 适配层溢出降级行（50，`[其余 N 个附件未发送…]`）；
  - UserMessage 图片附件缩略图（`/api/file` 直链 + 加载失败回退文件 chip，
    点击预览大图）；刷新恢复的 chips 同样享受缩略图；
  - PoolManager 连接面板「视觉模型」字段（逗号分隔编辑 → `visionModels`
    数组落盘，支持前缀与 `*`；列表 detail 显示 `视觉 ×N`）。
- ✅ M4 扩展（2026-10 第二批）：
  - workspace 物化 **LRU 缓存**（键 = ref，新鲜度 = stat[mtimeMs+size]，
    命中续期、超 24 条逐最旧、文件覆写即失效重物化——同图跨轮回放免
    重复读盘+编码）；MIME 表扩至文档（pdf/txt/md/json(xl)/csv/doc(x)/
    xls(x)/ppt(x)，供 file 块 file_data）；
  - **kind 词表扩展**：`LlmAttachment = image | video | file`——video →
    GLM `video_url` 块（仅 http 引用，workspace 降级占位）；file → GLM
    `file` 块（http → `file_url`；workspace → 物化 `file_data` + filename）。
    deliver/session 校验同步放宽；
  - **群聊图片**：`group/send` attachments → 本体行（session.append）+
    hint 信封直达（首个 run 即可见，GROUP_HINT_META 防双录）+ historyFor
    peer 合并行附件并集回放 + webui 群输入附件（composeContent/
    imageAttachmentsOf 与直答路径单源复用）+ 群直播帧/历史行 chips 恢复
    （attachmentFilesOf 统一映射）。
- ✅ 模型能力元数据（2026-10 第三批，探测驱动）：
  - **视觉探测**：`OpenAICompletions.probeVision`（纯库）——逐模型发
    1×1 PNG 非流式最小请求（max_tokens=1），按 HTTP 状态**三态**判定：
    2xx=true / 400=false（含"仅 URL"模型——对本管线 base64 物化路径
    结论成立）/ 401·429·5xx·网络异常=**undefined 未知**（fail-closed
    不猜，凭据错/限流不可归因为拒图）。`LlmProvider.probeVision?` 契约
    + `LlmService.probeVision` 透传 + `llm/probe-vision` RPC（免注册
    base_url+api_key 与注册 provider+pool:<名> 凭据双路径，并发 4，
    ≤50 模型/次）。PoolManager「读取模型」后自动探测。
  - **存储格式**：池条目 `models` 宽容双形态——裸名 `'glm-4.5'` 或
    `{model, vision?, hidden?}`（`normalizePoolModels` 读侧唯一解析点，
    旧配置零迁移）；保存写最小形态（无标志=裸名，有标志=对象）；
    `llm/models` 刷新回写**合并保留已有 flags**（探测结果不因刷新丢失）。
  - **vision 门控统一**：`models[].vision` 探测标志与显式
    `visionModels`（前缀/通配）在池边界**取并集**喂适配层——探测即可
    用，手写清单仍可补前缀；modelMeta 进内容签名（标志变更热更重挂）。
  - **hidden 隐藏位**：`{model, hidden: true}` = 前端下拉隐藏（纯 UI
    呈现语义——路由/已选该模型的会话不受影响）。过滤点：ChatInput
    模型菜单与 AgentPane 模型合并清单（`visibleModelNames` 归一助手）；
    可达性判定看全量清单。PoolManager 模型清单列表控件（视觉/隐藏
    勾选位 + 点击模型名设默认，倒序显示新模型靠前）；`llm/providers`
    stats 透出 `modelMeta`。
  - **系统提示词模型能力注入（防幻觉）**：注册 meta 透出有效
    `visionModels` 并集 → `ctx.llm.visionOf(model, provider?)` 静态查询
    （精确 > 前缀 > 通配，与适配层物化门控同口径、对拍测试锁死）→
    ac-system-prompt 环境块注入 `[模型能力]` 行：视觉模型告知"附件图片
    直接送达、勿称无法查看"；纯文本模型告知"图片内容不可见、勿猜测
    虚构"；无能力元数据（undefined）零注入。
- ⬜ 后置：DeepSeek Files API `file_id`（复用图/大图——需上传端点与新
  ref 词汇，暂以 file_data 内联覆盖）；GLM-4V-Flash「仅 URL」特判提示。

## 六、测试索引

- `src/ac-openai-completions/tests/completions.test.ts`：物化/剥离/降级/
  通配/前缀/video/file/溢出/词表外/零回归 + probeVision 三态（17 用例）。
- `src/ac-llm-pool/tests/pool.test.ts`：visionModels 解析 + 端到端物化 +
  热更重挂 + 真实 resolveFile 物化（LRU）+ normalizePoolModels 双形态 +
  vision 并集门控（含热更）+ stats modelMeta 透出。
- `src/ac-session/tests/attachments.test.ts`：落盘/回放/records 零回归。
- `src/ac-web-api/tests/web-api.test.ts`：deliver attachments 白名单校验 +
  group/send attachments 全链 + llm/models 刷新保留 flags +
  llm/probe-vision 三态/双路径/参数校验。

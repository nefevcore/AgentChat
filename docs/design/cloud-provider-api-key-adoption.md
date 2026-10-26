# 云部署型 LLM 提供方接入裁决（cr-98）

日期：2026-10-01（讨论沉淀：云部署型 vs 直连 API 的差异与收录决策）。

## 背景与差异本质

云部署型（Bedrock/Azure OpenAI/Vertex）是云厂商代销托管：模型非其自研，
流量不出云基础设施、走云账单与云 IAM。与直连 API（模型厂直营，一个 key
一个域名）的三处实质差异：

1. 身份体系：传统形态继承云 IAM（SigV4 签名/Entra ID/服务账号+project），
   凭证形态（临时签名、token 刷新）在「连接池+key」模板形态放不下——
   pi-ai 手写路由表因此拒绝它们（PROTOCOLS 仅三协议）。
2. 寻址：端点带资源维度（region/资源名/deployment 名/project+location）。
3. 计费与配额：云账单合约与云侧 TPM/RPM，厂商直营无此层。

## 2026 现状：三家的 API key 化简化面

三家均已推出 key 化端点，云身份降维为普通 key，渠道型接入降维为直连式：

- **Bedrock API Key**：`https://bedrock-runtime.<region>.amazonaws.com/openai/v1`，
  Bearer 鉴权，/models 可用。控制台生成的短期 key（有有效期，生产建议 IAM）。
  pi-ai 目录尚未收录此端点（其 bedrock 走 SigV4 converse-stream）。
- **Azure v1 统一路由**：`https://<资源名>.openai.azure.com/openai/v1/`，免
  deployment 拼路径与 api-version。resource key 走 `api-key` 头而非 Bearer。
- **Vertex Express**：`https://aiplatform.googleapis.com`，`x-goog-api-key` 头，
  无 project/location。AgentChat gemini 库鉴权头同款，仅路径前缀不同
  （`/v1/publishers/google/models/...` vs 写死的 `/v1beta`）。

## 裁决

| 提供方 | 改动 | 决策 | 理由
|---|---|---|---
| Bedrock | 零（纯模板） | **收录** | 现有模板形态完整表达；与「未实测不收录」原则无冲突（AWS 官方文档背书） |
| Azure | authHeader 池字段（三处小改） | **收录** | 唯一卡点是头名；凭据经加密凭据库，headers 透传不承载密钥（明文落盘纪律） |
| Vertex | gemini 库路径前缀参数 | **缓** | AI Studio 模板已覆盖 key 化面；Vertex Express 增量仅 GCP 结算/配额 |

Azure authHeader 设计：池条目可选 `authHeader?: string`（如 `'api-key'`；缺省
undefined = Bearer）。经凭据链解析的 key 按指定头名发送。key 本身绝不进
headers 字段（明文落 config.json 违反凭据纪律）。

## 同批推进的 LLM 域改进（对齐 pi-ai，cr-98）

1. 错误分类：`LlmHttpError`（ac-error-core）携带状态码/机器可读分类/
   Retry-After 毫秒；四协议库接入。429/5xx 纳入首块前可重试（原仅网络层
   瞬时故障），Retry-After 优先于固定退避。
2. Anthropic thinking 回放：扩展思考+工具调用时，Anthropic 线格式要求回传
   上一 assistant turn 的 thinking 块（含签名）否则 400。捕获签名→持久化→
   历史装配重建（对齐 pi-ai replay 语义）。
3. 媒体负载上限：物化路径 20MiB 封顶（对齐 pi-ai maxRequestImageBytes；
   历史图片每轮重编码，不封顶将撞网关请求体上限后会话永久 413 死锁）。

## 来源

- AWS 文档：Bedrock API key + /openai/v1 兼容端点（Quickstart / guardrails 页）
- Microsoft Learn：switching-endpoints（v1 统一路由 + api-key 头）
- Google Cloud 文档：Vertex AI Express mode（x-goog-api-key）
- pi-ai 源码（dsh-llm-pi-ai/adapter、pi-ai catalog 2026-07-25）
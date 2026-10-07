# KV 前缀缓存断裂：根因排查结案与修复方案

> 状态：**主修复已实施（cr-294）**——live/回放统一中立 reasoning 键，wire 翻译收敛协议适配层；
> 增强 A/B（prompt_cache_key / cache_control）与 journal 折叠落位仍为可选另立 CR。
> 排查时间：2026-10-06（会话 d392fea3「KV缓存每轮首步下降原因排查」）
> 方法：ac-wire-probe 探针（cr-294 落盘的真实请求载荷）+ 真实 API 受控实验 + dsh/pi-ai 源码对照

## 一、现象

每个 run 的首步 KV 缓存命中率大幅下降，且降幅与**上一轮的思考（reasoning）总量成正比**。
run 内各步命中率正常（99%+），问题只出现在 run 边界。

实测数据（会话 d392fea3，deepseek-flash）：

| run 边界 | 首步 miss | 上一轮思考量 | 关系 |
|---|---|---|---|
| 13:33:49(113步) → 13:40:26(2步) | 121,271 tok | 421,228 B | ≈ 全量 |
| run-muwr4mhz → run-muwriv6l | ~15,600 tok | 44,507 B | ≈ 全量 |

news~news 会话（eventReplay=journal）更极端：每轮首步命中恒 11,776 tok
（= system+tools 静态前缀），13 万 token 历史全量重算——该会话另有 journal
折叠计数行落在回放头部的问题（见 §五.3，独立根因，本方案不含其修复）。

## 二、根因（已实证）

### 核心机制：live 与回放的消息形态分裂

每个 run 的消息数组 = [system, 历史…, 上一轮触发消息, 上一轮轨迹]。
run 内 live 逐步追加（形态 A）；下一轮 run 启动时由 session.history() 重派生
（形态 B）。两个构造源的字节形态不同 → 从分歧点起前缀缓存全断：

| 字段 | live 形态（assistantOf, ac-agent-loop/service.ts:566） | 回放形态（expandSteps, ac-session/index.ts:760） |
|---|---|---|
| 思考 | reasoning: step.reasoning | **剥掉**（M4 裁决不回传） |
| 触发消息 name | router 直传无 name | projectRecord 恒补 name（:716） |
| 工具结果 | JSON.stringify(result) | JSON.stringify(tc.result) 同源 |

### 字段语义（真实 API 实测，全部可复现）

| 实验 | DeepSeek | GLM (glm-5.3-flash) |
|---|---|---|
| 思考字段计入 prompt | 只认 **reasoning_content** | 只认 **thinking** |
| reasoning 字段 | **完全忽略（死字段）** | **完全忽略（死字段）** |
| name 字段对缓存 | 无影响（Δ=0 五次对照） | 无影响（Q8=Q4） |
| tools 交互 | **tools 在场时思考才计入**（1198→2041） | 无交互恒计入 |
| 边界剥思考代价 | hit 94%→63%（S 实验） | **无代价**（G3: 95.1%） |

关键实验记录（DeepSeek，tools 在场模拟真实 run 形态）：

```
S2 run1 重发（run 内对照）  hit=3584/3801  94.3%
S3 run2 首步（剥思考）      hit=1152/1825  63.1%   ← prompt 少 1976 tok 且前缀断
S4 run1 再发（回归）        hit=3584/3801  94.3%   ← 排除时间衰减
```

GLM 的 G2 现象：字节完全相同的重发只命中 10%，剥了思考的请求反而 95%——
GLM 对含回传 thinking 的前缀缓存行为异常，**改完后需实测复核**。

### 附加发现：DeepSeek thinking mode 的 400

思考模型 + tools 时，DeepSeek 强制要求回传：
The reasoning_content in the thinking mode must be passed back to the API.
当前回放形态（剥光）在真实序列上会触发此 400——这是比缓存更硬的故障。

### dsh / pi-ai 源码对照（交叉验证）

dsh 的 LLM 引擎 @earendil-works/pi-ai（本机 dsh@0.2.0-rc.2 全家桶内）确认：

1. **capability 矩阵驱动**：requiresReasoningContentOnAssistantMessages: isDeepSeek
   （openai-completions.js:1269）；DeepSeek 兜底**空串也回传**
   assistantMsg.reasoning_content = ''（:1044-1048）——正是躲上面那条 400
2. **字段名往返对称**：接收时按 [reasoning_content, reasoning, reasoning_text]
   找到第一个非空字段，**把字段名存进 thinkingSignature**；回传时
   assistantMsg[signature] = thinking（:399-415, :1004-1005）
3. thinking 是消息模型一等公民 block，**会话历史持久保存并原样回传**——
   从架构上保证 live=回放，根本不存在我们的形态分裂
4. GLM/zai：请求参数 thinking: { type:'enabled', clear_thinking:false }（:619-621）

## 三、修复方案

### 主修复：思考字段按 provider 单源化（必须）

新建一个纯函数（建议住 ac-llm 契约或 ac-agent-loop，两处消费同一单源）：

```ts
type ThinkingWireForm = 'reasoning_content' | 'thinking' | 'strip';

function thinkingWireForm(provider: string, model: string): ThinkingWireForm {
  // DeepSeek 系 → 'reasoning_content'（含空串兜底）
  // GLM/zai 系  → 'thinking'
  // 其余        → 'strip'
}

function normalizeAssistantMessage(msg, form): LlmMessage {
  // 按 form 写字段或剥掉；live（assistantOf）与回放（expandSteps）都过它
}
```

改动点：
- ac-agent-loop/src/service.ts assistantOf()（:566-582）：reasoning → 按单源
- ac-session/src/index.ts expandSteps()（:760-795）：不再剥光，按单源同形
- ac-subagent/src/service.ts（:392 同型点）对齐
- 同步处理：name 字段两形态对齐（deliver 边界补 name 或回放不加——实测对
  缓存无影响，纯形态一致性，顺手修）

验收：修后跑真实会话，pnpm wire-diff 边界报告从 [BREAK] 变 [OK]；
usage 台账首步命中率恢复至 99% 量级。

### 增强 A：OpenAI 系 prompt_cache_key（可选，独立 CR）

OpenAI 按 key 分桶缓存。补发 prompt_cache_key: conversationId 截 64 字符
（dsh 的 clampOpenAIPromptCacheKey 同款）。对 DeepSeek/GLM 无影响。

### 增强 B：Anthropic cache_control（可选，收益最大）

Anthropic 是显式缓存：不打标不缓存。三点标注（dsh :799-837 同款）：
- system 首块 {type:'ephemeral'}
- 最后一个 tool 定义
- 最后一条对话消息

当前 Anthropic 侧全量 miss，这是从 0 到有的开关。

## 四、工具资产（已就位，实施时直接用）

| 资产 | 位置 | 用途 |
|---|---|---|
| wire 探针 | src/ac-wire-probe（cr-294，已挂载运行） | 每次 LLM 调用真实载荷落盘 |
| diff CLI | pnpm wire-diff [--root dir] [过滤词] | run 边界比对，OK/HEAD/BREAK 判定 |
| 探针数据备份 | sandbox/kv-analysis/probe-backup/ | 含全部关键边界的 8 个快照 |
| 实验脚本 | sandbox/kv-analysis/*.mjs | name-probe / reasoning-probe / field-name / tools-interact / final-verdict / glm-fields / glm-boundary 等，全部可重跑 |
| dsh 源码参照 | C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/ | capability 矩阵与序列化实现 |

探针摘除：诊断完成后删 cordis.yml + ac-app TREE 的 wire-probe 两行即收回。

## 五、遗留与注意事项

1. **GLM 回传 thinking 后需复核缓存行为**（G2 现象：含回传 thinking 的重发只
   命中 10%）——若复现，GLM 分支可能要维持 strip 并接受其边界 miss
2. **思考计入 = token 成本上涨**：DeepSeek 边界命中换回的节省 vs 上下文膨胀，
   长会话净收益为正（缓存价约为标准价 1/10），短会话可能持平——上线后用 usage 对账
3. **news 的 journal 折叠落位**（折叠计数行在回放第 0 条，N 每轮 +1）是独立
   根因，影响 eventReplay=journal 的 Agent；修复方向：折叠摘要物化进文件或
   尾部追加——另立方案，勿与本 CR 混做
4. **空 assistant 消息**：dsh 会剔除无 content 且无 tool_calls 的 assistant
   （:1057-1059）；我们 live 侧不过滤，中断步可能产生——单源化时顺带处理
5. **responses API 分支的 messages 泄漏**：ac-openai-completions 的
   buildResponsesBody 时 params.messages 未剥（body 同时含 input 与 messages）——
   与本根因无关的小瑕疵，顺手可修
6. **GLM thinking 模型的对称 400 风险**：GLM 若也有强制回传校验未验证；
   修复时 GLM 分支保留 thinking 回传即可规避

## 六、实施清单（下个会话照此执行）

> ⚠️ **接线现状（2026-10-06 结案时核实）**：探针四处接线（src/cordis.yml、
> src/ac-app/src/index.ts TREE、两处 package.json、README）已被还原回 HEAD
>（疑似宿主重启/其它会话的 git 操作），但**包本体（src/ac-wire-probe，13 文件）、
> node_modules 链接、cr-log 条目（cr-294/295）、探针数据（workspace/home/wire-probe/）
> 与 sandbox/kv-analysis/ 实验脚本都还在**。下个会话若要用探针验收，先按 cr-294
> 重做接线（cordis.yml wire-probe 行 + TREE 行 + 两处 package.json 依赖 + 根
> scripts wire-diff + README 布局段）再重启宿主。

```
0. （如需探针验收）按 cr-294 重做 wire-probe 四处接线并重启宿主
1. node scripts/cr.mjs append '思考字段按 provider 单源化：live/回放同形修 KV 边界'
2. 建 normalizeAssistantMessage 单源函数（provider → reasoning_content/thinking/strip）
3. 改 assistantOf / expandSteps / ac-subagent 同型点 + name 对齐 + 空 assistant 过滤
4. pnpm typecheck && pnpm test:unit && pnpm check:deps + 定向 lint
   （动了会话链路）+ pnpm test:integration
5. 重启宿主 → 跑两轮真实会话 → pnpm wire-diff 验收边界 [OK] + usage 首步命中对账
6. （可选另 CR）OpenAI prompt_cache_key / Anthropic cache_control / journal 折叠落位
```

## 附：实验数据存档

全部实验脚本与原始输出在 sandbox/kv-analysis/（探针数据备份在 probe-backup/）。
重跑任一实验：node sandbox/kv-analysis/<name>.mjs（凭据走 credentials.json，
脚本内不落盘 key）。
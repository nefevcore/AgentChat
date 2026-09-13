# ac-bench —— 评测域（ctx.bench）

单会话能力跑批：把外部基准数据集翻译成中性用例（提示词 + 临时工具集 +
期望调用），经 **ac-agent-loop 机制 run** 驱动真实链路（工具 schema 注入 →
模型 tool_calls 聚合 → 工具执行），对拍实际调用产出报告。测的是
**模型 + harness 组合体**——固定模型对比不同 harness 的跑批差值，即为
harness 工程水位。

## 快速开始

```bash
pnpm bench                # 冒烟：内置样例（7 例）+ 脚本化 mock（零 LLM、不花钱）
pnpm bench --limit 3      # 切片
pnpm bench --list         # 只列出用例
pnpm bench --json         # 机器可读完整报告
```

冒烟链路验证面：套件注册 → 临时工具合成 → agentLoop → llm 路由 →
toolCalls 聚合 → 工具执行 → 对拍 → 报告 + 事件（`bench/run-started` →
`bench/case-settled`×N → `bench/run-completed`）。

## 真实评测（BFCL 官方数据 + 真实 LLM）

1. 下载数据（gorilla 仓库 pinned commit `70b6a4a`——main 分支该路径已 404）：

```bash
# bash / curl
curl -L -o BFCL_v3_simple.json \
  https://raw.githubusercontent.com/ShishirPatil/gorilla/70b6a4a2144597b1f99d1f4d3185d35d7ee532a4/berkeley-function-call-leaderboard/data/BFCL_v3_simple.json
curl -L -o BFCL_v3_simple.answer.json \
  https://raw.githubusercontent.com/ShishirPatil/gorilla/70b6a4a2144597b1f99d1f4d3185d35d7ee532a4/berkeley-function-call-leaderboard/data/possible_answer/BFCL_v3_simple.json
```

```powershell
# PowerShell（注意：curl 是 Invoke-WebRequest 别名，不支持 -L/-o——用真 curl.exe 或如下写法）
$base = 'https://raw.githubusercontent.com/ShishirPatil/gorilla/70b6a4a2144597b1f99d1f4d3185d35d7ee532a4/berkeley-function-call-leaderboard/data'
Invoke-WebRequest -Uri "$base/BFCL_v3_simple.json" -OutFile 'BFCL_v3_simple.json'
Invoke-WebRequest -Uri "$base/possible_answer/BFCL_v3_simple.json" -OutFile 'BFCL_v3_simple.answer.json'
```

2. 跑批（OpenAI 兼容端点）：

```bash
pnpm bench --file BFCL_v3_simple.json --answers BFCL_v3_simple.answer.json \
  --model deepseek-chat --base-url https://api.deepseek.com --api-key <key>
```

3. CI 门槛：

```bash
pnpm bench --min-accuracy 80   # 低于 80% 退出码 1
```

> **跑批时长预期**：真实 LLM 每例 ≈ 2 次请求（工具调用 + 收尾），串行执行。
> 400 例按每请求 2~5s 估 ≈ **30~60 分钟**（thinking 模型 ×2~3）。CLI 已内置
> 实时进度（逐例 PASS/FAIL + `elapsed/avg/eta`，走 stderr）——建议先
> `--limit 20` 试跑确认配置与通过率，再放全量。

支持的类目文件同形：`BFCL_v3_multiple / parallel / parallel-multiple`
（同目录下载，`--file` 可重复传入多份合并跑批）。

## 数据形态（宽容解析）

| 字段 | 支持形态 |
|---|---|
| `question` | v3 消息列表（含嵌套轮次数组）/ v1 内嵌函数文档整串 |
| `function` | v3 裸 `{name,description,parameters}` / OpenAI 包装 `{type:'function',function:{…}}` / JSON 字符串 |
| `ground_truth` / `answer` | v1 调用串列表（`func(a=1, b='x')`）/ v3 结构化列表（`[{func: {参数: [可接受值…]}}]`）；分离答案文件（`possible_answer/`）按 `id` join |
| 文件 | JSON 数组 / JSONL 双形态 |

不可解析条目跳过并记入 `suite.skippedReasons()`（诊断用），不中断跑批。

## 对拍语义（AST 评测工程化子集）

- 多重集匹配：调用名 + 数量 + 参数全部对上才算过（parallel 类目次序不敏感）；
- 每参数可接受值列表：任一命中即过（BFCL possible values 语义）；
- 宽松相等：数字↔数字串、布尔↔`'true'`、串首尾空白忽略、列表/对象递归；
- `expected` 为空 = 反例用例（模型不应调用任何工具）；
- 收束态要求：调用对拍通过且 `finish='stop'` 才算 pass（烧穿步数预算 =
  harness 信号，记入 reason）。

## 程序化用法

```ts
// 宿主树内（bench 行已装载）
const report = await ctx.bench.run('bfcl', {
  model: 'deepseek@deepseek-chat',
  limit: 50,
  maxSteps: 6,
});

// 自定义套件
ctx.bench.registerSuite({
  name: 'my-suite',
  load: async () => [
    {
      id: 'case-1',
      prompt: '…',
      tools: [{ name: 'my_tool', parameters: { … } }],
      expected: [{ name: 'my_tool', argsSpec: { x: [1] } }],
    },
  ],
});
```

机制 run 携带 `ARCHIVE_REVIEW_META`（M20 机制标记）：跑批不入会话账、
不记 usage、不进上下文视图——在活宿主里跑也不会污染真实数据。

## 报告字段

`BenchReport`：`accuracy`（通过率）、`promptTokens/completionTokens`
（累加轨）、`durationMs`、逐例 `cases[]`（pass/reason/finish/steps/
expected/actual/耗时）。生产验收建议同记：跨 seed 方差（同参数跑 3 次）、
每例耗时分布、token 成本归一化通过率（HAL 经验）。

## 路线图（套件槽位已就绪）

- [x] BFCL 单轮（simple/multiple/parallel/parallel-multiple/反例）
- [ ] BFCL v3 多轮（turn 级对话 + 状态对拍）
- [ ] τ²-bench（用户模拟器 + 政策合规）
- [ ] Terminal-Bench 子集（fs/shell 工具行 + Docker 校验器）

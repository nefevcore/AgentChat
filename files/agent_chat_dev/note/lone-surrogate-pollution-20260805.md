# lone surrogate 截断污染（2026-08-05 归档轮 DeepSeek 400）

## 现象
压缩会话时后端报错：
```
400 Failed to parse the request body as JSON: messages[5].content: lone leading surrogate in hex escape
```

## 根因链（完整）
主路径（归档复用上下文）本身**安全**——loadHistory/archive/truncateTail/safeSplitIdx 全是**消息级**截断，不切字符。这就是"继续会话"平时不出 bug 的原因。

**但归档整理轮是一条副路径**，它破坏了"原样复用"不变量：

```
压缩触发 → Agent 调 query_history 检索归档内容（省 token 设计）
  → formatMessage: msg.content.slice(0, 200)   ← 字符级截断！
  → 第 200 个 code unit 恰是 emoji 的 \ufffd（high surrogate）
  → low surrogate \udeXX 被切掉 → 产生 lone surrogate
  → 工具返回文本（含毒）→ 作为 role=tool 消息持久化到 messages.jsonl
  → 后续任意轮 LLM 请求：JSON.stringify 把 lone surrogate 转义为 \ufffd
  → DeepSeek 解析 \ufffd 无配对 → 400 "lone leading surrogate"（messages[5]）
```

**本质**：query_history 的"token 预览截断"（为省 token）把**截断结果写回了会话历史**（工具结果持久化），而这个截断不是 UTF-16 安全的——**预览截断的输出污染了复用上下文的数据源**。

## 关键证据
- neko/messages.jsonl 坏消息：`role=tool, name=query_history, 5687 字符`
- lone surrogate 在位置 3975：`估计比 No Way Home 还高了？\ufffd...`
  —— 正是 slice(0,200) 边界（第 200 code unit 恰是 emoji high surrogate）
- 磁盘存的是 JSON 转义文本 `\ufffd`（6 字符），字节级正则扫不到 → 需 parse 后检测

## 修复（三防线）
1. **根修**：`safeTruncate` / `safeClipByTokens`（src/utils/tokens.ts）
   - UTF-16 安全截断，不切断 surrogate pair（代理对作为一个单位）
   - query_history formatMessage 改用
2. **纵深**：`appendJSONL` 写入前 `sanitizeSurrogates` 清洗 lone surrogate → U+FFFD
   （防毒数据进入会话历史）
3. **兜底**：`openai.ts` 请求体 JSON 清洗 `\ud8xx` 孤立转义 → `\ufffd`
   （最外层防线，即使数据已污染也阻止 DeepSeek 400）

## 测试
- 新增 `tests/loneSurrogate.test.ts` 9 用例
  - 含原 bug 复现：`slice(0,200)` 确实切出 lone surrogate → 新实现安全
  - safeTruncate 回退一位保留完整代理对
  - safeClipByTokens 头/尾截断均安全
  - sanitize 替换 lone → U+FFFD、保留完整 emoji
- 全量 132 tests 通过 + tsc 0 错误

## 数据清洗
- 6 个 jsonl 文件含毒（neko/writer 会话 + 归档 + self 归档），已 parse-清洗-重写
- 注意：不能字节级正则替换（存的是转义文本），需逐行 parse → 清洗 → 重写

## 教训
- **工具预览截断的结果会被持久化** → 任何截断必须 UTF-16 安全
- JS 中 `slice/substring` 按 code unit 截断，emoji 占 2 unit → 边界切开即产生 lone surrogate
- 磁盘 JSON 里的 lone surrogate 是转义文本（`\ufffd` 6 字符），检测需 parse 后

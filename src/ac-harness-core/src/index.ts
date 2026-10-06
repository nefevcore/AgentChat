// ============================================================
// ac-harness-core —— 本地 CLI harness 委托面纯库（零 cordis）
//
// harness 桥接方案 B（docs/harness-bridge-plan.md）的算法半边：
//   · gateway.ts —— exec 编排（spawn/stdin/行流/看门狗/中止/终态收敛）
//     + probe 轻探测
//   · adapters.ts —— claude-code / codex 家族差异（命令行 + 事件归一）
//   · events.ts —— 归一事件词汇 + 行级容错
// 行包（ac-harness-tools）只做注册胶水与权限/并发/生命周期编排——
// 纯库可独立单测（JSONL fixture，零真子进程）。
// ============================================================
export type { HarnessEvent, HarnessUsage, LineOutcome, TerminalFacts } from './events.ts';
export { clip, parseJsonlLine, str, num } from './events.ts';
export type { HarnessRunRequest, HarnessRunResult, HarnessAdapter, HarnessRunHooks } from './gateway.ts';
export { runGateway, probeGateway } from './gateway.ts';
export { claudeCodeAdapter, codexAdapter } from './adapters.ts';
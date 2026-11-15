// ============================================================
// replay.ts —— LLM 回放契约词汇表（cr-1101 / docs/design/session/replay-contract.md）
//
// 原则（用户裁决 2026-11-15）：
//   · 任何曾进入 run 的「事实」都必须跨 run 回放——once 绝不允许
//     （回放缺席 = 跨 run 失忆，违反 KV 前缀原则）。
//   · 默认直接回放（original）；只有偏离默认的才需要声明。
//   · 方案 B（包裹归回放）：非 user/agent 发言的回放消息在**回放时**
//     统一包裹——落盘裸正文；存量烘焙行（写面已含外壳）原样放行。
//   · 词汇表 owning = ac-ledger；落盘事实不掺 UI 语义（渲染契约另立）。
//
// 外壳统一、内芯开放：外层 <system-reminder> 封闭模板归系统（提示
// 注入防护不开放自定义）；内层类型化标签（如 <skill_content name="…">）
// 是数据结构不是防护——随 content 开放携带（去重锚/UI 折叠已依赖）。
// ============================================================

/** 回放策略（封闭枚举；缺省 original） */
export type ReplayKind = 'original' | 'wrapper' | 'none';

/** 缺省策略：content 原文回放——speech 行天然此档（foldLlmReplay 的 speech
 *  分支隐式采用;显式常量作为词汇表文档锚 + 未来 kindOf 类消费面的单源） */
export const REPLAY_DEFAULT: ReplayKind = 'original';

// 模板物理实现住 ac-core-utils（叶子包——注入生产方与回放投影方共享
// 同一字节源防漂移）；本包是契约 owning 面（词汇表 + 默认规则）。
import { wrapSystemReminder } from 'ac-core-utils';

/**
 * 回放包裹（wrapper 档统一加壳）：
 * - 存量烘焙行（外壳已写面烘焙——v2 skill 70 行 + v1 存量）原样放行；
 * - 新写面落盘裸正文，本函数回放加壳——模板与写面注入渲染字节同源，
 *   「裸正文落盘 + 回放包裹」= 与模型在 run 内所见字节一致（KV 前缀保真）；
 * - original/none 档原样返回（none 由调用方过滤，不进消息数组）。
 */
export function wrapForReplay(content: string, kind: ReplayKind = 'wrapper'): string {
  if (kind !== 'wrapper') return content;
  return wrapSystemReminder(content);
}

// ============================================================
// 声明注册制（cr-1104 第二阶段——registerToolMode 范式）
//
// 各注入源词的回放档由 owning 插件注册声明（ctx.ledger.
// registerReplayPolicy），消息处理回归各自插件；ac-ledger 只保
// 默认规则（speech→original；context/inject→wrapper）与机制词。
// 注册随 fiber 归属自动回收（行卸载 = 声明退场；缺省回落 wrapper
// ——降级语义与插槽-插头原则一致）。
// ============================================================

/** 回放声明：source/injectSource 决策词 → 回放档 */
export interface ReplayDecl {
  /** 决策词（开放命名规约「包名:语义」；裸词保留给机制词与历史内容词） */
  source: string;
  replay: ReplayKind;
}

/** 机制词（封闭——注册制不可覆盖/不可注册） */
export const REPLAY_BUILTIN_WORDS: ReadonlySet<string> = new Set(['event', 'error', 'inject', 'segment', 'resume']);

/**
 * 机制 none 词（cr-1111 渲染契约切片 C）：resume 等生命周期通知——**从未
 * 进入过任何 run 的消息数组**（resume 前缀承载的模型事实是 run 自身的
 * 步/inject,经轨迹回放另路在场）,none 档是如实描述而非策略选择。
 * 确定性按词生效（不依赖运行时注册——注册若未装上降级方向会错成
 * wrapper,泄漏进 LLM 回放）。
 */
export const REPLAY_BUILTIN_NONE: ReadonlySet<string> = new Set(['resume']);

// ============================================================
// agent-memory memory —— 长期记忆管理
//
// 记忆更新策略：混合方案（标记驱动 + 定时 trigger 智能审查）
//
//   postHook（机械层）：
//     agent-session 归档时写入 .memory_review_needed 标记。
//     不再累积摘要——Agent 通过 query_history 工具直接检索完整历史。
//
//   定时 trigger（智能层）：
//     Agent 配置每日凌晨定时任务，收到 trigger 后自行审查：
//       1. bash ls ./sessions/<自己的ID>/ 列出对话对象
//       2. 对存在 .memory_review_needed 标记的对象：
//          a. query_history 检索近期对话
//          b. read memory.md
//       3. 读取待办清单和笔记索引（read TODO.md, ls note/, read note/note_index）
//       4. 综合判断，更新 TODO.md 和 note/ 知识库
//       5. bash rm 清除 .memory_review_needed 标记
//
//   为什么这样设计？
//     · postHook 只写标记 — 零 LLM 调用，极简
//     · 定时 trigger 发挥 Agent 智能 — query_history 获取完整上下文
//     · memory.md 仅在每日审查时变更 → system prompt 极度稳定 → 缓存命中率极高
//     · Agent 自主决定记什么、忘什么
//
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { AgentContext } from '@core/types';
import { resolveMemoryPath, resolveMemoryUpdateMarkerPath, resolveMemoryReviewMarkerPath } from './paths';

// ============================================================
// 长期记忆 —— memory.md 读写
// ============================================================

/**
 * 加载 Agent 对 counterpart 的长期记忆。
 * 返回 memory.md 的原始内容，不存在时返回 null。
 */
export function loadMemory(agent: string, counterpart: string): string | null {
  const filePath = resolveMemoryPath(agent, counterpart);
  try {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

// ============================================================
// 归档标记检测（由 agent-session 写入）
// ============================================================

/** agent-session 归档后写入此标记，agent-memory 据此触发记忆重写 */
export function markMemoryUpdateNeeded(agent: string, counterpart: string): void {
  const filePath = resolveMemoryUpdateMarkerPath(agent, counterpart);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, '', 'utf-8');
}

/** 检查并消费归档标记（存在则返回 true 并删除标记） */
function consumeUpdateMarker(agent: string, counterpart: string): boolean {
  const filePath = resolveMemoryUpdateMarkerPath(agent, counterpart);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

// ============================================================
// 记忆审查标记（混合方案：postHook 写标记，定时 trigger 消费）
// ============================================================

/**
 * 写入记忆审查标记（不再包含 pending 计数——Agent 通过 query_history 自行检索）。
 * agent-session 归档时由 postHook 或 WebUI 手动归档调用。
 */
export function markMemoryReviewNeeded(agent: string, counterpart: string): void {
  const filePath = resolveMemoryReviewMarkerPath(agent, counterpart);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const info = JSON.stringify({
    agent,
    counterpart,
    markedAt: new Date().toISOString(),
  }, null, 2);
  fs.writeFileSync(filePath, info, 'utf-8');
  console.log(`[agent-memory] 已写入审查标记: ${agent}/${counterpart}`);
}

/**
 * 检查并消费记忆审查标记（存在则返回 true 并删除标记）。
 */
export function consumeMemoryReviewMarker(agent: string, counterpart: string): boolean {
  const filePath = resolveMemoryReviewMarkerPath(agent, counterpart);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

// ============================================================
// 记忆更新入口（postHook）
// ============================================================

/**
 * postHook 调用：检测归档标记 → 写入审查标记。
 *
 * 不再累积摘要——Agent 在定时 review 时通过 query_history 直接检索完整历史。
 */
export async function updateMemory(
  agent: string,
  counterpart: string,
  _ctx: AgentContext,
  _response: string,
): Promise<void> {
  const needsUpdate = consumeUpdateMarker(agent, counterpart);
  if (!needsUpdate) return;

  markMemoryReviewNeeded(agent, counterpart);
  console.log(`[agent-memory] 归档触发 → 已写入审查标记: ${agent}/${counterpart}`);
}

// ============================================================
// 强制记忆审查标记（WebUI 手动归档时调用）
// ============================================================

export function forceUpdateMemory(agent: string, counterpart: string): void {
  consumeUpdateMarker(agent, counterpart);
  consumeMemoryReviewMarker(agent, counterpart);

  markMemoryReviewNeeded(agent, counterpart);
  console.log(`[agent-memory] 手动归档 → 已写入审查标记: ${agent}/${counterpart}`);
}

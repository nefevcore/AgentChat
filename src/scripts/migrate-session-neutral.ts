// ============================================================
// src/scripts/migrate-session-neutral.ts —— 存量会话文件一次性迁移
// （M21 步骤 7 / D13，session-design §8-D13）
//
// 用法：npx tsx src/scripts/migrate-session-neutral.ts [数据根] [--dry-run]
//   数据根缺省 = AGENTCHAT_DATA_ROOT ?? './data'。扫描 <root>/sessions/**
//   的 messages.jsonl：旧 baked 行（user/assistant + name）→ 中性行
// （role:'agent' + agent_id）+ 补 session-header（v1）+ 回填单调 seq。
//
// 幂等：已有头行（v1）的文件不动；已带 agent_id 的行原样保留（仅补
// 头行场景不存在——见上）。迁移恒等门：同一桶迁移前后的
// history(conv,{viewer}) 投影输出逐字节同构（tests 覆盖）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

interface LegacyRow {
  role?: string;
  content?: string;
  message_id?: string;
  timestamp?: string;
  name?: string;
  source?: string;
  reasoning_content?: string;
  steps?: unknown;
  [key: string]: unknown;
}

export interface MigrateResult {
  /** 迁移后全文（含头行）；already = 原文不动 */
  text: string;
  /** 转换的行数（不含头行） */
  converted: number;
  /** 已是 v1（含头行）——幂等跳过 */
  already: boolean;
}

/**
 * 迁移单个 messages.jsonl 文本（纯函数，测试恒等门入口）。
 * 旧 baked 归属映射（与 projectRecord 兼容路径同构，§2.4）：
 *   user + name=X      → agent + agent_id=X（缺 name → 'user'）
 *   assistant + name=A → agent + agent_id=A（缺 name → conversationId——
 *                        singles 形态：会话键 = Agent id，旧行省略 name）
 *   event + name=N     → event + agent_id=N（缺 name → 'system'）
 *   system/tool        → 原样直通（无归属）
 */
export function migrateSessionText(text: string, conversationId: string): MigrateResult {
  const lines = text.split('\n');
  const out: string[] = [];
  let converted = 0;
  let hasHeader = false;
  let seq = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.trimStart().startsWith('{"type":"session-header"')) {
      hasHeader = true;
      out.push(line);
      continue;
    }
    let row: LegacyRow;
    try {
      row = JSON.parse(line) as LegacyRow;
    } catch {
      out.push(line); // 损坏行原样保留（宽容：宁可部分可用）
      continue;
    }
    seq++;
    if (row.agent_id !== undefined) {
      // 已中性行：仅回填 seq（若有缺）
      const merged = { ...row, ...(row.seq === undefined ? { seq } : {}) };
      out.push(JSON.stringify(merged));
      if (row.seq === undefined) converted++;
      continue;
    }
    const role = row.role;
    let next: Record<string, unknown>;
    if (role === 'user') {
      next = { ...row, role: 'agent', agent_id: row.name ?? 'user', seq };
    } else if (role === 'assistant') {
      next = { ...row, role: 'agent', agent_id: row.name ?? conversationId, seq };
    } else if (role === 'event') {
      next = { ...row, agent_id: row.name ?? 'system', seq };
    } else {
      // system/tool/未知：原样直通（仅补 seq）
      next = { ...row, seq };
    }
    delete next.name; // agent_id 取代（迁移后词表统一）
    out.push(JSON.stringify(next));
    converted++;
  }
  if (hasHeader && converted === 0) return { text, converted: 0, already: true };
  const header = JSON.stringify({
    type: 'session-header',
    version: 1,
    createdAt: new Date().toISOString(),
  });
  return { text: `${[header, ...out].join('\n')}\n`, converted, already: hasHeader };
}

/** 递归收集 messages.jsonl（<root>/sessions 树，含 shelf 子目录） */
function collectSessionFiles(root: string): string[] {
  const sessionsDir = path.join(root, 'sessions');
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'messages.jsonl') out.push(full);
    }
  };
  walk(sessionsDir);
  return out;
}

// ---- CLI（直接执行时）----
if (process.argv[1] !== undefined && process.argv[1].endsWith('migrate-session-neutral.ts')) {
  const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
  const dryRun = process.argv.includes('--dry-run');
  const root = path.resolve(args[0] ?? process.env.AGENTCHAT_DATA_ROOT ?? './data');
  const files = collectSessionFiles(root);
  if (files.length === 0) {
    console.error(`未找到会话文件（${path.join(root, 'sessions')}）`);
    process.exit(1);
  }
  let migrated = 0;
  let skipped = 0;
  let rows = 0;
  for (const file of files) {
    const conversationId = path.basename(path.dirname(file));
    const text = fs.readFileSync(file, 'utf-8');
    const result = migrateSessionText(text, conversationId);
    if (result.already) {
      skipped++;
      continue;
    }
    rows += result.converted;
    if (!dryRun) {
      const tmp = `${file}.${process.pid}.migrating`;
      fs.writeFileSync(tmp, result.text, 'utf-8');
      fs.renameSync(tmp, file);
    }
    migrated++;
    console.log(`${dryRun ? '[dry-run] ' : ''}${file}：${result.converted} 行 → 中性格式（+头行 +seq）`);
  }
  console.log(`完成：${migrated} 个文件迁移（${rows} 行），${skipped} 个已是 v1 跳过${dryRun ? '（dry-run 未写盘）' : ''}`);
}

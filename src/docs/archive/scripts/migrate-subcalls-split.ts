// ============================================================
// scripts/migrate-subcalls-split.ts —— 存量会话双文件迁移
//（2026-09-20 subcall 补行剥离：messages.jsonl → subcalls.jsonl）
//
// 背景：subcall 补行此前与消息行混居 messages.jsonl 且 result 被 2KB
// 截断（capSubcallResult——已废除）。本脚本把存量 subcall 补行搬至
// 同目录 subcalls.jsonl；截断形（{__truncated,bytes,head}）尽力从 head
// 前缀恢复（逐元素扫描——恢复多少算多少，无法恢复保持原样）。
//
// 幂等：重复运行无副作用（主文件无 subcall 行 = 无事可做）。
// 用法：node --experimental-strip-types scripts/migrate-subcalls-split.ts
//  （或经 npx tsx；扫描 AGENTCHAT_DATA_ROOT 或 ./data 与 ./workspace/home 的 sessions）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 迁移统计 */
let convs = 0, moved = 0, restored_count = 0, skippedTruncated = 0;

/** 截断形 head 前缀尽力恢复（复用前端 ToolResultWeb 的逐元素扫描思路，
 *  恢复不出合法结构时返回 null——保留原样搬运） */
function tryRestore(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return null;
  const r = result as { __truncated?: boolean; head?: string };
  if (r.__truncated !== true || typeof r.head !== 'string') return null;
  const head = r.head;
  // head = '{"ok":true,"output":{...' 截断前缀：目标是恢复出可解析的
  // {ok, output:{...}} 前缀对象（results 逐元素、字符串字段按完整引号闭合）
  const outIdx = head.indexOf('"output":');
  if (outIdx === -1) return null;
  const body = head.slice(outIdx + '"output":'.length);
  if (!body.startsWith('{')) {
    // output 是字符串/数组等（截断即断）——恢复 output 前缀字符串
    if (body.startsWith('"')) {
      const m = body.match(/^"((?:[^"\\]|\\.)*)/);
      if (m) return { ok: true, output: m[1] };
    }
    return null;
  }
  const obj: Record<string, unknown> = {};
  const rIdx = body.indexOf('"results":[');
  if (rIdx === -1) return null;
  const pre = body.slice(0, rIdx);
  for (const key of ['provider', 'query', 'answer']) {
    const m = pre.match(new RegExp('"' + key + '"' + String.fromCharCode(92) + 's*:' + String.fromCharCode(92) + 's*"([^"' + String.fromCharCode(92, 92) + ']*(?:' + String.fromCharCode(92, 92) + '.[^"' + String.fromCharCode(92, 92) + ']*)*)"'));
    if (m) obj[key] = m[1];
  }
  let i = rIdx + '"results":['.length;
  const results: unknown[] = [];
  while (i < body.length) {
    while (i < body.length && (body[i] === ',' || body[i] === ' ')) i++;
    if (i >= body.length || body[i] === ']' || body[i] !== '{') break;
    let depth = 0, j = i, inStr = false;
    for (; j < body.length; j++) {
      const ch = body[j]!;
      if (inStr) {
        if (ch === '\\') { j++; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0 || j >= body.length) break;
    try { results.push(JSON.parse(body.slice(i, j + 1))); } catch { break; }
    i = j + 1;
  }
  obj.results = results;
  return { ok: true, output: obj, __restoredFromTruncated: true };
}

/** 已迁移 subcalls.jsonl 的截断行恢复（首跑正则有缺陷搬了未恢复的形）：
 *  逐行 tryRestore，有恢复才重写文件（幂等——无可恢复行零改动）。 */
function restoreSubcallsFile(dir: string): void {
  const subFile = path.join(dir, 'subcalls.jsonl');
  if (!fs.existsSync(subFile)) return;
  const lines = fs.readFileSync(subFile, 'utf-8').split('\n');
  let changed = false;
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim() || !line.includes('__truncated')) { out.push(line); continue; }
    try {
      const sup = JSON.parse(line) as Record<string, unknown>;
      const restored = tryRestore(sup.result);
      if (restored !== null) {
        sup.result = restored;
        restored_count++;
        out.push(JSON.stringify(sup));
        changed = true;
        continue;
      }
      skippedTruncated++;
    } catch {
      skippedTruncated++;
    }
    out.push(line);
  }
  if (!changed) return;
  const tmp = subFile + '.' + process.pid + '.restore.tmp';
  fs.writeFileSync(tmp, out.join('\n') + '\n', 'utf-8');
  fs.renameSync(tmp, subFile);
}

function migrateConversationFile(dir: string): void {
  const file = path.join(dir, 'messages.jsonl');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf-8');
  const lines = text.split('\n');
  const kept: string[] = [];
  const subLines: string[] = [];
  let header = '';
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.trimStart().startsWith('{"type":"session-header"')) { header = line; continue; }
    if (line.trimStart().startsWith('{"type":"tool-result"') && line.includes('"subcall":true')) {
      try {
        const sup = JSON.parse(line) as Record<string, unknown>;
        const restored = tryRestore(sup.result);
        if (restored !== null) { sup.result = restored; restored_count++; }
        else if (sup.result !== null && typeof sup.result === 'object'
          && (sup.result as { __truncated?: boolean }).__truncated === true) skippedTruncated++;
        subLines.push(JSON.stringify(sup));
        moved++;
      } catch {
        subLines.push(line); // 损坏行原样搬（不丢数据）
        moved++;
      }
      continue;
    }
    kept.push(line);
  }
  if (subLines.length === 0) return; // 无 subcall 行——零改动
  convs++;
  // 主文件原子重写（去掉 subcall 行）
  const tmp = file + '.' + process.pid + '.migrate.tmp';
  fs.writeFileSync(tmp, (header ? header + '\n' : '') + kept.join('\n') + '\n', 'utf-8');
  fs.renameSync(tmp, file);
  // subcalls.jsonl 追加（幂等：主文件已无 subcall 行，重跑不进此分支）
  const subFile = path.join(dir, 'subcalls.jsonl');
  const existingHeader = fs.existsSync(subFile) ? '' : JSON.stringify({ type: 'session-header', version: 1, createdAt: new Date().toISOString() }) + '\n';
  fs.appendFileSync(subFile, existingHeader + subLines.join('\n') + '\n', 'utf-8');
}

function walk(root: string): void {
  const sessionsDir = path.join(root, 'sessions');
  if (!fs.existsSync(sessionsDir)) return;
  const visit = (d: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    // 会话目录判定：直接含 messages.jsonl
    if (fs.existsSync(path.join(d, 'messages.jsonl'))) { migrateConversationFile(d); restoreSubcallsFile(d); return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      visit(path.join(d, e.name));
    }
  };
  visit(sessionsDir);
}

const roots = [process.env.AGENTCHAT_DATA_ROOT ?? './data', './workspace/home'];
for (const root of roots) walk(root);
console.log(`[migrate-subcalls-split] 会话 ${convs} 个 | 搬迁 ${moved} 行 | 截断恢复 ${restored_count} 条 | 保持截断 ${skippedTruncated} 条`);

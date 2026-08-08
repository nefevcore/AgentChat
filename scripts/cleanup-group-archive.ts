// ============================================================
// scripts/cleanup-group-archive.ts —— 一次性整理：group~ 归档历史文件合并到新命名 + 群记忆归位
//
// 旧结构（迁移自 group__<gid>）：
//   group~<gid>/archive/<aid>/history_2026-32.jsonl      （无 W 旧命名，最新数据）
//   group~<gid>/archive/<aid>/archive/history_2026-W32.jsonl （嵌套旧归档，早期数据）
//   group~<gid>/archive/<aid>/memory.md                  （旧群记忆位置）
//
// 新规范：
//   group~<gid>/archive/<aid>/history_<YYYY>-W<WW>.jsonl （唯一命名，按时间合并）
//   files/<aid>/memory/group~<gid>.memory.md             （群记忆集中管理）
//
// 用法：npx tsx scripts/cleanup-group-archive.ts <gid>
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

const WS = process.env.AGENTCHAT_WORKSPACE || 'workspace/default';
const gid = process.argv[2];
if (!gid) { console.error('用法：npx tsx scripts/cleanup-group-archive.ts <gid>'); process.exit(1); }

const archiveRoot = path.join(WS, 'sessions', `group~${gid}`, 'archive');
if (!fs.existsSync(archiveRoot)) { console.log(`无归档：${archiveRoot}`); process.exit(0); }

/** 读取 JSONL 并按 timestamp 排序返回行数组 */
function readSortedLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const out: { line: string; ts: string }[] = [];
  for (const raw of fs.readFileSync(file, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      out.push({ line, ts: o.timestamp ?? '' });
    } catch { out.push({ line, ts: '' }); }
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts));
  return out.map(x => x.line);
}

for (const aidEntry of fs.readdirSync(archiveRoot, { withFileTypes: true })) {
  if (!aidEntry.isDirectory() || aidEntry.name.startsWith('_')) continue;
  const aid = aidEntry.name;
  const adir = path.join(archiveRoot, aid);
  const merged = path.join(adir, 'history_2026-W32.jsonl'); // 新规范命名
  const topOld = path.join(adir, 'history_2026-32.jsonl');  // 无 W 旧命名
  const nestedDir = path.join(adir, 'archive');
  const nestedOld = path.join(nestedDir, 'history_2026-W32.jsonl');

  const lines = [
    ...readSortedLines(topOld),
    ...readSortedLines(nestedOld),
  ];
  if (lines.length > 0) {
    fs.writeFileSync(merged, lines.join('\n') + '\n', 'utf-8');
    console.log(`  ✓ ${aid}: 合并 ${lines.length} 条 → history_2026-W32.jsonl`);
  }
  if (fs.existsSync(topOld)) { fs.rmSync(topOld); console.log(`  · ${aid}: 删除旧命名 history_2026-32.jsonl`); }
  if (fs.existsSync(nestedDir)) { fs.rmSync(nestedDir, { recursive: true, force: true }); console.log(`  · ${aid}: 删除嵌套 archive/`); }

  // 群记忆归位：archive/<aid>/memory.md → files/<aid>/memory/group~<gid>.memory.md
  const memOld = path.join(adir, 'memory.md');
  if (fs.existsSync(memOld)) {
    const dest = path.join(WS, 'files', aid, 'memory', `group~${gid}.memory.md`);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(memOld, dest);
      console.log(`  ✓ ${aid}: 群记忆 → files/${aid}/memory/group~${gid}.memory.md`);
    } else {
      console.log(`  · ${aid}: 群记忆目标已存在，跳过（保留旧文件由 --clean 处理）`);
    }
    fs.rmSync(memOld);
  }
}

console.log('\n整理完成。');

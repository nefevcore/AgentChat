// 基准：runs/snapshot 后端扫描路径（stats 增量 vs 全量）——真实数据根上
// 模拟「run 活跃期」每 3s 轮询的开销：对最大的 N 个会话反复 stats()，
// 中途 append 模拟 run 步级落盘。对比口径：首轮（全量建基线）+ 后续轮
// （增量）的耗时。运行：node --experimental-strip-types scripts/bench-stats.ts
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = process.env.AGENTCHAT_DATA_ROOT ?? 'workspace/home';
const sessionsDir = path.join(ROOT, 'sessions');

// 找最大的 N 个 messages.jsonl（最重的全量重扫对象）
const files: Array<{ file: string; size: number }> = [];
for (const e of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  if (fs.existsSync(path.join(sessionsDir, e.name, '.shelf'))) continue;
  const f = path.join(sessionsDir, e.name, 'messages.jsonl');
  if (fs.existsSync(f)) files.push({ file: f, size: fs.statSync(f).size });
}
for (const f of files.splice(files.length)) void f;
const top = files.sort((a, b) => b.size - a.size).slice(0, 5);
console.log(`数据根 ${sessionsDir}: 会话 ${files.length} 个；Top5 共 ${(top.reduce((s, f) => s + f.size, 0) / 1048576).toFixed(1)} MB`);

// 与 SessionService.stats 同口径的两条路径（进程外复刻，避免引 cordis boot）
const PARTIAL_MARK = '"partial":true';
const isHeaderLine = (l: string) => l.trimStart().startsWith('{"type":"session-header"');
const isToolResultLine = (l: string) => l.trimStart().startsWith('{"type":"tool-result"');
const TIMESTAMP_RE = /"timestamp"\s*:\s*"([^"]+)"/;

function fullScan(file: string): { ms: number; count: number } {
  const t0 = performance.now();
  const text = fs.readFileSync(file, 'utf-8');
  const lines = text.split('\n');
  let count = 0;
  for (const l of lines) if (l.trim() && !isHeaderLine(l) && !isToolResultLine(l) && !l.includes(PARTIAL_MARK)) count++;
  let h1 = 0, d1 = 0, d3 = 0, d7 = 0, d30 = 0;
  const now = Date.now();
  for (const line of lines) {
    if (!line || !line.trim() || line.includes(PARTIAL_MARK) || isHeaderLine(line) || isToolResultLine(line)) continue;
    const m = TIMESTAMP_RE.exec(line);
    if (!m) continue;
    const age = now - Date.parse(m[1]);
    if (age < 3_600_000) h1++;
    if (age < 86_400_000) d1++;
    if (age < 3 * 86_400_000) d3++;
    if (age < 7 * 86_400_000) d7++;
    if (age < 30 * 86_400_000) d30++;
  }
  return { ms: performance.now() - t0, count };
}

function incremental(file: string, base: number): { ms: number; count: number; newBase: number } {
  const t0 = performance.now();
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  let count = 0;
  let h1 = 0, d1 = 0, d3 = 0, d7 = 0, d30 = 0;
  try {
    const buf = Buffer.alloc(size - base);
    fs.readSync(fd, buf, 0, buf.length, base);
    const lines = buf.toString('utf-8').split('\n');
    const now = Date.now();
    for (let i = 0; i < lines.length - 1; i++) {
      const l = lines[i]!;
      if (!l.trim() || isHeaderLine(l) || isToolResultLine(l) || l.includes(PARTIAL_MARK)) continue;
      count++;
      const m = TIMESTAMP_RE.exec(l);
      if (m) {
        const age = now - Date.parse(m[1]);
        if (age < 3_600_000) h1++;
        if (age < 86_400_000) d1++;
        if (age < 3 * 86_400_000) d3++;
        if (age < 7 * 86_400_000) d7++;
        if (age < 30 * 86_400_000) d30++;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { ms: performance.now() - t0, count, newBase: size };
}

// —— 场景：5 个大会话，模拟 run 步级 append（每次 ~4KB，接近真实步行）
// 10 轮轮询 × 每轮 stats 全体 —— 旧路径 = 每轮全量重扫；新路径 = 首轮全量 + 增量 ——
const APPEND = JSON.stringify({ role: 'agent', content: 'x'.repeat(4000), agent_id: 'bench', message_id: 'bench', timestamp: new Date().toISOString() }) + '\n';

// 旧路径（全量每轮）
let oldTotal = 0;
for (let round = 0; round < 10; round++) {
  if (round > 0) for (const t of top) fs.appendFileSync(t.file, APPEND); // run 活跃：每轮有新步落盘
  const t0 = performance.now();
  for (const t of top) fullScan(t.file);
  oldTotal += performance.now() - t0;
}

// 还原：截掉 bench 追加的段（幂等——只在本会话进程内追加过）
for (const t of top) {
  const size = fs.statSync(t.file).size;
  const text = fs.readFileSync(t.file, 'utf-8');
  const lines = text.split('\n');
  const keep = lines.filter((l) => !l.includes('"message_id":"bench"'));
  if (keep.length !== lines.length) fs.writeFileSync(t.file, keep.join('\n'), 'utf-8');
  void size;
}

// 新路径（首轮全量建基线 + 增量）
let newTotal = 0;
const bases = new Map<string, number>();
for (let round = 0; round < 10; round++) {
  if (round > 0) for (const t of top) fs.appendFileSync(t.file, APPEND);
  const t0 = performance.now();
  for (const t of top) {
    const base = bases.get(t.file);
    if (base === undefined) {
      fullScan(t.file);
      bases.set(t.file, fs.statSync(t.file).size);
    } else {
      const r = incremental(t.file, base);
      bases.set(t.file, r.newBase);
    }
  }
  newTotal += performance.now() - t0;
}

// 还原追加段
for (const t of top) {
  const text = fs.readFileSync(t.file, 'utf-8');
  const lines = text.split('\n');
  const keep = lines.filter((l) => !l.includes('"message_id":"bench"'));
  if (keep.length !== lines.length) fs.writeFileSync(t.file, keep.join('\n'), 'utf-8');
}

console.log(`旧路径（每轮全量重扫 Top5）：10 轮合计 ${oldTotal.toFixed(1)} ms（平均 ${(oldTotal / 10).toFixed(1)} ms/轮）`);
console.log(`新路径（首轮全量 + 增量）：10 轮合计 ${newTotal.toFixed(1)} ms（平均 ${(newTotal / 10).toFixed(1)} ms/轮）`);
console.log(`加速比 ${(oldTotal / newTotal).toFixed(1)}x（run 活跃期每 3s 轮询的主线程同步负载）`);

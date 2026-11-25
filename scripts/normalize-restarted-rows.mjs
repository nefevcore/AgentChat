#!/usr/bin/env node
// ============================================================
// scripts/normalize-restarted-rows.mjs —— restarted-* 存量通知行归一（cr-1309）
//
// 把盘上 cr-946 前落形的「壳已重启」通知行（speech 词形：type=message +
// agent_id='user' + requestId 前缀 restarted-*）改写成现行 context+event
// 词形——解锁 3 处读侧判别分支退役（plan §八/6）。等价判据：fold view 投影
// 恒等（改写前后）；LLM 回放面包 <system-reminder> 壳为已知收敛差异（向
// cr-946 现行机制收敛——event 词 wrapForReplay 缺省 wrapper 档，非回归）。
//
// 现行机制通知行（context+event 词形）不在迁移目标内——幂等重入天然跳过。
// run 键 run-restarted-* 的步相位行是通知触发的正常续跑 run 数据，零触碰。
//
// 原子性 + 保头（cr-1308 教训）：staging 首行 = 原 session-header 原样写回
// → 重读 verify（view 投影恒等）→ rename。备份住 sandbox/（调用方先做）。
//
// 用法：node scripts/normalize-restarted-rows.mjs <dataRoot> [--dry] [--agent <glob>] [--conv <子串>]
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { foldSession, foldViewRecords } from '../packages/ac-ledger/src/fold.ts';

const args = process.argv.slice(2);
const dataRoot = args.find((a) => !a.startsWith('--'));
const dry = args.includes('--dry');
const valueOf = (n) => { const i = args.indexOf(n); const v = i >= 0 ? args[i + 1] : undefined; return v !== undefined && !v.startsWith('--') ? v : undefined; };
if (dataRoot === undefined) {
  console.error('用法：node scripts/normalize-restarted-rows.mjs <dataRoot> [--dry] [--agent <glob>] [--conv <子串>]');
  process.exit(2);
}

// 会话目录枚举（与 migrate-sessions-v2 同款：直属 + children 子域）
function sessionDirs(root) {
  const out = [];
  const addDomain = (agentDir) => {
    const sess = path.join(agentDir, 'sessions');
    let ids = [];
    try { ids = fs.readdirSync(sess, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* 无会话 */ }
    for (const convId of ids) out.push({ dir: path.join(sess, convId), convId });
  };
  let agents = [];
  try { agents = fs.readdirSync(path.join(root, 'agents'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return out; }
  for (const id of agents) {
    if (id.includes('~')) continue;
    addDomain(path.join(root, 'agents', id));
    let children = [];
    try { children = fs.readdirSync(path.join(root, 'agents', id, 'children'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* 无 children */ }
    for (const cid of children) {
      const sess = path.join(root, 'agents', id, 'children', cid, 'sessions');
      let ids = [];
      try { ids = fs.readdirSync(sess, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
      for (const convId of ids) out.push({ dir: path.join(sess, convId), convId });
    }
  }
  return out;
}

/** legacy 通知行判定：requestId 前缀 + 非 context 落形（speech 词形） */
function isLegacyRestartedRow(line) {
  if (!line.includes('restarted-')) return false;
  let o = null;
  try { o = JSON.parse(line); } catch { return false; }
  return typeof o.requestId === 'string' && o.requestId.startsWith('restarted-') && o.role !== 'context';
}

/** view 投影 canonical（对拍判据；ts 缺席读面 Date.now() 兜底的时变行归一） */
const deepNorm = (v) => {
  if (typeof v === 'number') return v > 1794000000 ? 0 : v;
  if (typeof v === 'string') return /^2026-1[12]/.test(v) && Date.parse(v) > 1794000000000 ? '<NOW>' : v;
  if (Array.isArray(v)) return v.map(deepNorm);
  if (v !== null && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = deepNorm(v[k]); return o; }
  return v;
};
function viewCanon(root, dir, convId) {
  const fold = foldSession(root, convId, [dir]);
  const view = foldViewRecords(fold, root, convId, { view: 'chat' });
  return JSON.stringify(deepNorm(view));
}

let scanned = 0, withLegacy = 0, converted = 0, failed = 0;
const failures = [];
const agentGlob = valueOf('--agent');
const convFilter = valueOf('--conv');
const globRe = agentGlob !== undefined ? new RegExp('^' + agentGlob.replaceAll('**', '.*').replaceAll('*', '[^/]*') + '$') : null;

for (const s of sessionDirs(dataRoot)) {
  if (globRe !== null && !globRe.test(s.dir)) continue;
  if (convFilter !== undefined && !s.convId.includes(convFilter)) continue;
  const file = path.join(s.dir, 'messages.jsonl');
  if (!fs.existsSync(file)) continue;
  scanned++;
  const text = fs.readFileSync(file, 'utf-8');
  const lines = text.split('\n');
  const legacyIdx = lines.map((l, i) => isLegacyRestartedRow(l) ? i : -1).filter((i) => i >= 0);
  if (legacyIdx.length === 0) continue;
  withLegacy += legacyIdx.length;
  // 头行保真（cr-1308）：首行是 session-header 则原样携带
  let headerLine = '';
  if (lines[0] !== undefined && lines[0].trim().startsWith('{"type":"session-header"')) headerLine = lines[0];
  else {
    // 无头文件（理论不该有——cr-1308 已修复全根）——如实携带首行原样
    headerLine = '';
  }
  const domain = s.dir.split(/[\\/]/).at(-3);
  const outLines = [];
  for (const l of lines) {
    if (l.trim() === '') continue;
    if (l === headerLine) { outLines.push(l); continue; }
    if (!isLegacyRestartedRow(l)) { outLines.push(l); continue; }
    const o = JSON.parse(l);
    // cr-946 现行词形：context+event（身份字段原值携带——message_id/timestamp/seq 锚不丢）
    outLines.push(JSON.stringify({
      role: 'context', source: 'event', content: o.content,
      agent_id: domain, requestId: o.requestId,
      ...(o.uuid !== undefined ? { uuid: o.uuid } : { uuid: s.convId }),
      type: 'context', message_id: o.message_id, timestamp: o.timestamp,
      ...(o.seq !== undefined ? { seq: o.seq } : {}),
    }));
  }
  const before = viewCanon(dataRoot, s.dir, s.convId);
  if (dry) { console.log('[dry] ' + path.relative(dataRoot, s.dir) + ' · ' + legacyIdx.length + ' 行'); continue; }
  // staging → verify（view 恒等）→ rename
  const staging = file + '.normalizing';
  fs.writeFileSync(staging, (headerLine !== '' ? headerLine + '\n' : '') + outLines.filter((l) => l !== '').join('\n') + '\n');
  // verify：staging 文件经临时根重读投影恒等
  const tmpRoot = path.join('sandbox', '.restart-verify');
  const tmpDir = path.join(tmpRoot, path.relative(dataRoot, s.dir));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.copyFileSync(staging, path.join(tmpDir, 'messages.jsonl'));
  // journal/subcalls 一并拷（view 投影依赖 steps 联查）
  const journalSrc = path.join(s.dir, 'journal', 'partials.jsonl');
  if (fs.existsSync(journalSrc)) { fs.mkdirSync(path.join(tmpDir, 'journal'), { recursive: true }); fs.copyFileSync(journalSrc, path.join(tmpDir, 'journal', 'partials.jsonl')); }
  const subcallsSrc = path.join(s.dir, 'subcalls.jsonl');
  if (fs.existsSync(subcallsSrc)) fs.copyFileSync(subcallsSrc, path.join(tmpDir, 'subcalls.jsonl'));
  const after = viewCanon(tmpRoot, tmpDir, s.convId);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (before !== after) {
    fs.unlinkSync(staging);
    failed++; failures.push({ dir: s.dir, why: 'view 投影不恒等' });
    continue;
  }
  fs.renameSync(staging, file);
  converted += legacyIdx.length;
  console.log(path.relative(dataRoot, s.dir) + ' · ' + legacyIdx.length + ' 行已换名');
}
console.log('归一化' + (dry ? '（dry 预演）' : '') + '：扫描 ' + scanned + ' 会话，legacy 通知行 ' + withLegacy + '，换名 ' + converted + ' 行');
for (const f of failures.slice(0, 10)) console.log('  [FAIL] ' + path.relative(dataRoot, f.dir) + ' · ' + f.why);
if (failed > 0) process.exit(1);
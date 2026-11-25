#!/usr/bin/env node
// ============================================================
// scripts/normalize-segment-rows.mjs —— 段行存量归一（cr-1306）
//
// 把盘上 `source:'segment'` 段行（v1 settlement 聚合轨迹）展开成 v2 相位
// 事件行，使读侧 aggOrder 顺序簿分支可退役（cr-1305 判据：新代已不产段行）。
//
// 等价判据（对拍面）：同一 run 的 foldStepsOf 产出语义恒等——
// content / reasoning / textBeforeTools / toolCalls / meter 族 / stepId / ts
// 全等；**seq 显式豁免**（整文件原子重写 = writer 重分配，原 seq 的直播
// 配对语义只对在途 run 有效）。判据失败即拒换名（staging 丢弃）。
//
// 原子性（照 migrate-sessions-v2.mjs）：staging 写入 → 重读对拍 → rename。
// 幂等重入：无段行的文件直接跳过。
//
// 用法：node scripts/normalize-segment-rows.mjs <dataRoot> [--dry] [--agent <glob>] [--conv <子串>]
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

import { segmentRowToPhaseRows } from '../packages/ac-ledger-core/src/segment-normalize.ts';
import { synthNullResults } from '../packages/ac-ledger-core/src/session-chain.ts';
import { domainFactsOf } from '../packages/ac-ledger-core/src/events-core.ts';
import { foldStepsOf } from '../packages/ac-ledger-core/src/fold-core.ts';
import { readLedger } from '../packages/ac-ledger/src/reader.ts';

const args = process.argv.slice(2);
const dataRoot = args.find((a) => !a.startsWith('--'));
const dry = args.includes('--dry');
const valueOf = (n) => { const i = args.indexOf(n); const v = i >= 0 ? args[i + 1] : undefined; return v !== undefined && !v.startsWith('--') ? v : undefined; };
const agentGlob = valueOf('--agent');
const convFilter = valueOf('--conv');
if (dataRoot === undefined) {
  console.error('用法：node scripts/normalize-segment-rows.mjs <dataRoot> [--dry] [--agent <glob>] [--conv <子串>]');
  process.exit(2);
}

const META = new Set(['.', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);
function globToRegExp(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*'; }
    else re += META.has(c) ? '\\' + c : c;
  }
  return new RegExp('^' + re + '$');
}

function sessionDirs(root) {
  const out = [];
  const addDomain = (agentDir, domain) => {
    const sess = path.join(agentDir, 'sessions');
    let ids = [];
    try { ids = fs.readdirSync(sess, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* 无会话 */ }
    for (const convId of ids) out.push({ dir: path.join(sess, convId), domain, convId });
  };
  let agents = [];
  try { agents = fs.readdirSync(path.join(root, 'agents'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return out; }
  for (const id of agents) {
    if (id.includes('~')) continue;
    addDomain(path.join(root, 'agents', id), id);
    let children = [];
    try { children = fs.readdirSync(path.join(root, 'agents', id, 'children'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* 无 children */ }
    for (const cid of children) addDomain(path.join(root, 'agents', id, 'children', cid), cid);
  }
  return out;
}

// cr-1307：synthNullResults 归一判据提升为库面（session-chain.ts 导出）——
// 工具经 import 单源消费，不再本地复写。

/** 每 run 步投影 canon（seq 豁免 / 空数组归一 / 键序无关；withSynth = 对拍 before 侧） */
function runStepsCanon(rows, domain, withSynth = false) {
  const facts = domainFactsOf(domain, 2, rows, [], []);
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) {
        if (k === 'seq') continue;
        const x = v[k];
        if (Array.isArray(x) && x.length === 0) continue;
        out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  const res = {};
  for (const [run, rf] of facts.runs) {
    const proj = foldStepsOf(rf, facts.subcallArchive ?? []);
    if (proj === null) { res[run] = null; continue; }
    const steps = withSynth ? synthNullResults(proj.steps, rf) : proj.steps;
    res[run] = JSON.stringify(norm(steps));
  }
  return res;
}

let scanned = 0, withSeg = 0, convertedFiles = 0, failedFiles = 0, totalSeg = 0;
const failures = [];
const dryReports = [];

for (const s of sessionDirs(dataRoot)) {
  if (agentGlob !== undefined && !globToRegExp(agentGlob).test(s.domain)) continue;
  if (convFilter !== undefined && !s.convId.includes(convFilter)) continue;
  const file = path.join(s.dir, 'messages.jsonl');
  if (!fs.existsSync(file)) continue;
  scanned++;
  // cr-1308：头行必须随产物保真（readLedger 解构 header；staging 首行写回）——
  // cr-1306 曾只取 rows → rename 后 218 文件 session-header 全丢（version/
  // createdAt/participants/kind/migrated 追溯标记），对拍面（投影恒等）测不出
  // 头行丢失——判据含头恒等即防再犯。
  const { header, rows } = readLedger(s.dir);
  const segCount = rows.filter((r) => r.source === 'segment').length;
  if (segCount === 0) continue;
  withSeg++; totalSeg += segCount;
  const before = runStepsCanon(rows, s.domain, true); // synth 归一（对齐 fold 事件路径语义）
  // —— 转换：段行原位替换为其展开行；其余行原样 ——
  const byRun = new Map();
  const outRows = [];
  const synthesized = [];
  for (const row of rows) {
    if (row.source !== 'segment') { outRows.push({ ...row }); continue; }
    const run = typeof row.run === 'string' ? row.run : '';
    const base = byRun.get(run) ?? 0;
    const r = segmentRowToPhaseRows(row, base);
    if (!r.converted) { failures.push({ dir: s.dir, why: '段行不可转换（run 缺失）' }); continue; }
    byRun.set(run, base + (Array.isArray(row.steps) ? row.steps.length : 0));
    for (const sr of r.synthesizedMeterRows) synthesized.push(run + '#' + sr);
    outRows.push(...r.rows);
  }
  // —— seq 重分配（writer 单调语义）——
  const finalRows = outRows.map((r, i) => ({ ...r, seq: i + 1 }));
  // —— 对拍（内存内：转换后的行重算投影）——
  const after = runStepsCanon(finalRows, s.domain);
  const keysBefore = Object.keys(before).sort();
  const keysAfter = Object.keys(after).sort();
  let diff = null;
  if (JSON.stringify(keysBefore) !== JSON.stringify(keysAfter)) diff = 'run 键集不等';
  else for (const k of keysBefore) { if (before[k] !== after[k]) { diff = 'run ' + k + ' 步投影不等'; break; } }
  if (diff !== null) {
    failedFiles++;
    failures.push({ dir: s.dir, why: diff });
    continue;
  }
  if (dry) {
    dryReports.push({ dir: path.relative(dataRoot, s.dir), segRows: segCount, outRows: finalRows.length, synthesized });
    continue;
  }
  // —— staging → verify（重读对拍）→ rename ——
  const staging = file + '.normalizing';
  // cr-1308：staging 首行 = 原头行原样（保真写回；无头文件如实无头——
  // 不虚构，修头走一次性补头通道）。
  const headerLine = header !== null ? JSON.stringify(header) + '\n' : '';
  fs.writeFileSync(staging, headerLine + finalRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const recheck = readLedger(s.dir); // 仍读旧文件（staging 不参与读面）
  void recheck;
  const staged = fs.readFileSync(staging, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const verify = runStepsCanon(staged, s.domain);
  let vdiff = null;
  if (JSON.stringify(Object.keys(before).sort()) !== JSON.stringify(Object.keys(verify).sort())) vdiff = 'verify run 键集不等';
  else for (const k of Object.keys(before)) { if (before[k] !== verify[k]) { vdiff = 'verify run ' + k + ' 不等'; break; } }
  if (vdiff !== null) { fs.unlinkSync(staging); failedFiles++; failures.push({ dir: s.dir, why: vdiff }); continue; }
  fs.renameSync(staging, file);
  convertedFiles++;
}

console.log('归一化' + (dry ? '（dry 预演）' : '') + '：扫描 ' + scanned + ' 会话，含段行 ' + withSeg + '（' + totalSeg + ' 行）');
if (dry) {
  for (const r of dryReports.slice(0, 20)) console.log('  ' + r.dir + ' · 段行 ' + r.segRows + ' → 行 ' + r.outRows + (r.synthesized.length ? ' · 合成计量行 ' + r.synthesized.length : ''));
  if (dryReports.length > 20) console.log('  …（共 ' + dryReports.length + ' 个）');
} else {
  console.log('  已换名 ' + convertedFiles + ' 文件；失败 ' + failedFiles);
}
for (const f of failures.slice(0, 20)) console.log('  [FAIL] ' + path.relative(dataRoot, f.dir) + ' · ' + f.why);
if (failedFiles > 0) { console.log('存在对拍失败——未换名的文件保持原样'); process.exit(1); }

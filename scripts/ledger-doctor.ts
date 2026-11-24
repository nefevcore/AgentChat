// cr-1245 B4 ledger doctor CLI：扫数据根全部会话，结构化报告违例
//（seq 合法性 / 文法未知词 / 主张对拍）。用法：node scripts/ledger-doctor.mjs [dataRoot]
// —— exit 1 当存在 error 级违例（fail-loud 审计，不修数）。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readLedger, readDomainFacts, foldSession } from '../packages/ac-ledger/src/index.ts';
import { doctorScan } from '../packages/ac-ledger-core/src/doctor.ts';
import { replayProjection, replayTokensFor } from '../packages/ac-archive-core/src/index.ts';

const dataRoot = path.resolve(process.argv[2] ?? './workspace/home');

function listSessions(root) {
  const out = [];
  let agents;
  try { agents = fs.readdirSync(path.join(root, 'agents'), { withFileTypes: true }); } catch { return out; }
  for (const a of agents) {
    if (!a.isDirectory()) continue;
    const sdir = path.join(root, 'agents', a.name, 'sessions');
    let uuids;
    try { uuids = fs.readdirSync(sdir, { withFileTypes: true }); } catch { continue; }
    for (const u of uuids) {
      if (!u.isDirectory()) continue;
      const f = path.join(sdir, u.name, 'messages.jsonl');
      if (fs.existsSync(f)) out.push({ agent: a.name, uuid: u.name, dir: path.join(sdir, u.name) });
    }
  }
  return out;
}

const sessions = listSessions(dataRoot);
const findings = [];
let scanned = 0;
for (const s of sessions) {
  const { rows } = readLedger(s.dir);
  if (rows.length === 0) continue;
  scanned++;
  const facts = readDomainFacts(s.dir, s.agent);
  const proj = replayProjection(rows, facts, null, { activeOnly: true, viewer: s.agent });
  const fs2 = doctorScan(rows, facts, { activeTokens: () => replayTokensFor(proj, s.agent) });
  for (const f of fs2) findings.push({ ...f, session: s.agent + '/' + s.uuid });
}

const bySeverity = { info: 0, warn: 0, error: 0 };
for (const f of findings) bySeverity[f.severity]++;
console.log('doctor 扫描 ' + scanned + ' 会话（' + dataRoot + '）：error ' + bySeverity.error + ' / warn ' + bySeverity.warn + ' / info ' + bySeverity.info);
for (const f of findings) {
  console.log('  [' + f.severity.toUpperCase() + '] ' + f.session + ' · ' + f.invariant + ' · ' + f.message);
}
if (bySeverity.error > 0) { console.log('存在 error 级违例——exit 1'); process.exit(1); }
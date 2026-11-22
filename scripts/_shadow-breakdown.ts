
// cr-1229 阴影体量分解（供独立复算）：逐步打印 archivedOriginal 与伪行的 token 贡献
import * as path from 'node:path';
import { readLedger, readDomainFacts, foldStepsOf, rowShadowedBy } from '../packages/ac-ledger/src/index.ts';
import { replayTokensOf, keepBudgetOf, DEFAULT_ARCHIVE_BUDGETS } from '../packages/ac-archive-core/src/index.ts';

const ROOT = 'C:/Users/xiaofeng/Documents/Dev/AgentChat/workspace/home';
const agentId = process.argv[2] ?? 'admin';
const uuid = process.argv[3] ?? 'admin~admin';
const dir = path.join(ROOT, 'agents', agentId, 'sessions', uuid);
const maxCtx = uuid === agentId + '~' + agentId ? 400_000 : 1_000_000;
const budgets = { ...DEFAULT_ARCHIVE_BUDGETS, maxContextTokens: maxCtx };
const { rows } = readLedger(dir);
const facts = readDomainFacts(dir, agentId);
const b = facts.compactions.at(-1)!;
const tsOf = (r: any) => (typeof r.ts === 'number' && Number.isFinite(r.ts)) ? r.ts
  : (typeof r.timestamp === 'string' && r.timestamp ? (Number.isFinite(Date.parse(r.timestamp)) ? Date.parse(r.timestamp) : undefined) : undefined);
const isShadowed = (r: any) => rowShadowedBy({ ...(typeof r.seq === 'number' ? { seq: r.seq } : {}), ...(tsOf(r) !== undefined ? { ts: tsOf(r) } : {}) } as any, b);

const realRows = rows.filter(isShadowed);
let realTok = 0, zeroTokRows = 0;
for (const r of realRows) { const t = replayTokensOf(r as never, agentId); realTok += t; if (t === 0) zeroTokRows++; }

const pseudo: any[] = [];
for (const [run, rf] of facts.runs) {
  const steps = foldStepsOf(rf, facts.subcallArchive.filter((s: any) => s.run === run))?.steps ?? [];
  if (steps.length === 0) continue;
  let lastSeq: any, lastTs: any;
  for (const ev of (rf as any).events) {
    if (ev.kind === 'tool-call-result') continue;
    if (ev.seq !== undefined && (lastSeq === undefined || ev.seq > lastSeq)) lastSeq = ev.seq;
    if (ev.ts !== undefined && (lastTs === undefined || ev.ts > lastTs)) lastTs = ev.ts;
  }
  for (const s of steps) if (typeof (s as any).ts === 'number' && (lastTs === undefined || (s as any).ts > lastTs)) lastTs = (s as any).ts;
  if (lastSeq !== undefined && rowShadowedBy({ seq: lastSeq, ...(lastTs !== undefined ? { ts: lastTs } : {}) } as any, b)) pseudo.push({ role: 'agent', content: '', agent_id: agentId, run, steps, message_id: 'v2-' + run, timestamp: '' });
}
const pseudoTok = pseudo.reduce((n, p) => n + replayTokensOf(p as never, agentId), 0);
const gate = keepBudgetOf(budgets) * 2;
console.log(JSON.stringify({
  boundarySeq: b.boundarySeq,
  realRows: realRows.length, realRowsWithZeroTokens: zeroTokRows, realRowTokens: realTok,
  pseudoRuns: pseudo.length, pseudoTokens: pseudoTok,
  oldGateMeasure: realTok, newGateMeasure: realTok + pseudoTok,
  gate, oldPasses: realTok > gate, newPasses: realTok + pseudoTok > gate,
}, null, 1));

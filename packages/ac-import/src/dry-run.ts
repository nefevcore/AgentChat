// 干跑探针（只读——R-10 恒等门预演验证）
import * as fs from 'node:fs';
import { scanLegacyRoot, readLegacySession, agentIdOfPairKey } from './legacy.ts';
import { projectSession } from './project.ts';
import { verifySession } from './verify.ts';

const root = process.argv[2];
if (!root || !fs.existsSync(root)) { console.error('usage: node dry-run.ts <legacyDataRoot>'); process.exit(1); }
const inv = scanLegacyRoot(root);
console.log(JSON.stringify({ pairs: inv.pairs.length, singles: inv.singles.length, groups: inv.groups.length, subagents: inv.subagents.length, unknown: inv.unknown.length, agentsStore: inv.agentsStorePath !== null }));
let totalRows = 0, totalDropped = 0, totalMaterialized = 0, problems = 0, sessions = 0;
for (const p of [...inv.pairs, ...inv.groups.map((g) => ({ conversationId: g.gid, dir: g.dir })), ...inv.subagents.map((s) => ({ conversationId: s.subId, dir: s.dir }))]) {
  try {
    const files = readLegacySession(p.dir);
    const agentId = p.conversationId.includes('~') ? agentIdOfPairKey(p.conversationId) : p.conversationId;
    const parts = p.conversationId.includes('~') ? p.conversationId.split('~') : [p.conversationId];
    const ctx = { agentId, uuid: p.conversationId, participants: parts, kind: p.conversationId.includes('~') ? 'agent-pair' : 'user' };
    const proj = projectSession(files.rows, files.partials, ctx, files.extraFiles, files.headerCreatedAt);
    const v = verifySession(files.rows, files.partials, proj);
    if (v.length > 0) { problems += v.length; console.error(`[verify] ${p.conversationId}: ${v.length} problems: ${v.slice(0, 2).map((x) => x.kind + "@" + x.detail).join(" | ")}`); }
    totalRows += proj.rows.length; totalDropped += proj.stats.dropped; totalMaterialized += proj.stats.materialized; sessions++;
  } catch (e) {
    console.error(`[skip] ${p.conversationId}: ${String(e)}`);
  }
}
console.log(JSON.stringify({ sessions, totalRows, totalDropped, totalMaterialized, problems }));
if (problems > 0) process.exit(2);
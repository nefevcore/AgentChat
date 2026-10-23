// 全量导入预演 CLI（R-10：预演目录在 preview/sandbox/——主线零写入）
import { importRoot } from './writer.ts';
const args = process.argv.slice(2);
const full = args.includes('--full'); // agents 树域 + user 账本投影（8.8 级联形态）
const [legacyRoot, targetRoot, stagingRoot] = args.filter((a) => !a.startsWith('--'));
if (!legacyRoot || !targetRoot || !stagingRoot) { console.error('usage: node import-cli.ts <legacyRoot> <targetRoot> <stagingRoot> [--full]'); process.exit(1); }
const t0 = Date.now();
let done = 0;
const { results, skipped, agentsTreeResults, userProjectionStats } = await importRoot(legacyRoot, targetRoot, stagingRoot, {
  onResult: () => { done++; if (done % 100 === 0) console.error('[progress] ' + done); },
  ...(full ? { agentsTree: true, userProjection: true } : {}),
});
const byKind: Record<string, number> = {};
for (const r of results) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
console.log(JSON.stringify({
  sessions: results.length, byKind, totalRows: results.reduce((n, r) => n + r.rows, 0),
  totalDropped: results.reduce((n, r) => n + r.dropped, 0), totalMaterialized: results.reduce((n, r) => n + r.materialized, 0),
  skipped: skipped.length, skippedKeys: skipped.map((s) => s.key),
  ...(agentsTreeResults !== undefined ? { agentsTree: { agents: agentsTreeResults.length, configs: agentsTreeResults.filter((a) => a.configConverted).length, entriesMoved: agentsTreeResults.reduce((n, a) => n + a.entriesMoved, 0), identityFiles: agentsTreeResults.reduce((n, a) => n + a.identityFilesCopied, 0) } } : {}),
  ...(userProjectionStats !== undefined ? { userProjection: userProjectionStats } : {}),
  ms: Date.now() - t0,
}, null, 1));
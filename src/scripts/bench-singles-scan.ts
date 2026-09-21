// ============================================================
// src/scripts/bench-singles-scan.ts —— singles 首扫成本基准
//
// 用法：npx tsx src/scripts/bench-singles-scan.ts [数据根=AGENTCHAT_DATA_ROOT|./data]
// 复现 app 首次 singles.list() 的完整路径并分段计时：
//   ① syncShelves（ensureShelves 触发的上架同步，幂等重放）
//   ② sortedByActivity（session.json 元数据读 + stats 冷缓存全量扫 + 排序）
//   ③ 热缓存复扫（windowCache 命中后的稳态成本）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Context } from '@agentchat/cordis';
import { SessionService } from 'ac-session';
import { SinglesService } from 'ac-singles';

const ROOT = path.resolve(process.argv[2] ?? process.env.AGENTCHAT_DATA_ROOT ?? './data');
console.log('[bench] 数据根:', ROOT);

const ctx = new Context();
ctx.plugin(SessionService, { root: ROOT });
ctx.plugin(SinglesService, { root: ROOT });

// 等两个服务就位（unify-group-storage.ts 同款手法）
let singles: any;
for (let i = 0; i < 2500; i++) {
  singles = (ctx as any).singles;
  if (singles && (ctx as any).session) break;
  await new Promise((r) => setTimeout(r, 2));
}
if (!singles || !(ctx as any).session) { console.error('[bench] 服务未就位'); process.exit(1); }

// ① 上架同步（app 首触 list() 时 ensureShelves 内跑的同一段）
const t0 = performance.now();
const nShelf = singles.syncShelves();
const tSync = performance.now() - t0;

// ② 标记已同步 → list() 只剩 sortedByActivity（元数据 + stats + 排序）
singles.shelvesSynced = true;
const t1 = performance.now();
const all: unknown[] = singles.list();
const tScan = performance.now() - t1;

// ③ 热缓存复扫（stats mtime/size 门命中，稳态）
const t2 = performance.now();
singles.list();
const tWarm = performance.now() - t2;

// 数据规模侧写（供换算）
let msgFiles = 0; let msgBytes = 0;
const singlesTree = path.join(ROOT, 'sessions', 'singles');
if (fs.existsSync(singlesTree)) {
  for (const d of fs.readdirSync(singlesTree, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const wsDir = path.join(singlesTree, d.name);
    for (const s of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const f = path.join(wsDir, s.name, 'messages.jsonl');
      if (fs.existsSync(f)) { msgFiles++; msgBytes += fs.statSync(f).size; }
    }
  }
}
console.log(`[bench] 会话数: ${all.length}（上架 ${nShelf}）`);
console.log(`[bench] ① syncShelves（幂等重放）: ${tSync.toFixed(1)} ms`);
console.log(`[bench] ② sortedByActivity（元数据+stats 冷扫+排序）: ${tScan.toFixed(1)} ms`);
console.log(`[bench] ③ 热缓存复扫: ${tWarm.toFixed(1)} ms`);
console.log(`[bench] ①+② ≈ app 首次 list() 总计: ${(tSync + tScan).toFixed(1)} ms`);
console.log(`[bench] 消息文件: ${msgFiles} 个 / ${(msgBytes / 1024 / 1024).toFixed(1)} MiB（stats 冷扫读入量）`);
process.exit(0);
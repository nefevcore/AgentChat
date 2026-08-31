// ============================================================
// src/scripts/usage-baseline.ts —— KV 缓存基线对拍（M21 步骤 6 / D9）
//
// 用法：pnpm preview:usage-baseline [数据根]
//   数据根缺省 = AGENTCHAT_DATA_ROOT ?? ./data（相对 cwd）；扫描
//   <root>/usage/usage-*.jsonl 审计流水，输出：
//   · 全局/逐日：run 数、命中率（按 prompt token 加权）、均 miss/run
//   · miss/run 分布（0 / <1k / <8k / <32k / ≥32k——识别全量 miss 簇）
//   · per-conversation miss 排行（Top 10——结构性前缀破坏点定位）
//
// 设计锚点（session-design §7.4 基线）：命中率不是目标函数，成本与
// TTFT 才是——本脚本对拍对象是"结构性破坏点"（修复前后 miss 分布与
// 全量 miss 簇的变化），不是救火式追命中率。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

interface UsageLine {
  timestamp: string;
  agent: string;
  model: string;
  finish: string;
  usage: {
    prompt?: number;
    promptAccumulated?: number;
    cacheHit?: number;
    cacheMiss?: number;
  };
  conversationId?: string;
}

const root = path.resolve(process.argv[2] ?? process.env.AGENTCHAT_DATA_ROOT ?? './data');
const usageDir = path.join(root, 'usage');

const files = fs.existsSync(usageDir)
  ? fs.readdirSync(usageDir).filter((f) => /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
  : [];
if (files.length === 0) {
  console.error(`未找到 usage 流水（${usageDir}）——先跑一段对话再对拍`);
  process.exit(1);
}

let runs = 0;
let sumHit = 0;
let sumMiss = 0;
let cacheRuns = 0; // 携带缓存计数的 run（provider 归一化后才有）
const perDay = new Map<string, { runs: number; hit: number; miss: number }>();
const perConv = new Map<string, { runs: number; hit: number; miss: number }>();
const buckets = { '0': 0, '<1k': 0, '<8k': 0, '<32k': 0, '≥32k': 0 };

for (const file of files) {
  for (const line of fs.readFileSync(path.join(usageDir, file), 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let parsed: UsageLine;
    try {
      parsed = JSON.parse(line) as UsageLine;
    } catch {
      continue; // 损坏行忽略
    }
    runs++;
    const hit = parsed.usage?.cacheHit ?? 0;
    const miss = parsed.usage?.cacheMiss ?? 0;
    const hasCache = (parsed.usage?.cacheHit ?? 0) > 0 || (parsed.usage?.cacheMiss ?? 0) > 0;
    if (hasCache) cacheRuns++;
    sumHit += hit;
    sumMiss += miss;
    const day = parsed.timestamp.slice(0, 10);
    const d = perDay.get(day) ?? { runs: 0, hit: 0, miss: 0 };
    d.runs++; d.hit += hit; d.miss += miss;
    perDay.set(day, d);
    const conv = parsed.conversationId ?? parsed.agent;
    const c = perConv.get(conv) ?? { runs: 0, hit: 0, miss: 0 };
    c.runs++; c.hit += hit; c.miss += miss;
    perConv.set(conv, c);
    if (hasCache) {
      if (miss === 0) buckets['0']++;
      else if (miss < 1_000) buckets['<1k']++;
      else if (miss < 8_000) buckets['<8k']++;
      else if (miss < 32_000) buckets['<32k']++;
      else buckets['≥32k']++;
    }
  }
}

const pct = (hit: number, miss: number): string =>
  hit + miss > 0 ? `${((hit / (hit + miss)) * 100).toFixed(1)}%` : '—';

console.log(`KV 缓存基线（${usageDir}，${files.length} 天流水）`);
console.log('──────────────────────────────────────────');
console.log(`runs=${runs}（含缓存计数 ${cacheRuns}）  加权命中率=${pct(sumHit, sumMiss)}  均miss/run=${cacheRuns > 0 ? Math.round(sumMiss / cacheRuns) : '—'}`);
console.log(`miss/run 分布：0=${buckets['0']}  <1k=${buckets['<1k']}  <8k=${buckets['<8k']}  <32k=${buckets['<32k']}  ≥32k=${buckets['≥32k']}（全量 miss 簇定位）`);
console.log('');
console.log('逐日（近 14 天）：');
const days = [...perDay.entries()].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, 14);
for (const [day, d] of days) {
  console.log(`  ${day}  runs=${String(d.runs).padStart(4)}  命中率=${pct(d.hit, d.miss).padStart(6)}  miss=${d.miss}`);
}
console.log('');
console.log('per-conversation miss 排行（Top 10——结构性破坏点）：');
const convs = [...perConv.entries()].sort((a, b) => b[1].miss - a[1].miss).slice(0, 10);
for (const [conv, c] of convs) {
  console.log(`  ${conv.padEnd(28)} runs=${String(c.runs).padStart(4)}  命中率=${pct(c.hit, c.miss).padStart(6)}  miss=${c.miss}`);
}

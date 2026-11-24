// ============================================================
// probe.mjs —— P0-B 基线采集（cr-1296；口径 = cr-258 §五）
//
// 用法：node scripts/perf-probe/probe.mjs <label> [--seconds 10]
//   --url     采集前先导航（缺省沿用当前页）
//   --seconds 采集窗（缺省 10s）
// 输出：sandbox/perf-probe/<label>.json（探针脚本住 sandbox 跑完清理
// ——本目录只留工具，报告数据按数据根纪律住 sandbox）
//
// 指标面（cr-258 §五口径）：
//   · rAF 间隔直方图（空闲/流式各采一窗）——主线程节拍画像
//   · longtask 计数与耗时分布（PerformanceObserver）
//   · JS 堆 / DOM 规模 / 活跃动画数
//   · 上翻手感：滚动事件 + commit 打点（window.__AC_FRAME_STATS__）
// ============================================================
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { attach, listTargets } from './cdp.mjs';

const args = process.argv.slice(2);
const label = args[0] ?? 'baseline';
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

/** 采窗前后各读一次兜底探针/帧统计，差分出本窗增量（cr-1299：累计值含
 *  采集前历史 + derive 重扫重复计数——窗增量才是本窗行为画像） */
const readProbes = () => cdp.eval(`JSON.stringify({
  fallbackProbes: (typeof window.__AC_FALLBACK_PROBES__ === 'function') ? window.__AC_FALLBACK_PROBES__() : null,
  frameStats: window.__AC_FRAME_STATS__ ? window.__AC_FRAME_STATS__() : null,
})`, { returnByValue: true }).then((s) => JSON.parse(s));
const seconds = Number(flag('seconds', 10));
const url = flag('url', null);
const HOST = flag('host', '127.0.0.1');
const PORT = Number(flag('port', 9222));

const ts = await listTargets(HOST, PORT);
const target = ts.find((t) => t.url.includes('127.0.0.1:3830')) ?? ts[0];
console.log('[probe] 目标:', target.title, target.url);
const cdp = await attach(HOST, PORT, target.webSocketDebuggerUrl);

if (url) {
  console.log('[probe] 导航', url);
  await cdp.navigate(url, { waitMs: 3000 });
}

// ---- 页面侧采集器（一次注入，返回取数函数）----
const INJECT = `(() => {
  if (window.__acProbe) return true;
  const state = { rafDeltas: [], longtasks: [], scrollEvents: 0, paintEntries: 0, t0: 0 };
  window.__acProbe = state;
  let last = 0;
  function tick(t) {
    if (state.t0 === 0) state.t0 = t;
    if (last !== 0) state.rafDeltas.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) state.longtasks.push({ start: e.startTime, dur: e.duration });
    }).observe({ entryTypes: ['longtask'] });
  } catch {}
  document.addEventListener('scroll', () => state.scrollEvents++, { passive: true, capture: true });
  try {
    new PerformanceObserver((list) => { state.paintEntries += list.getEntries().length; },
    ).observe({ entryTypes: ['paint'] });
  } catch {}
  return true;
})()`;

await cdp.eval(INJECT);
await cdp.eval('window.__acProbe.rafDeltas.length = 0; window.__acProbe.longtasks.length = 0; window.__acProbe.scrollEvents = 0');

// ---- CDP 侧 metrics（采样序列）----
await cdp.send('Performance.enable');
const metricSamples = [];
const metricTimer = setInterval(async () => {
  try {
    const { metrics } = await cdp.send('Performance.getMetrics');
    metricSamples.push(Object.fromEntries(metrics.map((m) => [m.name, m.value])));
  } catch {}
}, 1000);

// cr-1301 采集前置断言：hidden 页 rAF 不回调 / setTimeout 受 intensive
// throttling / computed 不被渲染求值——frameStats 与探针双双冻结，读数无意义
// （曾据此类读数误判「帧没到前端」）。hidden 直接判无效并显式报告。
const visibility = await cdp.eval('document.visibilityState');
const pageVisible = visibility === 'visible';
if (!pageVisible) {
  console.error(`[probe] ✗ 无效采集：页面 visibilityState=${visibility}——hidden 页帧统计与探针必冻结，本窗读数不作证据。请将页面置前台后重跑。`);
}

console.log(`[probe] 采集 ${seconds}s …`);
const probesBefore = await readProbes();
await new Promise((r) => setTimeout(r, seconds * 1000));
clearInterval(metricTimer);
const probesAfter = await readProbes();
const delta = (a, b) => {
  if (a === null || b === null) return null;
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  const out = {};
  // 形状归一：旧读面值为纯数字（cr-1299 前页面），新读面 {hits, rows}
  const norm = (v) => (typeof v === 'number' ? { hits: v, rows: null } : (v ?? { hits: 0, rows: 0 }));
  for (const k of keys) {
    if (b[k] === undefined) { out[k] = { hitDelta: 0, rowsDelta: null, final: a[k] }; continue; } // 仅首读在场（本窗零命中）
    const va = norm(a[k]);
    const vb = norm(b[k]);
    out[k] = {
      hitDelta: vb.hits - va.hits,
      rowsDelta: vb.rows === null || va.rows === null ? null : vb.rows - va.rows, // 旧形状无 rows——缺席而非 0
      final: b[k],
    };
  }
  return out;
};
const fallbackProbesDelta = delta(probesBefore.fallbackProbes, probesAfter.fallbackProbes);
const frameStatsDelta = (() => {
  const a = probesBefore.frameStats, b = probesAfter.frameStats;
  if (a === null || b === null) return null;
  return {
    frames: b.frames - a.frames, tasks: b.tasks - a.tasks, commits: b.commits - a.commits,
    maxCommitsPerFrame: b.maxCommitsPerFrame, idleCommits: b.idleCommits - a.idleCommits,
  };
})();

// ---- 取数 ----
const pageData = await cdp.eval(`JSON.stringify({
  rafDeltas: window.__acProbe.rafDeltas,
  longtasks: window.__acProbe.longtasks,
  scrollEvents: window.__acProbe.scrollEvents,
  domNodes: document.querySelectorAll('*').length,
  heap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null,
  animations: document.getAnimations ? document.getAnimations().length : -1,
  frameStats: window.__AC_FRAME_STATS__ ? window.__AC_FRAME_STATS__() : null,
  fallbackProbes: (typeof window.__AC_FALLBACK_PROBES__ === 'function') ? window.__AC_FALLBACK_PROBES__() : null,
})`, { returnByValue: true });
const d = JSON.parse(pageData);

// ---- 统计 ----
function histogram(arr, buckets) {
  const h = Object.fromEntries(buckets.map((b) => [b.label, 0]));
  for (const v of arr) {
    for (const b of buckets) if (v <= b.max) { h[b.label]++; break; }
  }
  return h;
}
const rafBuckets = [
  { label: '≤16.7ms(60fps)', max: 16.7 },
  { label: '≤33ms(30fps)', max: 33 },
  { label: '≤50ms', max: 50 },
  { label: '≤67ms(15fps)', max: 67 },
  { label: '≤100ms', max: 100 },
  { label: '>100ms', max: Infinity },
];
const deltas = d.rafDeltas.filter((x) => x > 0);
const sorted = [...deltas].sort((a, b) => a - b);
const pct = (p) => sorted.length ? sorted[Math.floor(sorted.length * p / 100)] : null;
const fps = deltas.length ? 1000 / (deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0;
const ltSorted = [...d.longtasks.map((t) => t.dur)].sort((a, b) => a - b);

const report = {
  label, capturedAt: new Date().toISOString(), url: target.url, seconds,
  /** cr-1301：采集有效性门——false 表示页面处于 hidden，全部帧/探针指标不可用 */
  pageVisible,
  userAgent: await cdp.eval('navigator.userAgent'),
  raf: {
    frames: deltas.length, avgFps: Math.round(fps * 10) / 10,
    histogram: histogram(deltas, rafBuckets),
    p50: pct(50), p95: pct(95), p99: pct(99), max: sorted.at(-1) ?? null,
  },
  longtasks: {
    count: d.longtasks.length,
    totalMs: Math.round(d.longtasks.reduce((a, b) => a + b.dur, 0)),
    perSec: Math.round((d.longtasks.length / seconds) * 10) / 10,
    histogram: histogram(ltSorted, [
      { label: '50-100ms', max: 100 }, { label: '100-250ms', max: 250 },
      { label: '250-500ms', max: 500 }, { label: '>500ms', max: Infinity },
    ]),
  },
  dom: { nodes: d.domNodes, animations: d.animations },
  heap: d.heap ? { usedMB: Math.round(d.heap.used / 1048576), totalMB: Math.round(d.heap.total / 1048576) } : null,
  scrollEvents: d.scrollEvents,
  frameStats: d.frameStats,
  fallbackProbes: d.fallbackProbes,
  probesDelta: fallbackProbesDelta,
  frameStatsDelta,
  cdpMetrics: metricSamples.length ? {
    lastJSHeapUsedMB: metricSamples.at(-1)?.JSHeapUsedSize ? Math.round(metricSamples.at(-1).JSHeapUsedSize / 1048576) : null,
    lastNodes: metricSamples.at(-1)?.Nodes ?? null,
    layoutCount: metricSamples.at(-1)?.LayoutCount ?? null,
    styleRecalcCount: metricSamples.at(-1)?.RecalcStyleCount ?? null,
  } : null,
};

mkdirSync('sandbox/perf-probe', { recursive: true });
const out = `sandbox/perf-probe/${label}.json`;
writeFileSync(out, JSON.stringify(report, null, 2));
console.log('[probe] 报告:', out);
console.log(JSON.stringify({ raf: report.raf, longtasks: { count: report.longtasks.count, perSec: report.longtasks.perSec }, dom: report.dom, heap: report.heap, frameStats: report.frameStats }, null, 2));
await cdp.close();
process.exit(0);

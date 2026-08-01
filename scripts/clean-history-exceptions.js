// ============================================================
// clean-history-exceptions.js —— 清洗历史数据异常
//
// 背景（2026-08-01 分析会话记录时发现）：
//   1. 归档时 timestamp 被批量改写为归档时刻（archive.ts 旧代码 new Date()）
//      导致几百条消息挤在同一毫秒，历史时间线失真
//   2. history_9 <-> history_10 存在 81 条相同 message_id（二次归档去重错位）
//      导致查询时大段内容重复显示
//
// 处理（保持文件边界，不改变 loadHistory 只读 messages.jsonl 的现状）：
//   1. 每个文件内用 message_id 内嵌的 epoch 恢复被改写的 timestamp
//      （msg-<epoch>-<rand> 格式，id 时间即消息原始生成时间）
//   2. 跨文件按 message_id 去重：保留最新文件中的副本，从旧文件删除重复行
//   3. 无 message_id 的消息保持原样（无法可靠恢复/去重）
// ============================================================

const fs = require('fs');
const path = require('path');

const SESSIONS = path.join(process.cwd(), 'workspace/default/sessions');

/** 恢复单条消息 timestamp：用 message_id epoch，差异 > 5 分钟才覆盖 */
function restoreTs(m) {
  if (!m.message_id) return false;
  const mm = m.message_id.match(/^msg-(\d+)-/);
  if (!mm) return false;
  const idTs = parseInt(mm[1]);
  const curTs = m.timestamp ? new Date(m.timestamp).getTime() : NaN;
  if (!curTs || Math.abs(curTs - idTs) > 300000) {
    m.timestamp = new Date(idTs).toISOString();
    return true;
  }
  return false;
}

/** 处理一对会话目录 */
function processPair(agentA, agentB) {
  const [lo, hi] = [agentA, agentB].sort();
  const pairDir = path.join(SESSIONS, lo, hi);
  if (!fs.existsSync(pairDir)) return null;

  const archiveDir = path.join(pairDir, 'archive');
  const mainPath = path.join(pairDir, 'messages.jsonl');

  // 源列表（旧→新）：history_1..N + messages.jsonl
  const sources = [];
  if (fs.existsSync(archiveDir)) {
    const files = fs.readdirSync(archiveDir)
      .filter((f) => /^history_\d+\.jsonl$/.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
    for (const f of files) sources.push(path.join(archiveDir, f));
  }
  if (fs.existsSync(mainPath)) sources.push(mainPath);
  if (sources.length === 0) return null;

  // 第一遍：从新→旧扫描，记录每个 message_id 应保留的位置
  // latestPos: mid -> sourceIndex（新文件的 index 大）
  const latestPos = new Map();
  for (let si = sources.length - 1; si >= 0; si--) {
    const lines = fs.readFileSync(sources[si], 'utf-8').split('\n').filter(Boolean);
    for (let li = 0; li < lines.length; li++) {
      try {
        const m = JSON.parse(lines[li]);
        if (m.message_id && !latestPos.has(m.message_id)) {
          latestPos.set(m.message_id, si);
        }
      } catch (e) {}
    }
  }

  // 第二遍：逐文件重写
  let dupRemoved = 0;
  let tsRestored = 0;
  let totalKept = 0;

  for (let si = 0; si < sources.length; si++) {
    const srcPath = sources[si];
    const lines = fs.readFileSync(srcPath, 'utf-8').split('\n').filter(Boolean);
    const kept = [];
    for (const line of lines) {
      try {
        const m = JSON.parse(line);
        // 跨文件去重：该消息的最新位置不是当前文件 → 删除
        if (m.message_id && latestPos.get(m.message_id) !== si) {
          dupRemoved++;
          continue;
        }
        // 恢复 timestamp
        if (restoreTs(m)) tsRestored++;
        kept.push(JSON.stringify(m));
      } catch (e) { /* skip invalid */ }
    }
    totalKept += kept.length;
    fs.writeFileSync(srcPath, kept.join('\n') + (kept.length ? '\n' : ''), 'utf-8');
  }

  return { pair: `${lo}/${hi}`, kept: totalKept, dupRemoved, tsRestored };
}

// 扫描所有 pair
const agents = fs.readdirSync(SESSIONS).filter((d) => {
  try { return fs.statSync(path.join(SESSIONS, d)).isDirectory(); } catch { return false; }
});

let totalDup = 0, totalRestored = 0, totalKept = 0;
const processed = [];

for (const a of agents) {
  let inner;
  try { inner = fs.readdirSync(path.join(SESSIONS, a)); } catch { continue; }
  for (const b of inner) {
    if (b === 'archive' || b.startsWith('.')) continue;
    const p = path.join(SESSIONS, a, b);
    try { if (!fs.statSync(p).isDirectory()) continue; } catch { continue; }
    const r = processPair(a, b);
    if (r) {
      totalDup += r.dupRemoved;
      totalRestored += r.tsRestored;
      totalKept += r.kept;
      if (r.dupRemoved || r.tsRestored) {
        processed.push(r);
      }
    }
  }
}

console.log('=== 清洗完成 ===');
processed.forEach((p) => console.log(` ${p.pair}: 保留 ${p.kept} 条, 去重 ${p.dupRemoved}, 恢复时间戳 ${p.tsRestored}`));
console.log(`\n合计: 保留 ${totalKept} 条, 去重 ${totalDup} 条, 恢复时间戳 ${totalRestored} 条`);

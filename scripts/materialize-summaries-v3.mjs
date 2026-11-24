#!/usr/bin/env node
// ============================================================
// scripts/materialize-summaries-v3.mjs —— 摘要载体归一 V3 物化工具（cr-1274）
//
// 存量摘要 summary.md 物化为
// archive-summary 注入行（V3 单源形态——cr-1189 词形，与 archive 行
// deliverRow 同款写面 LedgerWriter.deliver：requestId 幂等 + allocSeq
// 续接 + append/fsync）。物化后回放头单源序只剩 foldDigestOf 一级，
// V1/V2 摘要读面随批退役（summaryTextOf / foldSummaryOf / 概要窗）。
//
// timestamp 取当前时刻：cr-1156 时刻放行（ts > 任一历史代 endTs）
// 恒不被 shadow；后续正常压缩轮滚动出新 V3 行时本行按序被新一代
// shadow——滚动语义不变。
//
// 用法：node scripts/materialize-summaries-v3.mjs <dataRoot> [--dry]
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readLedger, readJournal, readSubcalls } from '../packages/ac-ledger/src/reader.ts';
import { LedgerWriter } from '../packages/ac-ledger/src/writer.ts';
import { domainFactsOf } from '../packages/ac-ledger-core/src/events-core.ts';
import { emptyFold, foldFromFacts, foldDigestOf } from '../packages/ac-ledger-core/src/fold-core.ts';

const args = process.argv.slice(2);
const dataRoot = args.find((a) => !a.startsWith('--'));
const dry = args.includes('--dry');
if (dataRoot === undefined) {
  console.error('用法：node scripts/materialize-summaries-v3.mjs <dataRoot> [--dry]');
  process.exit(2);
}

/** 会话域条目（agents/<id>/sessions + children 子域——迁移工具同款遍历） */
function sessionDirs(root) {
  const out = [];
  const addDomain = (agentDir, domain) => {
    const sess = path.join(agentDir, 'sessions');
    let ids = [];
    try { ids = fs.readdirSync(sess, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* 域无会话 */ }
    for (const convId of ids) out.push({ dir: path.join(sess, convId), domain, convId });
  };
  let agents = [];
  try { agents = fs.readdirSync(path.join(root, 'agents'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* 无 agents 域 */ }
  for (const id of agents) {
    if (id.includes('~')) continue;
    addDomain(path.join(root, 'agents', id), id);
    let children = [];
    try { children = fs.readdirSync(path.join(root, 'agents', id, 'children'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* 无 children */ }
    for (const cid of children) addDomain(path.join(root, 'agents', id, 'children', cid), cid);
  }
  return out;
}

/** summary.md 文本（物化取源——退役前的最后读它一次） */
function mdTextOf(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'summary.md'), 'utf-8').trim();
  } catch {
    return '';
  }
}

const stats = { materialized: 0, digestAlready: 0, mdRetired: 0, noSummary: 0, error: 0, total: 0 };
console.log('数据根：' + dataRoot + (dry ? '（--dry 预演——零写入）' : ''));
for (const s of sessionDirs(dataRoot)) {
  stats.total++;
  const mdFile = path.join(s.dir, 'summary.md');
  const mdText = mdTextOf(s.dir);
  const { header, rows } = readLedger(s.dir);
  if (header === null && rows.length === 0) continue; // 空会话
  try {
    const facts = domainFactsOf(s.domain, header?.version ?? 1, rows, readJournal(s.dir), readSubcalls(s.dir));
    const fold = emptyFold();
    foldFromFacts(fold, facts);
    const digest = foldDigestOf(fold);
    if (digest !== null) {
      stats.digestAlready++;
      // V3 已单源：summary.md 是死文件 → 转挂 .migrated（审计副本）
      if (mdText !== '') {
        stats.mdRetired++;
        console.log('  ' + (dry ? '[dry] ' : '') + 'md 转挂 .migrated（V3 行已单源）— ' + s.domain + ' — ' + s.convId);
        if (!dry) fs.renameSync(mdFile, mdFile + '.migrated');
      }
      continue;
    }
    // digest null：唯一取源 = summary.md（v2 代取源已死——cr-1192 起压缩写面不写
    // summary 字段，摘要住 V3 行；cr-1274 读面退役后存量亦已全量物化）
    if (mdText === '') continue; // 无任何摘要：不动
    const text = mdText;
    stats.materialized++;
    const note = `物化 summary.md（${text.length} 字）→ V3 行 + md 转挂`;
    console.log('  ' + (dry ? '[dry] ' : '') + note + ' — ' + s.domain + ' — ' + s.convId);
    if (!dry) {
      const writer = new LedgerWriter(s.dir, { participants: header?.participants ?? [s.domain], kind: header?.kind ?? 'user' });
      const ok = await writer.deliver({
        role: 'context',
        source: 'archive-summary',
        content: text,
        label: '归档总结',
        agent_id: s.domain,
        requestId: 'archive-migrate-' + s.convId + '-summary',
        uuid: s.convId,
      });
      if (!ok) throw new Error('deliver 幂等命中（重入？requestId 已在场）');
      if (mdText !== '') fs.renameSync(mdFile, mdFile + '.migrated');
    }
  } catch (err) {
    stats.error++;
    console.error('  ✗ ' + s.domain + ' — ' + s.convId + ' — ' + (err instanceof Error ? err.message : String(err)));
  }
}
console.log('');
console.log('==== 摘要物化报告（' + (dry ? 'dry-run' : '执行') + '）====');
console.log('物化 V3 行            : ' + stats.materialized);
console.log('已单源（跳过）        : ' + stats.digestAlready);
console.log('  其中 md 转挂        : ' + stats.mdRetired);
console.log('无摘要会话（不动）    : ' + (stats.total - stats.materialized - stats.digestAlready - stats.error));
console.log('错误                  : ' + stats.error);
console.log('会话目录总数          : ' + stats.total);
if (stats.error > 0) process.exitCode = 1;

#!/usr/bin/env node
// ============================================================
// scripts/migrate-outbound-user-rows.mjs —— agent→user 出站行迁 user 域（cr-1344）
//
// cr-1343 user 域对称化批 C：send_agent(user) 的存量出站行（agent 域
// deliver 跨壳分支产物：role=agent + agent_id=sender=域 + delivered:true
// + 无 run 键）迁入 user 域入站行（agents/user/sessions/<uuid>/——与
// user 桩落账同形态），agent 域原行剔除（出站行退役——user 域行是唯一
// 正身；sender 工作记忆由 tool 对承载）。
//
// 目标会话桶：pair 含 user 端点（agent~user 对桶）或 uuid 形 single 桶——
// send_agent(user) 语境路由的两种落桶形态（cr-1339）。agent~agent 委托桶
// 出站行不迁（双域投影是保留语义——本批边界）。机制行/终稿行（delivered
// 缺席 / 'final'）零触碰。
//
// 幂等：user 域同 requestId 行在场 → 跳过；agent 域行已剔 → 第二轮空转。
// 原子性：agent 域重写走 staging + verify + rename（cr-1308 教训）；user 域
// 追加走 LedgerWriter.deliver（requestId 准入幂等）。
//
// 用法：node scripts/migrate-outbound-user-rows.mjs <dataRoot> [--dry] [--agent <glob>]
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseKey, pairIncludes } from '../packages/ac-conv-keys/src/index.ts';
import { LedgerWriter, sessionDir, readLedger } from '../packages/ac-ledger/src/index.ts';

const args = process.argv.slice(2);
const dataRoot = args.find((a) => !a.startsWith('--'));
const dry = args.includes('--dry');
const valueOf = (n) => { const i = args.indexOf(n); const v = i >= 0 ? args[i + 1] : undefined; return v !== undefined && !v.startsWith('--') ? v : undefined; };
const agentGlob = valueOf('--agent');
if (dataRoot === undefined) {
  console.error('用法：node scripts/migrate-outbound-user-rows.mjs <dataRoot> [--dry] [--agent <glob>]');
  process.exit(2);
}

/** 出站行目标桶判定：user 对桶或 uuid 形 single 桶（send_agent(user) 落桶形态） */
function isUserBucket(convId) {
  const k = parseKey(convId);
  if (k.shape === 'pair') return pairIncludes(convId, 'user');
  return k.shape === 'uuid';
}

/** 会话目录枚举（migrate-sessions-v2 同款：直属 + children 子域） */
function sessionDirs(root) {
  const out = [];
  let agents = [];
  try { agents = fs.readdirSync(path.join(root, 'agents'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return out; }
  for (const id of agents) {
    if (id === 'user') continue; // 写者域自身（迁移目标侧——非源）
    if (agentGlob !== undefined && !globMatch(agentGlob, id)) continue;
    const addDomain = (agentDir) => {
      const sess = path.join(agentDir, 'sessions');
      let ids = [];
      try { ids = fs.readdirSync(sess, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* 无会话 */ }
      for (const convId of ids) out.push({ dir: path.join(sess, convId), convId, agent: id });
    };
    addDomain(path.join(root, 'agents', id));
    let children = [];
    try { children = fs.readdirSync(path.join(root, 'agents', id, 'children'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* 无 children */ }
    for (const cid of children) {
      const sess = path.join(root, 'agents', id, 'children', cid, 'sessions');
      let ids = [];
      try { ids = fs.readdirSync(sess, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
      for (const convId of ids) out.push({ dir: path.join(sess, convId), convId, agent: id });
    }
  }
  return out;
}

function globMatch(glob, s) {
  const re = new RegExp('^' + glob.replace(/[.+^${}()|[\\]\\*?]/g, (ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : '\\' + ch)) + '$');
  return re.test(s);
}

let migrated = 0; // 迁入 user 域行数
let removed = 0; // agent 域剔除行数
let skipped = 0; // user 域已在场（幂等跳过）
const touched = [];

for (const { dir, convId, agent } of sessionDirs(dataRoot)) {
  if (!isUserBucket(convId)) continue;
  const file = path.join(dir, 'messages.jsonl');
  if (!fs.existsSync(file)) continue;
  const { rows } = readLedger(dir);
  // 出站行：agent 自著 + delivered:true + 无 run 键（run 键行 = 终稿/通知，正主在 agent 域）
  const outbound = rows.filter((r) => r.role === 'agent' && r.agent_id === agent && r.delivered === true && r.run === undefined);
  if (outbound.length === 0) continue;
  // user 域既有键（幂等判据）
  const uDir = sessionDir(dataRoot, 'user', convId);
  const uKeys = new Set(readLedger(uDir).rows.map((r) => r.requestId ?? r.message_id).filter((k) => k !== undefined));
  const fresh = outbound.filter((r) => !uKeys.has(r.requestId));
  skipped += outbound.length - fresh.length;
  console.log(`[${agent}] ${convId}：出站行 ${outbound.length}（迁 ${fresh.length} / 幂等跳过 ${outbound.length - fresh.length}）`);
  if (!dry) {
    if (fresh.length > 0) {
      // 迁入 user 域（LedgerWriter——requestId 准入 + 保头；participants 首建）
      const w = new LedgerWriter(uDir, { participants: ['user'], kind: 'user' });
      for (const r of fresh) {
        await w.deliver({
          role: 'agent',
          content: r.content,
          agent_id: r.agent_id,
          requestId: r.requestId,
          uuid: convId,
          ...(r.runMs !== undefined ? { runMs: r.runMs } : {}),
          delivered: true,
          ...(r.timestamp !== undefined ? { timestamp: r.timestamp } : {}),
        });
      }
      migrated += fresh.length;
    }
    // agent 域剔除出站行（staging 原子重写保头）
    const outSet = new Set(outbound.map((r) => r.message_id));
    const text = fs.readFileSync(file, 'utf-8');
    const lines = text.split('\n');
    const kept = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        const row = JSON.parse(line);
        if (row.role === 'agent' && row.agent_id === agent && row.delivered === true && row.run === undefined && outSet.has(row.message_id)) {
          removed++;
          continue;
        }
      } catch { /* 坏行原样保留 */ }
      kept.push(line);
    }
    const staging = file + '.migrate-tmp';
    fs.writeFileSync(staging, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf-8');
    // verify：staging 可解析行数 = 原 rows - 剔除数（与 readLedger 同口径——
    // 坏行保留在 kept 但不计数；对账防剔除判据误伤）
    let after = 0;
    for (const line of kept) {
      try { if (JSON.parse(line).type !== 'session-header') after++; } catch { /* 坏行不计数 */ }
    }
    const expect = rows.length - outbound.length;
    if (after !== expect) {
      fs.rmSync(staging, { force: true });
      console.error(`  ✗ ${dir} 剔除后行数对账失败（${after} ≠ ${expect}）——跳过该会话（未写回）`);
      continue;
    }
    fs.renameSync(staging, file);
    touched.push(dir);
  } else {
    // dry：只记账
    migrated += fresh.length;
    removed += outbound.length;
  }
}

console.log(dry ? '[dry] 迁移计划：' : '迁移完成：' + `迁入 ${migrated} 行 / 剔除 ${removed} 行 / 幂等跳过 ${skipped} 行；触及会话目录 ${dry ? touched.length : touched.length}`);
if (!dry && touched.length > 0) {
  console.log('触及目录：');
  for (const d of touched) console.log('  ' + d);
}

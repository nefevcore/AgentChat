#!/usr/bin/env node
// ============================================================
// scripts/migrate-sessions-v2.mjs —— v1 存量会话全量迁移工具（M-B cr-1271）
//
// 链驱动（runChain）：探测/换算代码零——SESSION_CHAIN 边（cr-1270）+
// migrateSessionForm 产物面（头行 + v2 行序列）；对账判据单源
// sessionFactsEqual（facts 相等 ⇔ fold 四投影恒等——cr-1270 裁决 3）。
// 一次性迁移脚本禁令（cr-1036）：新增换档 = 注册新边，本文件不长换算代码。
//
// 原子性：staging 写入 → verify（重读再对账）→ rename 换名 →
// journal/subcalls 转挂 .migrated（agent.patch 批 3 同款先例——旧读者
// 窗口退役，留审计副本）。换名先于转挂：v2 头与 journal 原名同场时
// domainFactsOf 会把 journal 相位事件重复并入 runs（双计），先换头后
// 转挂则中间态只多出 inject 事件副本（fold steps 走段行 aggregated
// 优先，无消费面）——崩溃窗口伤害最小序。幂等重入：v2 头跳过；v2 头 +
// journal 原名在场 = 上次中断 → 补转归档后报告。
//
// 用法：node scripts/migrate-sessions-v2.mjs <dataRoot> [--dry] [--agent <glob>] [--conv <子串>]
//   --agent：glob 匹配 <agent>（直属域）或 <parent>/children/<child>（子域）
//   --conv ：会话 id 子串过滤
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

// TS 源直载（Node strip-only——与仓内 boot 链同形态，零构建产物依赖）
import { splitHeader, migrateSessionForm, sessionFactsEqual } from '../packages/ac-ledger-core/src/session-chain.ts';
import { domainFactsOf } from '../packages/ac-ledger-core/src/events-core.ts';
import { readLedger, readJournal, readSubcalls } from '../packages/ac-ledger/src/reader.ts';

// —— CLI ——
const args = process.argv.slice(2);
const dataRoot = args.find((a) => !a.startsWith('--'));
const dry = args.includes('--dry');
const valueOf = (name) => {
  const at = args.indexOf(name);
  const v = at >= 0 ? args[at + 1] : undefined;
  return v !== undefined && !v.startsWith('--') ? v : undefined;
};
const agentGlob = valueOf('--agent');
const convFilter = valueOf('--conv');
if (dataRoot === undefined) {
  console.error('用法：node scripts/migrate-sessions-v2.mjs <dataRoot> [--dry] [--agent <glob>] [--conv <子串>]');
  process.exit(2);
}

// —— 会话目录枚举：agents/<id>/sessions 与 agents/<id>/children/<cid>/sessions ——
const META = new Set(['.', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

/** glob → RegExp（** 跨段递归 + * 段内通配；其余字符字面量） */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; }
      else { re += '[^/]*'; }
    } else {
      re += META.has(c) ? '\\' + c : c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** 会话域条目（agent 直属 + children 子域；~ 流域目录不物化档案） */
function sessionDirs(root) {
  const out = [];
  const addDomain = (agentDir, domain, parent) => {
    const sess = path.join(agentDir, 'sessions');
    let ids = [];
    try { ids = fs.readdirSync(sess, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* 域无会话 */ }
    for (const convId of ids) out.push({ dir: path.join(sess, convId), domain, convId, parent });
  };
  let agents = [];
  try { agents = fs.readdirSync(path.join(root, 'agents'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* 无 agents 域 */ }
  for (const id of agents) {
    if (id.includes('~')) continue;
    addDomain(path.join(root, 'agents', id), id, null);
    let children = [];
    try { children = fs.readdirSync(path.join(root, 'agents', id, 'children'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* 无 children */ }
    for (const cid of children) addDomain(path.join(root, 'agents', id, 'children', cid), cid, id);
  }
  return out;
}

const SIDECARS = [path.join('journal', 'partials.jsonl'), 'subcalls.jsonl'];
const MESSAGES = 'messages.jsonl';
const STAGING_SUFFIX = '.migrate-staging';

/** journal/subcalls 原名在场集合（转挂 .migrated 的候选） */
function sidecarHits(dir) {
  return SIDECARS.filter((rel) => fs.existsSync(path.join(dir, rel)));
}

/** 原名 → .migrated（目标在场即抛——不覆盖既有审计副本） */
function renameSidecars(dir, rels) {
  for (const rel of rels) {
    const from = path.join(dir, rel);
    const to = from + '.migrated';
    if (fs.existsSync(to)) throw new Error('目标已在场（拒绝覆盖审计副本）：' + to);
    fs.renameSync(from, to);
  }
}

/** 整文件 JSONL 解析（staging verify 面——撕裂/编码漂移即抛，不静默跳行） */
function readJsonlStrict(file) {
  const text = fs.readFileSync(file, 'utf-8');
  let header = null;
  const rows = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parsed = JSON.parse(line);
    if (parsed !== null && typeof parsed === 'object' && parsed.type === 'session-header') { header = parsed; continue; }
    rows.push(parsed);
  }
  return { header, rows };
}

/** 头行继承断言：旧头全字段（type/version 升格键除外）在 v2 头中等值在场 */
function headerInheritOk(oldHeader, newHeader) {
  return Object.entries(oldHeader).every(([k, v]) =>
    k === 'type' || k === 'version' || JSON.stringify(newHeader[k]) === JSON.stringify(v),
  );
}

/**
 * 处理单会话域。返回：
 *   { status: 'v1', note }    已迁移（--dry = 可迁移预演，零写入）
 *   { status: 'v2' }          已最新（跳过）
 *   { status: 'residue', note } 上次中断残留 → journal/subcalls 补转 .migrated
 *   { status: 'empty' }       无可迁面（空会话）
 *   { status: 'journal-only' } messages.jsonl 缺席、仅 journal——崩溃孤儿域（M-C 前置判定）
 * 不可迁显式抛错（fail-loud——不静默兜底）。
 */
function processSession(s, isDry) {
  const { header, rows } = readLedger(s.dir);
  const sidecars = sidecarHits(s.dir);
  if (header === null && rows.length === 0) {
    return sidecars.length > 0 ? { status: 'journal-only' } : { status: 'empty' };
  }
  const version = Number(header?.version ?? 1);
  if (version >= 2) {
    if (sidecars.length === 0) return { status: 'v2' };
    // 中断残留：换名已落、转挂未落——补齐（幂等重入窗口）
    if (!isDry) renameSidecars(s.dir, sidecars);
    return { status: 'residue', note: 'journal/subcalls 补转 .migrated（上次中断残留）' };
  }
  // —— v1/v0 → v2（链驱动 + 对账 + staging 原子换名）——
  const journal = readJournal(s.dir);
  const subcalls = readSubcalls(s.dir);
  const form = {
    header: splitHeader(header ?? {}),
    facts: domainFactsOf(s.domain, version, rows, journal, subcalls),
    v2Rows: [],
    subcallArchive: subcalls,
    badLines: [],
  };
  const { rows: v2Rows, header: newHeader } = migrateSessionForm({ version, value: form });
  const eq = sessionFactsEqual(form.facts, domainFactsOf(s.domain, 2, v2Rows, [], []));
  if (!eq.ok) throw new Error('对账失败：' + eq.diff);
  if (header !== null && !headerInheritOk(header, newHeader)) throw new Error('头行继承失败：旧头字段丢失');
  if (!isDry) {
    const staging = path.join(s.dir, MESSAGES + STAGING_SUFFIX);
    fs.writeFileSync(staging, [newHeader].concat(v2Rows).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    try {
      const verify = readJsonlStrict(staging);
      if (verify.header === null || verify.header.version !== 2) throw new Error('verify 失败：staging 头行非 v2');
      const eq2 = sessionFactsEqual(form.facts, domainFactsOf(s.domain, 2, verify.rows, [], []));
      if (!eq2.ok) throw new Error('staging 对账失败：' + eq2.diff);
    } catch (err) {
      fs.rmSync(staging, { force: true });
      throw err;
    }
    fs.renameSync(staging, path.join(s.dir, MESSAGES));
    renameSidecars(s.dir, sidecars);
  }
  const bare = rows.filter((r) => r.type === undefined && r.message_id === undefined).length;
  const bareNote = bare > 0 ? `，${bare} 行缺 message_id（cr-978 裸行——迁后落空串）` : '';
  return { status: 'v1', note: `v${version}→v2（v2 行 ${v2Rows.length}；journal/subcalls ${journal.length + subcalls.length} 行转 .migrated${bareNote}）` };
}

// —— 主循环（逐会话报告）——
console.log('数据根：' + dataRoot + (dry ? '（--dry 预演——零写入）' : ''));
const agentRe = agentGlob !== undefined ? globToRegExp(agentGlob) : null;
const stats = { v1: 0, v2: 0, residue: 0, journalOnly: 0, empty: 0, error: 0, total: 0 };
for (const s of sessionDirs(dataRoot)) {
  if (agentRe !== null && !agentRe.test(s.domain)
    && !(s.parent !== null && agentRe.test(s.parent + '/children/' + s.domain))) continue;
  if (convFilter !== undefined && !s.convId.includes(convFilter)) continue;
  stats.total++;
  const label = (s.parent !== null ? s.parent + '/children/' + s.domain : s.domain) + ' — ' + s.convId;
  try {
    const r = processSession(s, dry);
    if (r.status === 'v1') { stats.v1++; console.log('  ' + (dry ? '[dry] ' : '') + r.note + ' — ' + label); }
    else if (r.status === 'residue') { stats.residue++; console.log('  补归档 ' + r.note + ' — ' + label); }
    else if (r.status === 'journal-only') { stats.journalOnly++; console.log('  [跳过] 仅 journal（messages.jsonl 缺席——崩溃孤儿域，M-C 前置判定）— ' + label); }
    else if (r.status === 'v2') { stats.v2++; }
    else { stats.empty++; }
  } catch (err) {
    stats.error++;
    console.error('  ✗ ' + label + ' — ' + (err instanceof Error ? err.message : String(err)));
  }
}
console.log('');
console.log('==== 会话迁移报告（' + (dry ? 'dry-run 预演' : '执行') + '）====');
console.log('可迁移 v1/v0→v2       : ' + stats.v1);
console.log('已最新（v2 头跳过）   : ' + stats.v2);
console.log('中断残留补归档        : ' + stats.residue);
console.log('仅 journal 跳过       : ' + stats.journalOnly);
console.log('空会话                : ' + stats.empty);
console.log('错误                  : ' + stats.error);
console.log('范围内会话目录        : ' + stats.total);
if (stats.error > 0) process.exitCode = 1;

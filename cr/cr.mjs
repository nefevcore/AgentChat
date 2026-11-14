#!/usr/bin/env node
// ============================================================
// ac-cr —— CR 变更登记台账 CLI（cr-58 起；v2 = cr-982/983/984；
// v3 = cr-1043 索引/内容分离；v3.1 = cr-1045 元数据出索引——
// 尾部块迁 cr-meta.json，索引行纯净，头行「当前号」退役 →
// cr-log.md 真 append-only）
//
// 定位：本地零依赖脚本（Node 内置模块 only）。CR = Change Record，
// 登记是动手前自律动作，非审批流。寻址自包含：工具与台账同住 cr/。
//
// 三件分工（v3.1）：
//   cr-log.md    纯索引：一行一条【cr-N 日期 一句话】——只追加，
//                永不改写（append-only；状态/标签不污染索引面）
//   cr-meta.json 元数据：{status,scopes,refs} 稀疏存储（CLI 维护，
//                禁手编；无记录 = done 无标签）
//   logs/cr-N.md 详情正本：可选，整文件自由写
//
//   init    目标项目落地 cr/（工具+skill 复制；台账存在即跳过、
//           工具恒覆盖——重跑 = 升级路径）
//   append  登记新条目——自动取号（索引最大号 +1）、当日日期；
//           #词 → scopes、→cr-N → refs（写 meta）；--status 缺省
//           done；描述 >200 字警告。O_EXCL 锁 + 写前重读 + 写后重验。
//   get     取条目——索引行 + meta + logs/cr-N.md 详情聚合。
//   set     状态流转：set <crN> <plan|doing|done|drop>（只改 meta，
//           不动索引——append-only 不变量成立的关键）
//   grep    检索——多词 AND；head（缺省）只查索引行，detail 连
//           logs/ 一并检索；--status/--id/--scope 维度过滤（走 meta）。
//   stats   计数面 + plan/doing 欠账清单。
//   selftest sandbox 临时 cr/ 副本命令面自测。
//
// git 面（sync/check）住 cr-git.mjs。
// 文件形态：LF / 结尾单换行 / 无 BOM；全 CRLF 单态自动修形。
// 测试隔离：CR_HOME 环境变量指向 cr/ 副本根。
// 用法示例：
//   node cr/cr.mjs append '一句话描述' #webui →cr-981 --status plan
//   node cr/cr.mjs set 1043 done
//   node cr/cr.mjs get 1043
//   node cr/cr.mjs grep detail 记忆 --status plan -n 30
// ============================================================
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HOME = process.env.CR_HOME
  || (fs.existsSync(join(dirname(fileURLToPath(import.meta.url)), 'cr-log.md'))
    ? dirname(fileURLToPath(import.meta.url))
    : fileURLToPath(new URL('../../../cr', import.meta.url)));
const LOG = join(HOME, 'cr-log.md');
const META = join(HOME, 'cr-meta.json');
const LOGS_DIR = join(HOME, 'logs');
const LOCK = join(HOME, 'cr.lock');
const STATUSES = new Set(['plan', 'doing', 'done', 'drop']);

// v3.1 索引行：纯【cr-N 日期 描述】（无尾部块）；legacy 兼容读：
// 行内 】{…} 块在载入时折入 meta 视图（迁移残留，check 会提示剥离）
const ENTRY_RE = /^- 【cr-(\d+) (\d{4}-\d{2}-\d{2}) (.*?)】(\{[^}]*\})?$/;
const META_SPEC = { status: 'string', scopes: 'array', refs: 'array' };

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function readLog() {
  try {
    return fs.readFileSync(LOG, 'utf8');
  } catch {
    return die('读不到 cr-log：' + LOG + '（未 init？）');
  }
}

// —— 解析 ————————————————————————————————————————
function parseTail(raw) {
  if (!raw) return null;
  const out = { status: null, scopes: [], refs: [] };
  for (const f of raw.slice(1, -1).split('|')) {
    const s = f.trim();
    if (!s) continue;
    if (STATUSES.has(s)) out.status = s;
    else if (/^#\S+$/.test(s)) out.scopes.push(s);
    else if (/^→cr-\d+$/.test(s)) out.refs.push(Number(s.slice(4)));
    else return { ...out, bad: s };
  }
  return out;
}

function parse(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ENTRY_RE);
    if (m) entries.push({
      n: Number(m[1]), date: m[2], desc: m[3],
      tailRaw: m[4] || null, tail: parseTail(m[4] || null),
      raw: lines[i], lineIdx: i,
    });
  }
  return { lines, entries };
}

// —— meta 面 ————————————————————————————————————————
// cr-meta.json = { "<crN>": {status?, scopes?, refs?} }——稀疏：只有
// 非缺省元数据的条目占位（done 且无标签无引用 = 无记录）。
function readMeta() {
  // 返回裸映射 {"<crN>": {…}}（包装的 entries 解包；兼容裸形态）
  try {
    const o = JSON.parse(fs.readFileSync(META, 'utf8'));
    if (o && typeof o === 'object' && !Array.isArray(o)) return o.entries || o;
  } catch { /* 缺失/损坏 = 空（首条 meta 写入时重建） */ }
  return {};
}

function writeMeta(meta) {
  const keys = Object.keys(meta).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  const sorted = Object.fromEntries(keys.map((k) => [String(k), meta[String(k)]]));
  fs.writeFileSync(META, JSON.stringify({
    _comment: 'CR 元数据（v3.1 cr-1045）：status/scopes/refs 稀疏存储，CLI 维护禁手编；无记录 = done 无标签',
    entries: sorted,
  }, null, 1) + '\n');
}

// 条目元数据视图 = meta 记录 ∪ legacy 行内块（迁移残留兼容读）
function metaOf(e, meta) {
  const rec = meta[String(e.n)] || {};
  const legacy = e.tail && !e.tail.bad ? e.tail : null;
  const status = rec.status
    ?? legacy?.status
    ?? 'done';
  const scopes = [...new Set([...(rec.scopes || []), ...(legacy?.scopes || [])])];
  const refs = [...new Set([...(rec.refs || []), ...(legacy?.refs || [])])];
  return { status, scopes, refs };
}

function statusOf(e, meta) {
  return metaOf(e, meta).status;
}

function detailPath(n) {
  return join(LOGS_DIR, 'cr-' + n + '.md');
}

// —— 公共件 ——————————————————————————————————
// today()：登记人本地日历日（cr-1052 声明——CR 台账是开发者本地工作流，
// 本地时区即正确口径；补零维持 YYYY-MM-DD 规约）
function today() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + mm + '-' + dd;
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  return d >= 1 && d <= new Date(y, m, 0).getDate();
}

// EOL 规整：混杂 → die；全 CRLF 单态 → 修形 LF（通知）
function normalizeEol(text) {
  const hasCrlf = text.includes('\r\n');
  const hasBareLf = /(?<!\r)\n/.test(text);
  if (hasCrlf && hasBareLf) die('cr-log 存在裸 LF 行（EOL 混杂），先统一再登记');
  if (hasCrlf && !hasBareLf) {
    fs.writeFileSync(LOG, text.replace(/\r\n/g, '\n'));
    console.error('提示：cr-log 为全 CRLF 单态（历史约定形态），已修形为 LF');
    return fs.readFileSync(LOG, 'utf8');
  }
  return text;
}

// 写前不变量自检：号唯一且单调不减（append-only：新号只进尾部）
function assertInvariant(p) {
  const nums = p.entries.map((e) => e.n);
  if (!nums.length) return 0;
  if (new Set(nums).size !== nums.length) throw new Error('索引存在重复 cr 号');
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] < nums[i - 1]) throw new Error('索引物理逆序：cr-' + nums[i] + ' 位于 cr-' + nums[i - 1] + ' 后');
  }
  return Math.max(...nums);
}

// O_EXCL 锁 + stale 清退（10s）+ 短等待重试
function withLock(fn) {
  for (let attempt = 0; ; attempt++) {
    try { fs.closeSync(fs.openSync(LOCK, 'wx')); break; }
    catch {
      if (attempt >= 2) return die('cr 锁不可得（' + LOCK + '）——目录缺失或并行写在途');
      let stale = false;
      try { stale = Date.now() - fs.statSync(LOCK).mtimeMs > 10_000; } catch { stale = true; }
      if (stale) { try { fs.rmSync(LOCK); } catch {} continue; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
  }
  try { return fn(); } finally { try { fs.rmSync(LOCK); } catch {} }
}

// 尾部 O(1) 追加写（保留结尾空白区形态）
function appendLine(text, line) {
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  if (end === text.length) {
    fs.appendFileSync(LOG, (text.endsWith('\n') ? '' : '\n') + line + '\n');
    return;
  }
  const keep = text.slice(0, end) + '\n';
  const runTail = text.slice(end).replace(/^\r?\n/, '');
  const fd = fs.openSync(LOG, 'r+');
  try { fs.ftruncateSync(fd, Buffer.byteLength(keep, 'utf8')); }
  finally { fs.closeSync(fd); }
  fs.appendFileSync(LOG, line + '\n' + runTail);
}

// meta 更新（锁内）：合并写，保持稀疏（全缺省即删记录）
function putMeta(meta, n, { status, scopes, refs }) {
  const cur = meta[String(n)] || {};
  const next = {
    status: status ?? cur.status,
    scopes: scopes ?? cur.scopes,
    refs: refs ?? cur.refs,
  };
  if (next.status === 'done' && !(next.scopes || []).length && !(next.refs || []).length) delete meta[String(n)];
  else meta[String(n)] = next;
}

// —— init ————————————————————————————————————————
function cmdInit(args) {
  const target = args[0] ? resolveTarget(args[0]) : process.cwd();
  const self = fileURLToPath(import.meta.url);
  // skill 源两级候选：包内（开发态）→ 脚本旁 skill/（安装态自包含）
  const skillSrc = [fileURLToPath(new URL('../skill/SKILL.md', import.meta.url)), join(dirname(self), 'skill', 'SKILL.md')]
    .find((p) => fs.existsSync(p));
  if (!fs.existsSync(self)) die('init 源缺失：' + self);
  const crDir = join(target, 'cr');
  const gitTool = fileURLToPath(new URL('./cr-git.mjs', import.meta.url));
  fs.mkdirSync(crDir, { recursive: true });
  fs.mkdirSync(join(crDir, 'logs'), { recursive: true });
  fs.copyFileSync(self, join(crDir, 'cr.mjs'));
  if (fs.existsSync(gitTool)) fs.copyFileSync(gitTool, join(crDir, 'cr-git.mjs'));
  if (skillSrc) {
    fs.mkdirSync(join(crDir, 'skill'), { recursive: true });
    fs.copyFileSync(skillSrc, join(crDir, 'skill', 'SKILL.md'));
  }
  const skillDir = join(target, '.dsh', 'skills', 'cr');
  fs.mkdirSync(skillDir, { recursive: true });
  if (skillSrc) fs.copyFileSync(skillSrc, join(skillDir, 'SKILL.md'));
  const log = join(crDir, 'cr-log.md');
  if (!fs.existsSync(log)) {
    fs.writeFileSync(log, [
      '# 变更登记目录（CR log）',
      '',
      '> 一切变更（含日常 bugfix）动手前**先登记一条 CR**（`node cr/cr.mjs append "一句话描述" [#标签] [--status plan|doing|drop]`——自动取号/当日日期；详情 `get`；查询 `grep [head|detail] <词>`；欠账 `stats`），再动代码。',
      '> 本文件纯索引（append-only，永不手编）；状态/标签住 cr-meta.json（CLI 维护）；细节住 logs/cr-N.md（CR 只登记变更情报，规划类内容勿入）。',
      '',
      '## 目录',
      '',
      '',
    ].join('\n'));
    console.log('init 完成：' + crDir + '（新建台账）+ ' + skillDir);
    console.log('下一条登记号：cr-1');
  } else {
    console.log('init 完成：' + crDir + '（台账已存在，未触碰）+ ' + skillDir);
  }
}

function resolveTarget(p) {
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')) return p;
  return join(process.cwd(), p);
}

// —— append ————————————————————————————————————————
function cmdAppend(args) {
  const pos = [];
  let date = null, status = 'done';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date') date = args[++i];
    else if (args[i] === '--status') {
      status = args[++i];
      if (!STATUSES.has(status)) die('--status 取值：' + [...STATUSES].join(' / '));
    } else pos.push(args[i]);
  }
  const isScope = (t) => /^#\S+$/.test(t);
  const isRef = (t) => /^→cr-\d+$/.test(t);
  const scopes = pos.filter(isScope);
  const refs = pos.filter(isRef).map((t) => Number(t.slice(4)));
  const desc = pos.filter((t) => !isScope(t) && !isRef(t)).join(' ').replace(/\s+/g, ' ').trim();
  if (!desc) die("append 缺描述：node cr/cr.mjs append '一句话描述' [#标签] [→cr-引用] [--status plan]");
  if (desc.includes('】')) die('描述不得包含「】」（条目行以 】 收尾）');
  if (desc.length > 200) console.error('警告：描述 ' + desc.length + ' 字（>200）——细节应迁 logs/cr-N.md，条目保持一句话');
  if (date != null && !validDate(date)) die('--date ' + date + ' 不是合法日历日 YYYY-MM-DD');
  withLock(() => {
    const text = normalizeEol(readLog());
    const p = parse(text);
    let next;
    try { next = assertInvariant(p) + 1; } catch (e) { return die(e.message); }
    const known = new Set(p.entries.map((e) => e.n));
    for (const r of refs) if (!known.has(r)) return die('→cr-' + r + ' 引用不存在，先确认目标号');
    appendLine(text, '- 【cr-' + next + ' ' + (date || today()) + ' ' + desc + '】');
    try { // 写后重验（append-only：尾部应恰为新增行）
      const after = assertInvariant(parse(fs.readFileSync(LOG, 'utf8')));
      if (after !== next) throw new Error('写后重验号不符（' + after + ' ≠ ' + next + '）');
    } catch (e) { return die('写后重验失败：' + e.message); }
    // 元数据（非缺省才落 meta——稀疏）
    if (status !== 'done' || scopes.length || refs.length) {
      const meta = readMeta();
      putMeta(meta, next, { status, scopes, refs });
      writeMeta(meta);
    }
    console.log('已登记 cr-' + next + '（' + (date || today()) + (status !== 'done' ? '，' + status : '') + '）'
      + (fs.existsSync(detailPath(next)) ? '（logs/cr-' + next + '.md 已在场——随批沉淀详情）' : ''));
  });
}

// —— set ————————————————————————————————————————
function cmdSet(args) {
  const n = Number(String(args[0] || '').replace(/^cr-/i, ''));
  const status = args[1];
  if (!(Number.isInteger(n) && n > 0)) die('set 用法：node cr/cr.mjs set <crN> <plan|doing|done|drop>');
  if (!STATUSES.has(status)) die('set 取值：' + [...STATUSES].join(' / '));
  withLock(() => {
    const p = parse(readLog());
    const e = p.entries.find((x) => x.n === n);
    if (!e) return die('cr-' + n + ' 不存在');
    const meta = readMeta();
    const cur = metaOf(e, meta);
    putMeta(meta, n, { status, scopes: cur.scopes, refs: cur.refs });
    writeMeta(meta);
    console.log('cr-' + n + ' → ' + status + '（cr-meta.json）');
  });
}

// —— get ————————————————————————————————————————
function cmdGet(args) {
  const nums = args.map((a) => Number(String(a).replace(/^cr-/i, ''))).filter(Number.isInteger);
  if (!nums.length) die('get 用法：node cr/cr.mjs get <crN> [crM …]');
  const p = parse(readLog());
  const meta = readMeta();
  for (const n of nums) {
    const e = p.entries.find((x) => x.n === n);
    if (!e) { console.log('cr-' + n + '：不存在'); continue; }
    const m = metaOf(e, meta);
    console.log(e.raw);
    const parts = ['  [' + m.status + ']'];
    if (m.scopes.length) parts.push(m.scopes.join(' '));
    if (m.refs.length) parts.push(m.refs.map((r) => '→cr-' + r).join(' '));
    console.log(parts.join(' '));
    const dp = detailPath(n);
    if (fs.existsSync(dp)) {
      console.log(fs.readFileSync(dp, 'utf8').replace(/\s+$/, ''));
      console.log('');
    }
  }
}

// —— grep ————————————————————————————————————————
function cmdGrep(args) {
  let face = 'head';
  if (args[0] === 'head' || args[0] === 'detail') { face = args.shift(); }
  const words = [];
  let limitN = 15, oneline = false, status = null, id = null, scope = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n') limitN = Number(args[++i]) || 15;
    else if (args[i] === '--oneline') oneline = true;
    else if (args[i] === '--status') status = args[++i];
    else if (args[i] === '--id') id = Number(String(args[++i]).replace(/^cr-/i, ''));
    else if (args[i] === '--scope') scope = args[++i];
    else words.push(args[i].toLowerCase());
  }
  if (status && !STATUSES.has(status)) die('--status 取值：' + [...STATUSES].join(' / '));
  if (!words.length && !status && !id && !scope) die('grep 缺条件：node cr/cr.mjs grep [head|detail] <词>... [--status S] [--id cr-N] [--scope #x] [-n N] [--oneline]');
  const p = parse(readLog());
  const meta = readMeta();
  const lc = (s) => s.toLowerCase();
  const dimOk = (e) => {
    const m = metaOf(e, meta);
    if (status && m.status !== status) return false;
    if (id && e.n !== id) return false;
    if (scope && !m.scopes.includes(scope)) return false;
    return true;
  };
  if (!words.length) { // 纯维度过滤
    printEntries(p.entries.filter(dimOk), meta, limitN, oneline);
    return;
  }
  if (face === 'head') {
    printEntries(p.entries.filter((e) => dimOk(e) && words.every((w) => lc(e.desc).includes(w))), meta, limitN, oneline);
    return;
  }
  // detail 面：索引命中 ∨ 详情文件命中（多词可跨面分布——按条目聚合后 AND）
  const hits = [];
  const detailContrib = new Set();
  for (const e of p.entries) {
    if (!dimOk(e)) continue;
    const inHead = words.every((w) => lc(e.desc).includes(w));
    const dp = detailPath(e.n);
    let inDetail = false;
    if (fs.existsSync(dp)) {
      const detail = lc(fs.readFileSync(dp, 'utf8'));
      inDetail = words.every((w) => lc(e.desc).includes(w) || detail.includes(w));
    }
    if (inHead || inDetail) {
      hits.push(e);
      if (!inHead) detailContrib.add(e.n);
    }
  }
  printEntries(hits, meta, limitN, oneline);
  const lines = [];
  for (const e of hits) {
    if (!detailContrib.has(e.n)) continue;
    const detail = fs.readFileSync(detailPath(e.n), 'utf8').split(/\r?\n/);
    detail.forEach((l, i) => {
      if (words.some((w) => lc(l).includes(w))) lines.push('cr-' + e.n + ' · logs/cr-' + e.n + '.md:' + (i + 1) + '  ' + l.trim().slice(0, 120));
    });
  }
  if (lines.length) {
    console.log('');
    console.log('详情命中行：');
    for (const l of lines.slice(0, 20)) console.log('  ' + l);
    if (lines.length > 20) console.log('  （…共 ' + lines.length + ' 行，仅示前 20）');
  }
}

function printEntries(entries, meta, limitN, oneline) {
  if (!entries.length) {
    console.log('（无命中）');
    return;
  }
  const shown = entries.slice(-limitN).reverse();
  for (const e of shown) {
    const m = metaOf(e, meta);
    const tail = m.status !== 'done' || m.scopes.length || m.refs.length
      ? ' {' + [m.status !== 'done' ? m.status : '', ...m.scopes, ...m.refs.map((r) => '→cr-' + r)].filter(Boolean).join('|') + '}'
      : '';
    console.log(e.raw.replace(/】(\{[^}]*\})?$/, '】') + tail);
    if (!oneline) {
      const dp = detailPath(e.n);
      if (fs.existsSync(dp)) console.log('  详情：logs/cr-' + e.n + '.md');
    }
  }
  if (entries.length > shown.length) console.log('（命中 ' + entries.length + ' 条，仅示最新 ' + shown.length + ' 条——-n N 调整）');
}

// —— stats ————————————————————————————————————————
function cmdStats() {
  const p = parse(readLog());
  const meta = readMeta();
  const byStatus = { plan: 0, doing: 0, done: 0, drop: 0 };
  const byDay = {};
  const open = [];
  let withDetail = 0;
  for (const e of p.entries) {
    const s = statusOf(e, meta);
    byStatus[s]++;
    byDay[e.date] = (byDay[e.date] || 0) + 1;
    if (fs.existsSync(detailPath(e.n))) withDetail++;
    if (s === 'plan' || s === 'doing') open.push(e);
  }
  console.log('总计 ' + p.entries.length + ' 条（详情 ' + withDetail + '）：done ' + byStatus.done + ' / doing ' + byStatus.doing + ' / plan ' + byStatus.plan + ' / drop ' + byStatus.drop);
  const days = Object.keys(byDay).sort().slice(-14);
  console.log('近 14 活跃日：' + days.map((d) => d.slice(5) + ':' + byDay[d]).join('  '));
  if (open.length) {
    console.log('欠账清单（plan/doing）：');
    for (const e of open) console.log('  cr-' + e.n + ' ' + statusOf(e, meta).padEnd(5) + ' ' + e.desc.slice(0, 60) + (e.desc.length > 60 ? '…' : ''));
  } else console.log('欠账清单：空');
}

// —— selftest ————————————————————————————————————————
function cmdSelftest() {
  const dir = join(HOME, '..', 'sandbox', 'cr-selftest-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const home = join(dir, 'proj');
  const self = fileURLToPath(import.meta.url);
  const run = (a, env) => execFileSync(process.execPath, [self, ...a], { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
  const failures = [];
  const t = (name, fn) => {
    try { fn(); console.log('  ✓ ' + name); } catch (e) { failures.push(name + '：' + e.message); }
  };
  const henv = () => ({ CR_HOME: join(home, 'cr') });
  const logText = () => fs.readFileSync(join(home, 'cr', 'cr-log.md'), 'utf8');
  const metaText = () => fs.readFileSync(join(home, 'cr', 'cr-meta.json'), 'utf8');
  try {
    // init：全新项目闭环
    run(['init', home]);
    if (!fs.existsSync(join(home, 'cr', 'cr.mjs'))) throw new Error('init 未落 cr/cr.mjs');
    if (!fs.existsSync(join(home, 'cr', 'cr-log.md'))) throw new Error('init 未建台账');
    if (!fs.existsSync(join(home, 'cr', 'skill', 'SKILL.md'))) throw new Error('init 未落 cr/skill（自包含面）');
    if (!fs.existsSync(join(home, '.dsh', 'skills', 'cr', 'SKILL.md'))) throw new Error('init 未复制 skill');
    t('init 全新项目', () => {});
    // append 首条 + meta 落盘
    const out1 = run(['append', 'selftest 条目', '#selftest', '--status', 'plan'], henv());
    if (!/已登记 cr-1（.*，plan）/.test(out1)) throw new Error('append 首条输出异常：' + out1.trim());
    if (!/^- 【cr-1 \S+ selftest 条目】$/m.test(logText())) throw new Error('索引行不纯净（含尾部块或形态不符）');
    const meta1 = JSON.parse(metaText());
    const m1 = meta1.entries?.['1'];
    if (m1?.status !== 'plan' || !m1?.scopes?.includes('#selftest')) throw new Error('meta 未落盘：' + metaText());
    t('append 索引纯净 + meta 落盘', () => {});
    // append 第二条：无元数据 = meta 无记录（稀疏）
    run(['append', '第二条 无标签'], henv());
    if (JSON.parse(metaText()).entries?.['2']) throw new Error('缺省 done 不应占 meta 记录');
    t('meta 稀疏（缺省不落盘）', () => {});
    // set：只改 meta，索引字节不变
    const before = logText();
    run(['set', '1', 'doing'], henv());
    if (logText() !== before) throw new Error('set 动了索引（append-only 破坏）');
    if (JSON.parse(metaText()).entries?.['1']?.status !== 'doing') throw new Error('set 未写 meta');
    t('set 只改 meta 不动索引', () => {});
    // get：索引 + meta + 详情聚合
    fs.writeFileSync(join(home, 'cr', 'logs', 'cr-1.md'), '# cr-1 详情\n\n动机：selftest。\n');
    const outG = run(['get', '1'], henv());
    if (!outG.includes('selftest 条目') || !outG.includes('[doing]') || !outG.includes('#selftest') || !outG.includes('动机：selftest')) throw new Error('get 未聚合：' + outG.trim());
    t('get 索引+meta+详情聚合', () => {});
    // grep head / detail + 维度过滤（走 meta）
    if (!run(['grep', 'head', 'selftest'], henv()).includes('cr-1')) throw new Error('grep head 未命中');
    if (!run(['grep', 'detail', '动机'], henv()).includes('cr-1')) throw new Error('grep detail 未命中详情');
    if (run(['grep', 'head', '动机'], henv()).includes('cr-1')) throw new Error('grep head 误命中详情词');
    if (!run(['grep', '--status', 'doing'], henv()).includes('cr-1')) throw new Error('grep 维度过滤（meta）失效');
    t('grep head/detail 双面 + meta 维度', () => {});
    // stats：欠账清单
    if (!run(['stats'], henv()).includes('cr-1')) throw new Error('stats 欠账未列出');
    t('stats 欠账清单', () => {});
    // legacy 行内块兼容读：手工注入后 grep 维度仍命中
    fs.appendFileSync(join(home, 'cr', 'cr-log.md'), '- 【cr-3 2026-11-13 legacy 块兼容读验证】{plan|#legacy}\n');
    if (!run(['grep', '--status', 'plan'], henv()).includes('cr-3')) throw new Error('legacy 行内块未被兼容读');
    t('legacy 行内块兼容读', () => {});
    // init 幂等：台账不碰
    run(['init', home]);
    if (!logText().includes('selftest 条目')) throw new Error('重跑 init 触碰了台账');
    t('init 幂等（产物不碰）', () => {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length) return die('selftest 失败：\n  ' + failures.join('\n  '));
  console.log('selftest 全绿（init/append 纯净+meta/稀疏/set 隔离/get 聚合/grep 双面+meta/legacy 兼容/幂等）');
}

function usage() {
  console.log([
    '用法（CR_HOME 环境变量可覆盖 cr/ 根寻址）：',
    "  node cr/cr.mjs init [目标项目路径]          落地 cr/（工具+skill；重跑=升级）",
    "  node cr/cr.mjs append '一句话描述' [#标签…] [→cr-引用…] [--status plan|doing|done|drop] [--date YYYY-MM-DD]",
    '  node cr/cr.mjs get <crN> [crM …]           取索引行 + meta + logs/cr-N.md 详情',
    '  node cr/cr.mjs set <crN> <plan|doing|done|drop>   （只改 cr-meta.json，不动索引）',
    '  node cr/cr.mjs grep [head|detail] <词>... [--status S] [--id cr-N] [--scope #x] [-n N] [--oneline]',
    '  node cr/cr.mjs stats                       计数面 + plan/doing 欠账清单',
    '  node cr/cr.mjs selftest                    sandbox 临时 cr/ 命令面自测',
    'cr-log.md = 纯索引（append-only）；cr-meta.json = 元数据（CLI 维护）；logs/ = 详情正本。',
  ].join('\n'));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'init') cmdInit(rest);
else if (cmd === 'append') cmdAppend(rest);
else if (cmd === 'set') cmdSet(rest);
else if (cmd === 'get') cmdGet(rest);
else if (cmd === 'grep') cmdGrep(rest);
else if (cmd === 'stats') cmdStats(rest);
else if (cmd === 'selftest') cmdSelftest();
else usage();

#!/usr/bin/env node
// ============================================================
// scripts/cr.mjs —— cr-log 登记台账 CLI（cr-58 起；v2 = cr-982/983/984）
// 事实源：仓库根 cr-log.md（单文件 markdown 行级台账；cr-N = Change Record，
// 登记是动手前自律动作，非审批流）。零依赖（Node 内置模块 only）。
//
//   append  登记新条目——自动取号（目录最大号 +1）、日期缺省当日真实
//           日历日（--date 覆写）；位置参数中 #词 收为 scope 标签、
//           →cr-N 收为显式引用；--status 显式状态（缺省 done——登记随批
//           闭环的常态；跨会话 WIP 显式 doing/plan）；
//           描述 >200 字警告（细节迁 docs/design/ 或 CHANGELOG）；
//           O_EXCL 锁 + 写前重读 + 写后重验；尾部 O(1) 追加写（头行
//           同步走等长字节补丁，仅位数增长才全文重写）；全 LF 单态自动
//           修形 CRLF。
//   set     状态流转：set <crN> <plan|doing|done|drop>（就地改写尾部块）。
//   grep    条目检索——多词 AND（字面量、忽略大小写），最新在前；
//           --status/--id/--scope 维度过滤；-n N 限量；--oneline 单行。
//   sync    扫 git log message 中 cr-N 引用 → 生成 cr-commits.json 投影
//           （生成物，禁手改；同 row-catalog 纪律）+ 悬空引用校验。
//           增量：投影记 scannedHead，merge-base 验祖代后只扫新增
//           commit；--rebuild 强制全量。
//   check   六锁守门（fail-loud）：①头行=全目录最大号 ②无重复号
//           ③目录区按号单调 ④尾部块语法合法且引用存在 ⑤条目内
//           docs/**.md 路径存在 ⑥commit 引用面无悬空（经 sync）。
//   stats   计数面：按状态/近 14 活跃日 + plan/doing 欠账清单。
//   selftest sandbox 临时副本上命令面自测（测试数据根住 sandbox/）。
//
// 文件形态约定：CRLF / 结尾单换行 / 无 BOM——原样保留；全 LF 单态（git
// eol=lf 再物化形态）自动修形。测试隔离：CR_LOG_FILE / CR_PROJ_FILE
// 环境变量指向副本；sync 的 git 面恒读本仓库（只读）。
// 用法示例：
//   node scripts/cr.mjs append '一句话描述' #webui →cr-981 --status plan
//   node scripts/cr.mjs set 983 done
//   node scripts/cr.mjs grep 记忆 --status plan -n 30
//   node scripts/cr.mjs sync && node scripts/cr.mjs check
// ============================================================
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LOG = process.env.CR_LOG_FILE
  || fileURLToPath(new URL('../cr-log.md', import.meta.url));
const PROJ = process.env.CR_PROJ_FILE
  || (process.env.CR_LOG_FILE ? join(dirname(process.env.CR_LOG_FILE), 'cr-commits.json')
    : fileURLToPath(new URL('../cr-commits.json', import.meta.url)));
const LOCK = LOG + '.lock';
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const STATUSES = new Set(['plan', 'doing', 'done', 'drop']);

const ENTRY_RE = /^- 【cr-(\d+) (\d{4}-\d{2}-\d{2}) (.*?)】(\{[^}]*\})?$/;
const HEAD_RE = /^> \*\*当前号：cr-(\d+)\*\*/;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function readLog() {
  try {
    return fs.readFileSync(LOG, 'utf8');
  } catch {
    return die('读不到 cr-log：' + LOG);
  }
}

// —— 解析 ————————————————————————————————————————
// 尾部块 {status|#scope…|→cr-N…}；字段序任意；未知字段 → bad（check 红）
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
  const tocIdx = lines.findIndex((l) => l.startsWith('## 目录'));
  let headIdx = -1;
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    if (headIdx === -1 && i < tocIdx && HEAD_RE.test(lines[i])) headIdx = i;
    const m = lines[i].match(ENTRY_RE);
    if (m) entries.push({
      n: Number(m[1]), date: m[2], desc: m[3], tailRaw: m[4] || null,
      tail: parseTail(m[4] || null), raw: lines[i], lineIdx: i,
    });
  }
  return { lines, headIdx, entries };
}

// 条目状态：尾部块 status；无块存量 = done（cr-983 裁决，零迁移）
function statusOf(e) {
  return e.tail?.status ?? 'done';
}

// 条目块 = 条目行 + 归属续行；缩进续行（「  - cr-N …」）归属其引用的
// cr 号（cr-43 补录形态：物理位置在他处，按引用归属）
function blocks(p) {
  const byN = new Map(p.entries.map((e) => [e.n, { n: e.n, body: [e.raw] }]));
  const entryAt = new Map(p.entries.map((e) => [e.lineIdx, e.n]));
  let cur = null;
  for (let i = 0; i < p.lines.length; i++) {
    if (entryAt.has(i)) { cur = entryAt.get(i); continue; }
    if (i <= p.headIdx) continue;
    const line = p.lines[i];
    if (!line.trim()) continue;
    const cont = line.match(/^\s+- cr-(\d+)\b/);
    const owner = cont ? byN.get(Number(cont[1])) : null;
    (owner || (cur != null ? byN.get(cur) : null))?.body.push(line);
  }
  return [...byN.values()];
}

// —— 公共件 ————————————————————————————————————————
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

// EOL 规整：混杂（CRLF 与裸 LF 并存）→ die；全 LF 单态 → 修形 CRLF（通知）
function normalizeEol(text) {
  const hasCrlf = text.includes('\r\n');
  const hasBareLf = /(?<!\r)\n/.test(text);
  if (hasCrlf && hasBareLf) die('cr-log 存在裸 LF 行（EOL 混杂），先统一再登记');
  if (!hasCrlf && hasBareLf) {
    fs.writeFileSync(LOG, text.replace(/\r?\n/g, '\r\n'));
    console.error('提示：cr-log 为全 LF 单态（git eol=lf 再物化形态），已修形为 CRLF 约定形态');
    return fs.readFileSync(LOG, 'utf8');
  }
  return text;
}

// 写前不变量自检（append/set 用；完整六锁见 check）
function assertInvariant(p) {
  if (p.headIdx === -1) throw new Error('头部引言区缺「> **当前号：cr-N**」快查行');
  if (!p.entries.length) throw new Error('目录区没有任何条目');
  const nums = p.entries.map((e) => e.n);
  if (new Set(nums).size !== nums.length) throw new Error('目录存在重复 cr 号');
  const headN = Number(p.lines[p.headIdx].match(HEAD_RE)[1]);
  const max = Math.max(...nums);
  if (headN !== max) throw new Error('头行当前号 cr-' + headN + ' 与目录最大号 cr-' + max + ' 不一致——先修复再登记');
  return max;
}

// O_EXCL 锁 + stale 清退（10s）+ 短等待重试；持锁期间执行 fn
function withLock(fn) {
  for (let attempt = 0; ; attempt++) {
    try { fs.closeSync(fs.openSync(LOCK, 'wx')); break; }
    catch {
      let stale = false;
      try { stale = Date.now() - fs.statSync(LOCK).mtimeMs > 10_000; } catch { stale = true; }
      if (stale) { try { fs.rmSync(LOCK); } catch {} continue; }
      if (attempt >= 2) return die('cr-log 锁被占用（' + LOCK + '）——并行 append 在途，稍后重试');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
  }
  try { return fn(); } finally { try { fs.rmSync(LOCK); } catch {} }
}

// 头行同步：等长 → 字节补丁（r+ 原位覆写）；位数增长 → 全文重写（罕见）
function syncHeadLine(p, next) {
  const oldLine = p.lines[p.headIdx];
  const newLine = oldLine.replace(/^> \*\*当前号：cr-\d+\*\*/, '> **当前号：cr-' + next + '**');
  if (oldLine === newLine) return;
  const text = fs.readFileSync(LOG, 'utf8');
  const at = text.indexOf(oldLine);
  if (at === -1) die('头行定位失败（内容已变）——重新检查 cr-log');
  if (Buffer.byteLength(oldLine) === Buffer.byteLength(newLine)) {
    const fd = fs.openSync(LOG, 'r+');
    try { fs.writeSync(fd, Buffer.from(newLine, 'utf8'), 0, Buffer.byteLength(newLine), Buffer.byteLength(text.slice(0, at), 'utf8')); }
    finally { fs.closeSync(fd); }
  } else {
    fs.writeFileSync(LOG, text.slice(0, at) + newLine + text.slice(at + oldLine.length));
  }
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
  if (!desc) die("append 缺描述：node scripts/cr.mjs append '一句话描述' [#标签] [→cr-引用] [--status plan]");
  if (desc.includes('】')) die('描述不得包含「】」（条目行以 】 或 】{…} 收尾）');
  if (desc.includes('{')) die('描述不得包含「{」（尾部元数据块专用）');
  if (desc.length > 200) console.error('警告：描述 ' + desc.length + ' 字（>200）——细节应迁 docs/design/ 或 CHANGELOG，条目保持一句话');
  if (date != null && !validDate(date)) die('--date ' + date + ' 不是合法日历日 YYYY-MM-DD');
  withLock(() => {
    const text = normalizeEol(readLog()); // 写前重读（锁内）
    const p = parse(text);
    let next;
    try { next = assertInvariant(p) + 1; } catch (e) { return die(e.message); }
    for (const r of refs) if (!p.entries.some((e) => e.n === r)) return die('→cr-' + r + ' 引用不存在，先确认目标号');
    const fields = [...(status !== 'done' ? [status] : []), ...scopes, ...refs.map((r) => '→cr-' + r)];
    const line = '- 【cr-' + next + ' ' + (date || today()) + ' ' + desc + '】' + (fields.length ? '{' + fields.join('|') + '}' : '');
    appendLine(text, line);
    syncHeadLine(p, next);
    try { // 写后重验
      const after = assertInvariant(parse(fs.readFileSync(LOG, 'utf8')));
      if (after !== next) throw new Error('写后重验号不符（' + after + ' ≠ ' + next + '）');
    } catch (e) { return die('写后重验失败：' + e.message); }
    console.log('已登记 cr-' + next + '（' + (date || today()) + (status !== 'done' ? '，' + status : '') + '），头行已同步');
  });
}

// 尾部 O(1) 追加写：新行插在最后一个非空行之后，尾部空白区原样保留。
// 实现：向前吞掉尾部空白 run → 截断至「末行内容 + 单 EOL」→ 追加新行
// + EOL + 原 run 尾巴。空白 run 极短（约定 = 一个空行），故恒 O(1)。
function appendLine(text, line) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  if (end === text.length) { // 无结尾换行的异常形态：直接补写
    fs.appendFileSync(LOG, (text.endsWith('\n') ? '' : eol) + line + eol);
    return;
  }
  const keep = text.slice(0, end) + eol;          // 末条目行 + 恢复其行尾
  const runTail = text.slice(end).replace(/^\r?\n/, ''); // run 去第一个 EOL
  const fd = fs.openSync(LOG, 'r+');
  try { fs.ftruncateSync(fd, Buffer.byteLength(keep, 'utf8')); }
  finally { fs.closeSync(fd); }
  fs.appendFileSync(LOG, line + eol + runTail);
}

// —— set ————————————————————————————————————————
function cmdSet(args) {
  const n = Number(String(args[0] || '').replace(/^cr-/i, ''));
  const status = args[1];
  if (!(Number.isInteger(n) && n > 0)) die('set 用法：node scripts/cr.mjs set <crN> <plan|doing|done|drop>');
  if (!STATUSES.has(status)) die('set 取值：' + [...STATUSES].join(' / '));
  withLock(() => {
    const text = normalizeEol(readLog());
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const p = parse(text);
    const e = p.entries.find((x) => x.n === n);
    if (!e) return die('cr-' + n + ' 不存在');
    const tail = e.tail || { status: null, scopes: [], refs: [] };
    const fields = [
      ...(status !== 'done' ? [status] : []),
      ...tail.scopes || [],
      ...(tail.refs || []).map((r) => '→cr-' + r),
    ];
    const newRaw = e.raw.replace(/】(\{[^}]*\})?$/, '】') + (fields.length ? '{' + fields.join('|') + '}' : '');
    p.lines[e.lineIdx] = newRaw;
    try { assertInvariant(parse(p.lines.join(eol))); }
    catch (err) { return die('set 将破坏不变量：' + err.message); }
    fs.writeFileSync(LOG, p.lines.join(eol));
    console.log('cr-' + n + ' → ' + status);
  });
}

// —— grep ————————————————————————————————————————
function cmdGrep(args) {
  const words = [];
  let limit = 15, oneline = false, status = null, id = null, scope = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n') limit = Number(args[++i]) || 15;
    else if (args[i] === '--oneline') oneline = true;
    else if (args[i] === '--status') status = args[++i];
    else if (args[i] === '--id') id = Number(String(args[++i]).replace(/^cr-/i, ''));
    else if (args[i] === '--scope') scope = args[++i];
    else words.push(args[i].toLowerCase());
  }
  if (status && !STATUSES.has(status)) die('--status 取值：' + [...STATUSES].join(' / '));
  if (!words.length && !status && !id && !scope) die('grep 缺条件：node scripts/cr.mjs grep <词>... [--status S] [--id cr-N] [--scope #x] [-n N] [--oneline]');
  const p = parse(readLog());
  const entryById = new Map(p.entries.map((e) => [e.n, e]));
  const hits = blocks(p).filter((b) => {
    const e = entryById.get(b.n);
    if (status && statusOf(e) !== status) return false;
    if (id && b.n !== id) return false;
    if (scope && !(e.tail?.scopes || []).includes(scope)) return false;
    const s = b.body.join('\n').toLowerCase();
    return words.every((w) => s.includes(w));
  });
  if (!hits.length) {
    console.log('（无命中：' + [words.join(' '), status && 'status=' + status, id && 'id=cr-' + id, scope && 'scope=' + scope].filter(Boolean).join(' ') + '）');
    return;
  }
  const shown = hits.slice(-limit).reverse();
  console.log(shown.map((b) => (oneline ? b.body[0] : b.body.join('\n'))).join('\n\n'));
  if (hits.length > shown.length) console.log('（命中 ' + hits.length + ' 条，仅示最新 ' + shown.length + ' 条——-n N 调整）');
}

// —— sync ————————————————————————————————————————
function gitOk(args) {
  try { return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { return null; }
}

function readProj() {
  try { return JSON.parse(fs.readFileSync(PROJ, 'utf8')); } catch { return null; }
}

// 投影 = { scannedHead, generatedAt, entries: { "cr号": [{sha,date,subject}] } }
// 增量：scannedHead 是 HEAD 祖代 → 只扫 scannedHead..HEAD 并入旧投影；
// 非祖代（历史重写）或 --rebuild → 全量。悬空 = 引用了目录外不存在的号。
function doSync(rebuild) {
  if (gitOk(['rev-parse', '--is-inside-work-tree']) == null) die('sync 需要 git 仓库（cwd: ' + REPO_ROOT + '）');
  const head = (gitOk(['rev-parse', 'HEAD']) || '').trim();
  const prev = readProj();
  let entries = {};
  let range = ['HEAD'];
  if (!rebuild && prev?.scannedHead && prev.entries) {
    if (prev.scannedHead === head) { entries = prev.entries; range = []; }
    else if (gitOk(['merge-base', '--is-ancestor', prev.scannedHead, 'HEAD']) != null) {
      entries = prev.entries;
      range = [prev.scannedHead + '..HEAD'];
    }
  }
  if (range.length) {
    const out = gitOk(['log', '--date=short', '--format=%H%x1f%ad%x1f%s%x1f%b%x1e', ...range]) || '';
    for (const rec of out.split('\x1e')) {
      const parts = rec.split('\x1f');
      if (parts.length < 3) continue;
      const [sha, date, subject, ...bodyRest] = parts.map((s) => s.replace(/^\n+/, ''));
      const msg = subject + '\n' + bodyRest.join('\n');
      for (const m of msg.matchAll(/cr-(\d+)/g)) {
        const key = m[1];
        (entries[key] ||= []);
        if (!entries[key].some((c) => c.sha === sha)) entries[key].push({ sha, date, subject: subject.trim() });
      }
    }
  }
  const known = new Set(parse(readLog()).entries.map((e) => e.n));
  const dangling = Object.keys(entries).map(Number).filter((n) => !known.has(n)).sort((a, b) => a - b);
  const proj = {
    scannedHead: head,
    generatedAt: new Date().toISOString(),
    _comment: '生成物：node scripts/cr.mjs sync——禁手改（cr-984，同 row-catalog 纪律）',
    entries: Object.fromEntries(Object.keys(entries).map(Number).sort((a, b) => a - b)
      .map((n) => [String(n), entries[String(n)]])),
  };
  fs.writeFileSync(PROJ, JSON.stringify(proj, null, 1) + '\n');
  const refCount = Object.values(entries).reduce((a, v) => a + v.length, 0);
  return { proj, dangling, refCount };
}

function cmdSync(args) {
  const r = doSync(args.includes('--rebuild'));
  console.log('投影已' + (args.includes('--rebuild') ? '全量重建' : '同步') + '：cr-commits.json（' + Object.keys(r.proj.entries).length + ' 个 cr 号 / ' + r.refCount + ' 条 commit 引用）');
  if (r.dangling.length) die('悬空引用 ' + r.dangling.length + ' 个（commit 引用了不存在的 cr 号）：' + r.dangling.map((n) => 'cr-' + n).join(' '));
  console.log('悬空引用：0');
}

// —— check（六锁）———————————————————————————————
function cmdCheck() {
  const p = parse(readLog());
  const errs = [];
  const softWarns = [];
  const nums = p.entries.map((e) => e.n);
  // 锁1：头行 = 目录最大号
  const headM = p.headIdx === -1 ? null : p.lines[p.headIdx].match(HEAD_RE);
  if (!headM) errs.push('锁1：头部缺「当前号」快查行');
  if (!nums.length) errs.push('锁2：目录区没有任何条目');
  const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
  if (dup.length) errs.push('锁2：重复号 ' + [...new Set(dup)].map((n) => 'cr-' + n).join(' '));
  if (headM && nums.length && Number(headM[1]) !== Math.max(...nums)) {
    errs.push('锁1：头行 cr-' + headM[1] + ' ≠ 目录最大号 cr-' + Math.max(...nums));
  }
  // 锁3：目录区物理单调
  const inv = [];
  for (let i = 1; i < p.entries.length; i++) {
    if (p.entries[i].n < p.entries[i - 1].n) inv.push('cr-' + p.entries[i].n + ' 位于 cr-' + p.entries[i - 1].n + ' 后');
  }
  if (inv.length) errs.push('锁3：目录区物理逆序 ' + inv.length + ' 处——' + inv.slice(0, 5).join(' / ') + (inv.length > 5 ? ' …' : ''));
  // 锁4：尾部块语法 + 引用存在
  const known = new Set(nums);
  for (const e of p.entries) {
    if (e.tail?.bad !== undefined) errs.push('锁4：cr-' + e.n + ' 尾部块非法字段「' + e.tail.bad + '」');
    for (const r of e.tail?.refs || []) if (!known.has(r)) errs.push('锁4：cr-' + e.n + ' 引用不存在的 →cr-' + r);
    // 锁5（劝告锁）：docs 路径存在性——三级回退链
    // 原位 → docs/design/<名>（cr-262 布局迁移前旧路径）→ docs/design/archive/<名>（归档）。
    // 未命中仅提示不红：登记先于写文档（append 期硬校验会挡正常流程），历史
    // 消亡是正常态；实锤先例 cr-964（登记的文档从未提交）属台账脏数据，软示即可
    for (const path of e.desc.match(/docs\/[\w\-./]+\.md/g) || []) {
      const base = dirname(LOG);
      const name = path.split('/').pop();
      const hit = [join(base, path), join(base, 'docs', 'design', name), join(base, 'docs', 'design', 'archive', name)]
        .some((c) => fs.existsSync(c));
      if (!hit) softWarns.push('cr-' + e.n + ' 文档路径未命中（回退链全 miss）：' + path);
    }
  }
  // 锁6：commit 引用面（懒 sync）
  try {
    const r = doSync(false);
    if (r.dangling.length) errs.push('锁6：悬空 commit 引用 ' + r.dangling.map((n) => 'cr-' + n).join(' '));
  } catch (e) {
    errs.push('锁6：sync 不可用（' + e.message + '）');
  }
  if (errs.length) {
    console.error('check 失败（' + errs.length + ' 项）：\n  ' + errs.join('\n  '));
    process.exit(1);
  }
  for (const w of softWarns) console.log('  提示（不阻断）：' + w);
  console.log('check 通过：六锁全绿（' + nums.length + ' 条，当前号 cr-' + Math.max(...nums) + '，历史路径消亡 ' + softWarns.length + ' 处）');
}

// —— stats ————————————————————————————————————————
function cmdStats() {
  const p = parse(readLog());
  const byStatus = { plan: 0, doing: 0, done: 0, drop: 0 };
  const byDay = {};
  const open = [];
  for (const e of p.entries) {
    byStatus[statusOf(e)]++;
    byDay[e.date] = (byDay[e.date] || 0) + 1;
    if (statusOf(e) === 'plan' || statusOf(e) === 'doing') open.push(e);
  }
  console.log('总计 ' + p.entries.length + ' 条：done ' + byStatus.done + ' / doing ' + byStatus.doing + ' / plan ' + byStatus.plan + ' / drop ' + byStatus.drop);
  const days = Object.keys(byDay).sort().slice(-14);
  console.log('近 14 活跃日：' + days.map((d) => d.slice(5) + ':' + byDay[d]).join('  '));
  if (open.length) {
    console.log('欠账清单（plan/doing）：');
    for (const e of open) console.log('  cr-' + e.n + ' ' + statusOf(e).padEnd(5) + ' ' + e.desc.slice(0, 60) + (e.desc.length > 60 ? '…' : ''));
  } else console.log('欠账清单：空');
}

// —— selftest ————————————————————————————————————————
// sandbox 临时副本（红线：测试数据根住 sandbox/）上过一遍命令面；
// sync/check 依赖 git 面不在自测列（由真实仓库上的 check 兜底）。
function cmdSelftest() {
  const dir = join(REPO_ROOT, 'sandbox', 'cr-selftest-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const logCopy = join(dir, 'cr-log.md');
  fs.copyFileSync(LOG, logCopy);
  const env = { ...process.env, CR_LOG_FILE: logCopy, CR_PROJ_FILE: join(dir, 'cr-commits.json') };
  const self = fileURLToPath(import.meta.url);
  const run = (a) => execFileSync(process.execPath, [self, ...a], { env, encoding: 'utf8' });
  const failures = [];
  const t = (name, fn) => {
    try { fn(); console.log('  ✓ ' + name); } catch (e) { failures.push(name + '：' + e.message); }
  };
  try {
    // append：结构化尾部块 + 状态
    const out1 = run(['append', 'selftest 条目', '#selftest', '--status', 'plan']);
    if (!/已登记 cr-\d+（.*，plan）/.test(out1)) throw new Error('append 输出异常：' + out1.trim());
    const copy1 = fs.readFileSync(logCopy, 'utf8');
    const m = copy1.match(/^- 【cr-(\d+) \S+ selftest 条目】\{plan\|#selftest\}$/m);
    if (!m) throw new Error('尾部块形态不符：' + (copy1.match(/selftest 条目.*/m) || [''])[0]);
    const n = m[1];
    t('append 结构化尾部块', () => {});
    // 尾部 O(1) 追加写：行序正确、结尾形态保留
    const lines1 = copy1.split(/\r?\n/);
    const idx = lines1.findIndex((l) => l.includes('selftest 条目'));
    if (lines1[idx + 1].trim() !== '' || !copy1.endsWith('\r\n\r\n')) throw new Error('追加位置/尾部形态漂移');
    t('尾部追加写形态', () => {});
    // set：状态流转保 scope（done = 缺省，状态词不占位，仅剩 scope）
    run(['set', n, 'done']);
    if (!new RegExp('^- 【cr-' + n + ' [^】]*】\\{#selftest\\}$', 'm').test(fs.readFileSync(logCopy, 'utf8'))) throw new Error('set 未生效或丢 scope');
    t('set 状态流转', () => {});
    // grep：维度过滤
    if (!run(['grep', 'selftest', '--id', 'cr-' + n, '--oneline']).includes('cr-' + n)) throw new Error('grep --id 未命中');
    if (!run(['grep', 'selftest', '--status', 'done', '--oneline']).includes('cr-' + n)) throw new Error('grep --status 未命中');
    if (run(['grep', 'selftest', '--status', 'plan', '--oneline']).includes('cr-' + n)) throw new Error('grep --status 误命中');
    t('grep 维度过滤', () => {});
    // stats：欠账清单
    run(['set', n, 'plan']);
    if (!run(['stats']).includes('cr-' + n)) throw new Error('stats 欠账未列出');
    t('stats 欠账清单', () => {});
    // 全 LF 单态修形
    fs.writeFileSync(logCopy, fs.readFileSync(logCopy, 'utf8').replace(/\r\n/g, '\n'));
    const outFix = run(['grep', 'selftest', '--id', 'cr-' + n, '--oneline']);
    if (!outFix.includes('cr-' + n)) throw new Error('LF 修形后 grep 失效');
    t('全 LF 单态自动修形', () => {});
    // 真实数据面
    if (!run(['grep', '记忆', '--oneline', '-n', '1']).includes('cr-')) throw new Error('grep 真实面空');
    t('grep 真实数据面', () => {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length) return die('selftest 失败：\n  ' + failures.join('\n  '));
  console.log('selftest 全绿（append/追加形态/set/grep/stats/LF 修形）');
}

function usage() {
  console.log([
    '用法：',
    "  node scripts/cr.mjs append '一句话描述' [#标签…] [→cr-引用…] [--status plan|doing|done|drop] [--date YYYY-MM-DD]",
    '  node scripts/cr.mjs set <crN> <plan|doing|done|drop>',
    '  node scripts/cr.mjs grep <词>... [--status S] [--id cr-N] [--scope #x] [-n N] [--oneline]',
    '  node scripts/cr.mjs sync [--rebuild]     生成/增更 cr-commits.json 投影 + 悬空引用校验',
    '  node scripts/cr.mjs check               六锁守门（含锁前自动 sync）',
    '  node scripts/cr.mjs stats               计数面 + plan/doing 欠账清单',
    '  node scripts/cr.mjs selftest            sandbox 临时副本命令面自测',
    '事实源：仓库根 cr-log.md；投影：cr-commits.json（生成物禁手改）；测试隔离：CR_LOG_FILE / CR_PROJ_FILE。',
  ].join('\n'));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'append') cmdAppend(rest);
else if (cmd === 'set') cmdSet(rest);
else if (cmd === 'grep') cmdGrep(rest);
else if (cmd === 'sync') cmdSync(rest);
else if (cmd === 'check') cmdCheck();
else if (cmd === 'stats') cmdStats();
else if (cmd === 'selftest') cmdSelftest();
else usage();

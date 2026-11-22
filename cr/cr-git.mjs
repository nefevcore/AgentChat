#!/usr/bin/env node
// ============================================================
// ac-cr git 扩展 —— sync 投影 + check 守门（cr-1043 拆分；
// v3.1 = cr-1045：meta 出索引后的守门面）
//
//   sync    扫 git log message 中 cr-N 引用 → 生成 cr-commits.json
//           投影（生成物，禁手改）+ 悬空引用校验。增量：投影记
//           scannedHead，merge-base 验祖代后只扫新增 commit；
//           --rebuild 强制全量。
//   migrate v3.1 一次性迁移：索引行内尾部块剥离 → cr-meta.json
//           （幂等：无行内块即 no-op；已迁移台账重跑安全）。
//   check    守门（fail-loud）：①号唯一 ②索引物理单调 ③meta
//           语法合法且引用存在 ④行内残留块检测（应 migrate）⑤
//           描述中相对路径存在（劝告）⑥logs/ 悬挂详情 ⑦commit
//           引用面无悬空（经 sync；无 git 仓库时跳过并提示）。
//           ⑤豁免链（cr-1196）：worktree 存在 → git 历史（移动/删除
//           过的真实路径不告）→ gitignore（本地数据面）→ 白名单
//           cr/path-allowlist.json（存量意图路径显式登记；过时条目
//           反向告警防腐化）。
//   selftest sandbox 临时 git 仓自测（豁免链各层 + 劝告不阻断）。
//
// 项目特定守门（如 AgentChat 的 docs 回退链、cr-1037 键面红线）
// 不进通用工具——住各项目自己的守门面。
// 测试隔离：CR_HOME 指向 cr/ 副本根。
// 用法：node cr/cr-git.mjs migrate && node cr/cr-git.mjs sync && node cr/cr-git.mjs check
// ============================================================
import * as fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HOME = process.env.CR_HOME
  || (fs.existsSync(join(dirname(fileURLToPath(import.meta.url)), 'cr-log.md'))
    ? dirname(fileURLToPath(import.meta.url))
    : fileURLToPath(new URL('../../../cr', import.meta.url)));
const LOG = join(HOME, 'cr-log.md');
const META = join(HOME, 'cr-meta.json');
const LOGS_DIR = join(HOME, 'logs');
const PROJ = join(HOME, 'cr-commits.json');
const LOCK = join(HOME, 'cr.lock');
const STATUSES = new Set(['plan', 'doing', 'done', 'drop']);

const ENTRY_RE = /^- 【cr-(\d+) (\d{4}-\d{2}-\d{2}) (.*?)】(\{[^}]*\})?$/;
// 路径提取（cr-1196 收紧）：每段限 [\w.@-]（支持 @scope/包），排除中文/
// 箭头/全角括号粘连进路径——旧形态 [\w./-]+ 会吞出「46/47→32（README/x」
// 类假路径。./ 前缀由调用侧归一。
const PATH_RE = /(?:[\w.@-]+\/)+[\w.@-]+\.(?:md|json|ya?ml|ts|mjs)/g;

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

function readMeta() {
  try {
    const o = JSON.parse(fs.readFileSync(META, 'utf8'));
    if (o && typeof o === 'object' && !Array.isArray(o)) return o.entries || o;
  } catch { /* 缺失 = 空 */ }
  return {};
}

function readAllowlist() {
  try {
    const o = JSON.parse(fs.readFileSync(join(HOME, 'path-allowlist.json'), 'utf8'));
    if (o && typeof o === 'object' && o.paths && !Array.isArray(o.paths)) return o.paths;
  } catch { /* 缺失/损坏 = 空（fail-open，仅多报劝告） */ }
  return {};
}

// —— migrate（v3.1 一次性，幂等）———————————————————
function cmdMigrate() {
  let changed = 0;
  withLock(() => {
    const text = readLog();
    const p = parse(text);
    if (!p.entries.some((e) => e.tailRaw)) {
      console.log('migrate：无行内尾部块（已是 v3.1 纯净形态），no-op');
      return;
    }
    const meta = readMeta();
    const metaEntries = meta.entries || meta; // 兼容裸映射形态
    for (const e of p.entries) {
      if (!e.tailRaw || !e.tail || e.tail.bad) continue;
      const cur = metaEntries[String(e.n)] || {};
      const merged = {
        status: cur.status ?? e.tail.status ?? undefined,
        scopes: [...new Set([...(cur.scopes || []), ...(e.tail.scopes || [])])],
        refs: [...new Set([...(cur.refs || []), ...(e.tail.refs || [])])],
      };
      if (merged.status === 'done' && !merged.scopes.length && !merged.refs.length) delete metaEntries[String(e.n)];
      else metaEntries[String(e.n)] = merged;
      p.lines[e.lineIdx] = e.raw.replace(/】\{[^}]*\}$/, '】');
      changed++;
    }
    fs.writeFileSync(LOG, p.lines.join('\n'));
    fs.writeFileSync(META, JSON.stringify({
      _comment: 'CR 元数据（v3.1 cr-1045）：status/scopes/refs 稀疏存储，CLI 维护禁手编；无记录 = done 无标签',
      entries: Object.fromEntries(Object.keys(metaEntries).map(Number).sort((a, b) => a - b).map((k) => [String(k), metaEntries[String(k)]])),
    }, null, 1) + '\n');
  });
  console.log('migrate 完成：' + changed + ' 条行内块已剥离入 cr-meta.json');
}

// —— git 面 ————————————————————————————————————————
function gitRoot() {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: HOME, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim();
  } catch { return null; }
}

function gitOk(args, root) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { return null; }
}

// stdin 喂入型 git（check-ignore --stdin）；失败返回 null（check 豁免面 fail-open）
function gitOut(args, root, input) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

// 全历史路径面（--all 全分支）——「登记时真实、后被移动/删除」的豁免依据
function histPaths(root) {
  const out = gitOut(['log', '--all', '--pretty=format:', '--name-only'], root);
  return new Set((out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
}

// gitignore 覆盖面 = 本地数据面（非仓库文件）——豁免
function ignoredSet(root, paths) {
  if (!paths.length) return new Set();
  const out = gitOut(['check-ignore', '--stdin'], root, paths.join('\n'));
  return new Set((out || '').split(/\r?\n/).filter(Boolean));
}

function readProj() {
  try { return JSON.parse(fs.readFileSync(PROJ, 'utf8')); } catch { return null; }
}

// persist=false：内存态校验（check 懒引用面用）——只算不落盘，守门命令禁写副作用。
function doSync(rebuild, persist = true) {
  const root = gitRoot();
  if (root == null) die('sync 需要 git 仓库（cr/ 所在项目）');
  const head = (gitOk(['rev-parse', 'HEAD'], root) || '').trim();
  const prev = readProj();
  let entries = {};
  let range = ['HEAD'];
  if (!rebuild && prev?.scannedHead && prev.entries) {
    if (prev.scannedHead === head) { entries = prev.entries; range = []; }
    else if (gitOk(['merge-base', '--is-ancestor', prev.scannedHead, 'HEAD'], root) != null) {
      entries = JSON.parse(JSON.stringify(prev.entries));
      range = [prev.scannedHead + '..HEAD'];
    }
  }
  if (range.length) {
    const out = gitOk(['log', '--date=short', '--format=%H%x1f%ad%x1f%s%x1f%b%x1e', ...range], root) || '';
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
  const sorted = Object.fromEntries(Object.keys(entries).map(Number).sort((a, b) => a - b)
    .map((n) => [String(n), entries[String(n)]]));
  const refCount = Object.values(entries).reduce((a, v) => a + v.length, 0);
  if (prev?.entries && JSON.stringify(prev.entries) === JSON.stringify(sorted)) {
    return { proj: { ...prev, scannedHead: head }, dangling, refCount, unchanged: true };
  }
  const proj = {
    scannedHead: head,
    generatedAt: new Date().toISOString(),
    _comment: '生成物：node cr/cr-git.mjs sync——禁手改（cr-984）',
    entries: sorted,
  };
  if (persist) fs.writeFileSync(PROJ, JSON.stringify(proj, null, 1) + '\n');
  return { proj, dangling, refCount };
}

function cmdSync(args) {
  const r = doSync(args.includes('--rebuild'));
  console.log('投影已' + (args.includes('--rebuild') ? '全量重建' : '同步') + '：cr-commits.json（' + Object.keys(r.proj.entries).length + ' 个 cr 号 / ' + r.refCount + ' 条 commit 引用）');
  if (r.dangling.length) die('悬空引用 ' + r.dangling.length + ' 个（commit 引用了不存在的 cr 号）：' + r.dangling.map((n) => 'cr-' + n).join(' '));
  console.log('悬空引用：0');
}

// —— check ————————————————————————————————————————
function cmdCheck() {
  const p = parse(readLog());
  const meta = readMeta();
  const metaEntries = meta.entries || meta;
  const errs = [];
  const softWarns = [];
  const nums = p.entries.map((e) => e.n);
  if (!nums.length) errs.push('锁1：目录区没有任何条目');
  const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
  if (dup.length) errs.push('锁1：重复号 ' + [...new Set(dup)].map((n) => 'cr-' + n).join(' '));
  const inv = [];
  for (let i = 1; i < p.entries.length; i++) {
    if (p.entries[i].n < p.entries[i - 1].n) inv.push('cr-' + p.entries[i].n + ' 位于 cr-' + p.entries[i - 1].n + ' 后');
  }
  if (inv.length) errs.push('锁2：索引物理逆序 ' + inv.length + ' 处——' + inv.slice(0, 5).join(' / ') + (inv.length > 5 ? ' …' : ''));
  const known = new Set(nums);
  // meta 语法 + 引用存在 + 与索引号面一致
  for (const [k, v] of Object.entries(metaEntries)) {
    const n = Number(k);
    if (!known.has(n)) errs.push('锁3：cr-meta.json 记录了索引外条目 cr-' + k);
    if (v == null || typeof v !== 'object') { errs.push('锁3：cr-' + k + ' meta 记录非对象'); continue; }
    if (v.status != null && !STATUSES.has(v.status)) errs.push('锁3：cr-' + k + ' 非法 status「' + v.status + '」');
    if (v.scopes != null && !(Array.isArray(v.scopes) && v.scopes.every((s) => /^#\S+$/.test(String(s))))) errs.push('锁3：cr-' + k + ' scopes 非法');
    if (v.refs != null && !(Array.isArray(v.refs) && v.refs.every((r) => Number.isInteger(r) && r > 0))) errs.push('锁3：cr-' + k + ' refs 非法');
    for (const r of v.refs || []) if (!known.has(r)) errs.push('锁3：cr-' + k + ' 引用不存在的 →cr-' + r);
  }
  // 行内残留块检测（应 migrate 剥离；bad 块直接红）
  const residue = p.entries.filter((e) => e.tailRaw);
  if (residue.length) errs.push('锁4：' + residue.length + ' 条行内尾部块残留（v2 形态）——跑 node cr/cr-git.mjs migrate 剥离入 cr-meta.json（含 cr-' + residue[0].n + '）');
  for (const e of residue) if (e.tail?.bad !== undefined && e.tail?.bad != null) errs.push('锁4：cr-' + e.n + ' 行内块非法字段「' + e.tail.bad + '」');
  // 描述中相对路径存在性（劝告；从 git 根解析，./ 归一后走豁免链）：
  // worktree → git 历史（登记时真实、后被移动/删除）→ gitignore（本地
  // 数据面）→ 白名单（存量意图路径显式登记）。索引 append-only 禁手编，
  // 故历史欠账的消解住守门工具而非台账。
  const root = gitRoot();
  const baseDir = root || join(HOME, '..');
  const allow = readAllowlist();
  const miss = [];
  for (const e of p.entries) {
    for (let path of e.desc.match(PATH_RE) || []) {
      path = path.replace(/^\.\//, '');
      if (!fs.existsSync(join(baseDir, path))) miss.push({ n: e.n, path });
    }
  }
  const histSet = root == null ? null : histPaths(root);
  const histMiss = miss.filter((m) => !histSet?.has(m.path));
  const igSet = root == null ? new Set() : ignoredSet(root, histMiss.map((m) => m.path));
  const finalMiss = histMiss.filter((m) => !igSet.has(m.path));
  const allowUsed = new Set();
  for (const m of finalMiss) {
    const hit = allow[m.path];
    if (hit) {
      if (hit.n !== m.n) softWarns.push('cr-' + m.n + ' 白名单过时：' + m.path + ' 登记的是 cr-' + hit.n + '（同路径新 CR 应重新核验）');
      allowUsed.add(m.path);
    } else softWarns.push('cr-' + m.n + ' 路径未命中：' + m.path);
  }
  for (const path of Object.keys(allow)) {
    if (!allowUsed.has(path)) softWarns.push('白名单过时：' + path + '（cr-' + allow[path]?.n + '）已不再触发劝告，可删除');
  }
  // logs/ 悬挂详情
  if (fs.existsSync(LOGS_DIR)) {
    for (const f of fs.readdirSync(LOGS_DIR)) {
      const m = f.match(/^cr-(\d+)\.md$/);
      if (m && !known.has(Number(m[1]))) errs.push('锁5：logs/ 悬挂详情 cr-' + m[1] + '.md（索引无此号）');
    }
  }
  // commit 引用面（懒 sync；无 git 仓库跳过）
  if (root == null) {
    softWarns.push('非 git 仓库——commit 引用面校验跳过');
  } else {
    try {
      const r = doSync(false, false);
      if (r.dangling.length) errs.push('锁6：悬空 commit 引用 ' + r.dangling.map((n) => 'cr-' + n).join(' '));
    } catch (e) {
      errs.push('锁6：sync 不可用（' + e.message + '）');
    }
  }
  if (errs.length) {
    console.error('check 失败（' + errs.length + ' 项）：\n  ' + errs.join('\n  '));
    process.exit(1);
  }
  for (const w of softWarns) console.log('  提示（不阻断）：' + w);
  console.log('check 通过：' + nums.length + ' 条，最大号 cr-' + (nums.length ? Math.max(...nums) : 0) + '，meta ' + Object.keys(metaEntries).length + ' 条，劝告提示 ' + softWarns.length + ' 处');
}

// O_EXCL 锁（与 cr.mjs 同域）
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

// —— selftest ————————————————————————————————————————
// sandbox 临时 git 仓自测：豁免链各层（worktree/历史/gitignore/白名单/
// 过时反报）+ 劝告不阻断 + check 零写副作用（cr-1196）。
function cmdSelftest() {
  const SELF = fileURLToPath(import.meta.url);
  const dir = join(HOME, '..', 'sandbox', 'cr-git-selftest-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const proj = join(dir, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const CR_CLI = fileURLToPath(new URL('./cr.mjs', import.meta.url));
  const run = (a) => execFileSync(process.execPath, [SELF, ...a], { encoding: 'utf8', env: { ...process.env, CR_HOME: join(proj, 'cr') } });
  const failures = [];
  const t = (name, fn) => {
    try { fn(); console.log('  ✓ ' + name); } catch (e) { failures.push(name + '：' + e.message); }
  };
  const assert = (c, msg) => { if (!c) throw new Error(msg); };
  try {
    const g = (a) => execFileSync('git', a, { cwd: proj, encoding: 'utf8' });
    // 建仓：docs/a.md 存在并提交；docs/b.md 提交后删除（历史存在）；
    // .gitignore 排除 meta/（本地数据面）。场景路径均带目录前缀——PATH_RE
    // 只提取含 / 的路径（裸文件名不进提取面）。
    g(['init', '-q']);
    g(['config', 'user.email', 'selftest@local']);
    g(['config', 'user.name', 'selftest']);
    fs.mkdirSync(join(proj, 'docs'));
    fs.writeFileSync(join(proj, 'docs', 'a.md'), 'x');
    fs.writeFileSync(join(proj, 'docs', 'b.md'), 'x');
    fs.writeFileSync(join(proj, '.gitignore'), 'meta/\n');
    g(['add', '.']); g(['commit', '-qm', 'init']);
    fs.rmSync(join(proj, 'docs', 'b.md'));
    g(['add', '-A']); g(['commit', '-qm', 'rm b']);
    // init cr/（cr.mjs 面）+ 台账：五个场景各一条
    execFileSync(process.execPath, [CR_CLI, 'init', proj], { encoding: 'utf8' });
    fs.writeFileSync(join(proj, 'cr', 'cr-log.md'), [
      '# 变更登记目录（CR log）', '',
      '> 自测。', '',
      '## 目录', '',
      '- 【cr-1 2026-01-01 落在 docs/a.md 的真实改动】',
      '- 【cr-2 2026-01-01 曾改 docs/b.md 后删除】',
      '- 【cr-3 2026-01-01 写入 meta/sessions.json 运行期数据】',
      '- 【cr-4 2026-01-01 引用 docs/ghost.md 意图路径】',
      '- 【cr-5 2026-01-01 粘连——46/47→32（docs/a.md 旧正则会吞出假路径】',
      '',
    ].join('\n'));
    // 场景④：白名单豁免 docs/ghost.md（cr-4 登记）
    fs.writeFileSync(join(proj, 'cr', 'path-allowlist.json'), JSON.stringify({
      _comment: '路径劝告白名单（cr-1196）：键=路径，值={n:登记 cr 号,reason}；过时条目反报防腐化。手编后跑 check 校验。',
      paths: { 'docs/ghost.md': { n: 4, reason: 'selftest：意图路径，从未落盘' } },
    }, null, 1) + '\n');
    const out5 = run(['check']);
    assert(!out5.includes('路径未命中'), '豁免后仍告未命中：' + out5);
    assert(!out5.includes('白名单过时'), '白名单过时误报：' + out5);
    assert(!out5.includes('（docs'), '粘连假路径未消除：' + out5);
    assert(/check 通过：5 条/.test(out5), 'check 未通过：' + out5);
    t('豁免链四层（真实/历史/gitignore/白名单）+ 正则收紧', () => {});
    // ⑥ 无白名单时 docs/ghost.md 告但不阻断
    fs.rmSync(join(proj, 'cr', 'path-allowlist.json'));
    const out6 = run(['check']);
    assert(out6.includes('cr-4 路径未命中：docs/ghost.md'), '无白名单未告：' + out6);
    t('无白名单 = 劝告不阻断', () => {});
    // ⑦ 白名单过时反报：路径从描述移除 → 反报可删除
    fs.writeFileSync(join(proj, 'cr', 'path-allowlist.json'), JSON.stringify({
      _comment: 'x', paths: { 'docs/ghost.md': { n: 4, reason: 'x' } },
    }));
    fs.writeFileSync(join(proj, 'cr', 'cr-log.md'), fs.readFileSync(join(proj, 'cr', 'cr-log.md'), 'utf8')
      .replace('引用 docs/ghost.md 意图路径', '引用别的词'));
    const out7 = run(['check']);
    assert(out7.includes('白名单过时：docs/ghost.md'), '过时白名单未反报：' + out7);
    t('白名单过时反报', () => {});
    // ⑧ check 零写副作用：投影不落盘
    fs.rmSync(join(proj, 'cr', 'path-allowlist.json'));
    fs.rmSync(join(proj, 'cr', 'cr-commits.json'), { force: true });
    run(['check']);
    assert(!fs.existsSync(join(proj, 'cr', 'cr-commits.json')), 'check 落盘了投影（写副作用）');
    t('check 零写副作用（投影不落盘）', () => {});
    // ⑨ 显式 sync 落盘 + 无悬空
    const out9 = run(['sync']);
    assert(out9.includes('悬空引用：0'), 'sync 异常：' + out9);
    assert(fs.existsSync(join(proj, 'cr', 'cr-commits.json')), 'sync 未落盘投影');
    t('显式 sync 落盘投影', () => {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length) return die('selftest 失败：\n  ' + failures.join('\n  '));
  console.log('selftest 全绿（豁免链四层/正则收紧/劝告不阻断/白名单过时反报/零写副作用/sync 落盘）');
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'migrate') cmdMigrate();
else if (cmd === 'sync') cmdSync(rest);
else if (cmd === 'check') cmdCheck();
else if (cmd === 'selftest') cmdSelftest();
else {
  console.log([
    '用法（CR_HOME 环境变量可覆盖 cr/ 根寻址）：',
    '  node cr/cr-git.mjs migrate              v3.1 一次性：行内尾部块剥离入 cr-meta.json（幂等）',
    '  node cr/cr-git.mjs sync [--rebuild]     生成/增更 cr-commits.json 投影 + 悬空引用校验',
    '  node cr/cr-git.mjs check                守门（无 git 仓库时 commit 面跳过）',
    '  node cr/cr-git.mjs selftest             sandbox 临时 git 仓自测（豁免链 + 劝告语义）',
  ].join('\n'));
}

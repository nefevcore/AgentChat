#!/usr/bin/env node
// ============================================================
// scripts/cr.mjs —— cr-log 登记/查询 CLI（cr-58）
// cr-log 事实源 src/docs/cr-log.md 的本地管理工具（零依赖）。
//   append  登记新条目——自动取号（目录最大号 +1）、日期缺省当日真实
//           日历日（--date 可覆写）、同步头部「当前号」快查行；写前自检
//           不变量（头行在位/序号无重复/头行=目录最大号），不一致
//           fail-loud 不落盘。
//   grep    条目级检索——多词 AND（字面量、忽略大小写），命中条目整块
//           输出（缩进续行按其引用的 cr 号归属，cr-43 补录形态），
//           最新在前，缺省 15 条（-n N / --oneline 调整）。
// 文件形态约定原样保留（CRLF / 结尾单换行 / 无 BOM）——只做行级插入与
// 头行数字替换。测试隔离：CR_LOG_FILE 环境变量指向副本。
// 用法：
//   node scripts/cr.mjs append '一句话描述' [--date YYYY-MM-DD]
//   node scripts/cr.mjs grep <词>... [-n N] [--oneline]
// ============================================================
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const LOG = process.env.CR_LOG_FILE
  || fileURLToPath(new URL('../src/docs/cr-log.md', import.meta.url));

const ENTRY_RE = /^- 【cr-(\d+) (\d{4}-\d{2}-\d{2}) /;
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

function parse(text) {
  const lines = text.split(/\r?\n/);
  const tocIdx = lines.findIndex((l) => l.startsWith('## 目录'));
  let headIdx = -1;
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    if (headIdx === -1 && i < tocIdx && HEAD_RE.test(lines[i])) headIdx = i;
    const m = lines[i].match(ENTRY_RE);
    if (m) entries.push({ n: Number(m[1]), lineIdx: i });
  }
  return { lines, headIdx, entries };
}

// 写前不变量自检（与守门测试 src/ac-app/tests/cr-log.test.ts 同口径）
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

// 条目块 = 条目行 + 其后的非条目非空行；缩进续行（「  - cr-N …」）归属
// 其引用的 cr 号（cr-43 补录的续行物理位置在条目行之前，按引用归属）
function blocks(p) {
  const byN = new Map(p.entries.map((e) => [e.n, { n: e.n, body: [] }]));
  let cur = null;
  for (const line of p.lines) {
    const m = line.match(ENTRY_RE);
    if (m) {
      cur = byN.get(Number(m[1]));
      cur.body.push(line);
      continue;
    }
    if (!cur || !line.trim()) continue;
    const cont = line.match(/^\s+- cr-(\d+)\b/);
    const owner = cont ? byN.get(Number(cont[1])) : null;
    (owner || cur).body.push(line);
  }
  return [...byN.values()];
}

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

function cmdAppend(args) {
  const pos = [];
  let date = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date') date = args[++i];
    else pos.push(args[i]);
  }
  const desc = pos.join(' ').replace(/\s+/g, ' ').trim();
  if (!desc) die("append 缺描述：node scripts/cr.mjs append '一句话描述'");
  if (desc.includes('】')) die('描述不得包含「】」（条目行以 】 收尾）');
  if (date != null && !validDate(date)) die('--date ' + date + ' 不是合法日历日 YYYY-MM-DD');
  const text = readLog();
  if (/(?<!\r)\n/.test(text)) die('cr-log 存在裸 LF 行（EOL 混杂），先统一再登记');
  const p = parse(text);
  let next;
  try {
    next = assertInvariant(p) + 1;
  } catch (e) {
    return die(e.message);
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  // 插入点 = 目录尾部最后一个非空行之后（末条目块可能带缩进续行）
  let at = p.lines.length;
  while (at > 0 && p.lines[at - 1].trim() === '') at--;
  p.lines.splice(at, 0, '- 【cr-' + next + ' ' + (date || today()) + ' ' + desc + '】');
  p.lines[p.headIdx] = p.lines[p.headIdx].replace(/^> \*\*当前号：cr-\d+\*\*/, '> **当前号：cr-' + next + '**');
  fs.writeFileSync(LOG, p.lines.join(eol));
  console.log('已登记 cr-' + next + '（' + (date || today()) + '），头行已同步');
}

function cmdGrep(args) {
  const words = [];
  let limit = 15;
  let oneline = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n') limit = Number(args[++i]) || 15;
    else if (args[i] === '--oneline') oneline = true;
    else words.push(args[i].toLowerCase());
  }
  if (!words.length) die('grep 缺关键词：node scripts/cr.mjs grep <词>... [-n N] [--oneline]');
  const p = parse(readLog());
  const hits = blocks(p).filter((b) => {
    const s = b.body.join('\n').toLowerCase();
    return words.every((w) => s.includes(w));
  });
  if (!hits.length) {
    console.log('（无命中：' + words.join(' ') + '）');
    return;
  }
  const shown = hits.slice(-limit).reverse();
  console.log(shown.map((b) => (oneline ? b.body[0] : b.body.join('\n'))).join('\n\n'));
  if (hits.length > shown.length) {
    console.log('（命中 ' + hits.length + ' 条，仅示最新 ' + shown.length + ' 条——-n N 调整）');
  }
}

function usage() {
  console.log([
    '用法：',
    "  node scripts/cr.mjs append '一句话描述' [--date YYYY-MM-DD]  登记新条目（自动取号/当日日期/同步头行）",
    '  node scripts/cr.mjs grep <词>... [-n N] [--oneline]         查询条目（多词 AND，整块输出，最新在前）',
    '事实源：src/docs/cr-log.md；测试隔离：CR_LOG_FILE 环境变量指向副本。',
  ].join('\n'));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'append') cmdAppend(rest);
else if (cmd === 'grep') cmdGrep(rest);
else usage();

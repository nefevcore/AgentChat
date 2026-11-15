// cr-1106 词表 watchdog:扫数据根全部 messages.jsonl,断言 source/injectSource
// 词 ∈ 声明词表(机制词 + 内容词 + v1 历史词)——防私生词落盘。比文档可靠:
// 新词未登记即在这里 fail-loud。
// 用法:node scripts/check-replay-vocab.mjs [dataRoot]
import * as fs from 'node:fs';
import * as path from 'node:path';

const dataRoot = path.resolve(process.argv[2] ?? './workspace/home');

// 声明词表(与 ac-ledger REPLAY_BUILTIN_WORDS + 各插件 registerReplayPolicy 狗粮对齐)
const VOCAB = new Set([
  // 机制词(封闭)
  'event', 'error', 'inject', 'segment', 'resume',
  // 内容词(历史既得 + cr-1104 狗粮注册)
  'skill', 'memory-snapshot', 'memory-delta', 'durable-interaction',
  // v1 导入/历史投影专用
  'subcall', 'corrupt-line',
]);

function listSessions(root) {
  const out = [];
  let agents;
  try { agents = fs.readdirSync(path.join(root, 'agents'), { withFileTypes: true }); } catch { return out; }
  for (const a of agents) {
    if (!a.isDirectory()) continue;
    const sdir = path.join(root, 'agents', a.name, 'sessions');
    let uuids;
    try { uuids = fs.readdirSync(sdir, { withFileTypes: true }); } catch { continue; }
    for (const u of uuids) {
      if (!u.isDirectory()) continue;
      const f = path.join(sdir, u.name, 'messages.jsonl');
      if (fs.existsSync(f)) out.push(f);
    }
  }
  return out;
}

const files = listSessions(dataRoot);
const unknown = new Map();
let rows = 0;
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter((x) => x.trim() !== '');
  for (let i = 1; i < lines.length; i++) {
    let r;
    try { r = JSON.parse(lines[i]); } catch { continue; }
    rows++;
    for (const w of [r.source, r.injectSource]) {
      if (w === undefined || w === '') continue;
      if (w.startsWith('run:')) continue; // v1 存量终稿行联查键(前缀词)
      if (!VOCAB.has(w)) {
        const key = w + ' @ ' + f.split('sessions').at(-1)?.slice(0, 30);
        if (!unknown.has(w)) unknown.set(w, []);
        if (unknown.get(w).length < 3) unknown.get(w).push(f);
      }
    }
  }
}
console.log('扫描 ' + files.length + ' 会话 / ' + rows + ' 行;词表 ' + VOCAB.size + ' 词');
if (unknown.size > 0) {
  for (const [w, fs_] of unknown) console.error('私生词: ' + w + ' (' + fs_.length + ' 例,如 ' + fs_[0] + ')');
  process.exit(1);
}
console.log('✓ 词表 watchdog 通过——零私生词');

// cr-1238 键词法守门：全仓 .ts 源码（跳过 dist/node_modules/测试快照）扫
// split('~') / .includes('~') / startsWith('sub_') / startsWith('g-') / uuid
// 正则副本——白名单外 fail-loud（cr-1196 check-replay-vocab 先例）。
// 白名单口径 = B1 表 B 分类：键库本体、src convKey 前缀（前端视图命名空间）、
// 断言性测试（singles-row/wakeup/session-query——改用键库谓词在后续顺手批）、
// 构造词调用（pairKey/runAddress/memberStreamKey 产物侧不再手拼）。
// 用法：node scripts/check-conv-lexicon.mjs
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const PATTERNS = [
  ['split-tilde', /\.split\('~'\)/],
  ['includes-tilde', /\.includes\('~'\)/],
  ['starts-sub', /startsWith\('sub_'\)/],
  ['starts-g', /startsWith\('g-'\)/],
  ['uuid-re-copy', /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/],
];

const ALLOW = [
  // 键库本体（词法单源自身）
  'packages/ac-conv-keys/src/keys.ts',
  // 构造词实现搬迁残留注记与转发层
  'packages/ac-core-utils/src/index.ts',
  'packages/ac-ledger/src/user.ts',
  // src convKey 前缀解析（前端视图命名空间——B1 表 A 注记：非会话键族）
  'packages/ac-client-ui-runview/client/index.ts',
  // gid/Agent id 合法性断言（assertGid/assertAgentId 禁 ~——构造侧守门：
  // 身份词禁分隔符是 M19 承重墙，与「解析既有键」方向相反）
  'packages/ac-core-utils/src/groups.ts',
  'packages/ac-agents/src/service.ts',
  // uuid 签发自测（同形不同义：签发断言非键判词）
  'packages/ac-envelope-core/tests/issue.test.ts',
  // requestId 哈希同形断言（B1 表 B 注记：非会话键用途）
  'packages/ac-llm-pool/tests/session-affinity.test.ts',
  // src convKey 前缀解析（RunTrackingPanel——前端视图命名空间，同上注记）
  'packages/ac-client-ui-runview/client/RunTrackingPanel.vue',
  // 索引域 g- 优先序映射（sessionKindOf——语义映射层）
  'packages/ac-session-index/src/core.ts',
  // 历史测试断言（回归锁用词法字面量断言不迁移对象——行为锁面）
  'packages/ac-host-rows/tests/singles-row.test.ts',
  'packages/ac-jobs/tests/wakeup.test.ts',
  'packages/ac-shell-rows/tests/session-query.test.ts',
  'packages/ac-bench/tests/bfcl.test.ts',
];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.') || e.name === 'sandbox' || e.name === 'cr') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') || e.name.endsWith('.vue')) out.push(p);
  }
}

const files = [];
for (const top of ['packages', 'apps']) walk(path.join(ROOT, top), files);
const offenders = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  if (ALLOW.includes(rel)) continue;
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [kind, re] of PATTERNS) {
      if (re.test(line)) offenders.push(rel + ':' + (i + 1) + ' [' + kind + '] ' + line.trim().slice(0, 100));
    }
  });
}
if (offenders.length > 0) {
  console.error('键词法白名单外命中 ' + offenders.length + ' 处（cr-1238 守门——迁移到 ac-conv-keys 或登记白名单）：');
  for (const o of offenders) console.error('  ' + o);
  process.exit(1);
}
console.log('✓ 键词法守门通过（白名单 ' + ALLOW.length + ' 文件，全仓词法判定单源 ac-conv-keys）');
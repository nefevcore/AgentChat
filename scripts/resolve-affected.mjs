// ============================================================
// scripts/resolve-affected.mjs —— affected 档求解器：git 变更 → 定向测试面
//
// 变更集 = 工作树（staged+unstaged+untracked）相对 base：--base > env
// AFFECTED_BASE > upstream merge-base > HEAD~1（孤立克隆兜底）。输出应跑
// 测试的包目录（root 相对 posix 路径，stdout 每行一个）——run-tests.mjs
// affected 档消费作 vitest 路径过滤器；--json 输出完整求解信息。
//
// 结构域 fail-loud（exit 5）：scripts/、根测试配置（vitest/tsconfig/
// eslint）、pnpm-workspace.yaml、apps/catalog/（基座源文档与生成投影）
// 的变更影响全测试面或须全量 + gen 校验（见验证阶梯），不由包依赖图
// 推断——调用方收到 5 转全量。
//
// 依赖图现算：workspace 包 package.json 的 workspace:* 依赖边（BFS 反查
// dependents——改 ac-llm 会带上所有 inject 它的能力包）。裸名与 @scope
// 名均按 name 解析。无 tests/ 的包不产生输出（风险沿 dependents 链传导
// 到有测试的包）；变更全落在无测试包时输出空列表（调用方跳过，exit 0）。
// ============================================================
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

// ---- CLI ----
const argv = process.argv.slice(2);
let base = process.env.AFFECTED_BASE ?? null;
let json = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--base') base = argv[++i];
  else if (argv[i] === '--json') json = true;
}

function sh(cmd) {
  return execFileSync(cmd[0], cmd.slice(1), { cwd: REPO_ROOT, encoding: 'utf8' });
}

// ---- 基线：--base > env > upstream merge-base > HEAD~1 ----
let baseRef = base;
if (!baseRef) {
  try {
    const mb = sh(['git', 'merge-base', 'HEAD', '@{upstream}']).trim();
    baseRef = mb || 'HEAD~1';
  } catch {
    baseRef = 'HEAD~1'; // 无 upstream（孤立克隆）——对比上一提交
  }
}

// ---- 变更集（含 untracked；posix 化）----
const changed = [
  ...sh(['git', 'diff-index', '--name-only', '-z', baseRef]).split('\0'),
  ...sh(['git', 'ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
]
  .filter(Boolean)
  .map((p) => p.split('\\').join('/'));

// ---- 结构域 fail-loud（exit 5）----
const STRUCTURAL_PREFIXES = [
  'scripts/',
  'apps/catalog/',
];
const STRUCTURAL_EXACT = [
  'vitest.config.ts',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'eslint.config.js',
  'eslint.config.mjs',
];
const structuralHit = changed.find(
  (p) => STRUCTURAL_PREFIXES.some((pre) => p.startsWith(pre)) || STRUCTURAL_EXACT.includes(p),
);
if (structuralHit) {
  console.error(`[resolve-affected] 结构域变更 ${structuralHit}（测试基建/基座/生成投影——见验证阶梯，须全量与 gen 校验，不由依赖图推断）`);
  process.exit(5);
}

// ---- workspace 包扫描（pnpm-workspace.yaml 的目录约定）----
const SCAN_DIRS = ['packages', 'packages/vendor', 'apps'];
const pkgs = []; // { name, dir, deps: string[], hasTests }
for (const dir of SCAN_DIRS) {
  for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pj = join(REPO_ROOT, dir, entry.name, 'package.json');
    if (!existsSync(pj)) continue;
    const meta = JSON.parse(readFileSync(pj, 'utf8'));
    const deps = Object.entries({ ...meta.dependencies, ...meta.devDependencies })
      .filter(([, v]) => String(v).startsWith('workspace'))
      .map(([k]) => k);
    pkgs.push({
      name: meta.name,
      dir: `${dir}/${entry.name}`,
      deps,
      hasTests: existsSync(join(REPO_ROOT, dir, entry.name, 'tests')),
    });
  }
}
// desktop 是 workspace 独立根（无 workspace 依赖、无人依赖它——孤岛节点，
// 变更只映射自身测试）
if (existsSync(join(REPO_ROOT, 'desktop', 'package.json'))) {
  const meta = JSON.parse(readFileSync(join(REPO_ROOT, 'desktop', 'package.json'), 'utf8'));
  pkgs.push({ name: meta.name, dir: 'desktop', deps: [], hasTests: existsSync(join(REPO_ROOT, 'desktop', 'tests')) });
}
const byDir = new Map(pkgs.map((p) => [p.dir, p]));
const byName = new Map(pkgs.map((p) => [p.name, p]));

// ---- 变更文件 → 归属包（两层 packages/*、三层 packages/vendor/*、desktop/）----
const changedPkgs = new Set();
for (const file of changed) {
  const seg = file.split('/');
  // 候选从长到短：vendor 三层 → 普通两层 → 单层独立根（desktop）
  const cand = [
    seg.length >= 3 ? `${seg[0]}/${seg[1]}/${seg[2]}` : null,
    seg.length >= 2 ? `${seg[0]}/${seg[1]}` : null,
    seg[0],
  ].filter(Boolean);
  for (const c of cand) if (byDir.has(c)) { changedPkgs.add(byDir.get(c)); break; }
}

// ---- 依赖图反查：dep name → 消费者集合，BFS 闭包 ----
const consumers = new Map();
for (const p of pkgs) {
  for (const d of p.deps) {
    if (!consumers.has(d)) consumers.set(d, new Set());
    consumers.get(d).add(p.name);
  }
}
const affectedNames = new Set([...changedPkgs].map((p) => p.name));
const queue = [...affectedNames];
while (queue.length) {
  const n = queue.shift();
  for (const c of consumers.get(n) ?? []) {
    if (!affectedNames.has(c)) { affectedNames.add(c); queue.push(c); }
  }
}

const affectedDirs = pkgs.filter((p) => affectedNames.has(p.name) && p.hasTests).map((p) => p.dir).sort();
const untestedChanged = [...changedPkgs].filter((p) => !p.hasTests).map((p) => p.name);

// ---- 输出 ----
if (json) {
  console.log(JSON.stringify({ base: baseRef, changedCount: changed.length, affected: affectedDirs, untestedChanged }, null, 2));
} else {
  for (const d of affectedDirs) console.log(d);
}
console.error(
  `[resolve-affected] base=${baseRef} 变更 ${changed.length} 文件 → 受影响包 ${affectedNames.size}（含测试 ${affectedDirs.length}${untestedChanged.length ? `，无测试包跳过：${untestedChanged.join(', ')}` : ''}）`,
);

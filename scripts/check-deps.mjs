// ============================================================
// scripts/check-deps.mjs —— 工作区依赖卫生守卫
//
// 防止耦合分析（2026-08-20）中发现的问题回归：
//   R1 未声明依赖：包 src/ 运行时代码 import 的 @agentchat/* 必须声明在
//      dependencies（或 peerDependencies），不得只挂在 devDependencies
//   R2 测试依赖：tests/ 或 *.test.ts import 的 @agentchat/* 至少声明在
//      dependencies ∪ devDependencies
//   R3 深路径 import：@agentchat/<pkg>/<deep/...> 形式禁止（绕过包入口，
//      内部文件移动即断）；暂无豁免条目（旧 bundle-rows.gen 生成物已随
//      轨道切换移除，新轨行表为手写 TREE + 双表一致测试锁定）
//   R4 无用声明：@agentchat/* 声明后全包（src + tests）零 import 视为冗余
//   R5 运行时循环依赖（2026-09-05 插件边界评估建议 #2）：src/ 下工作区
//      包（src/vendor 上游除外）src/ 源文件的【运行时值导入】构建包级
//      图，DFS 检环——环 = 构建期硬失败（替代手工 depscan；type-only
//      互相引用是弱依赖，不构成环）。首个被它拦下的环：ac-session⇄
//      ac-group（isGroupHint/maxSeqOf 已下沉 ac-core-utils 解除）
//
// 用法：node scripts/check-deps.mjs（或 pnpm check:deps；publish.yml CI 门槛）
// 退出码：发现违例 = 1（CI 阻断）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

/** 深路径 import 豁免清单（生成物；按仓库相对路径匹配。当前为空） */
const DEEP_PATH_ALLOW = new Set([]);

const IMPORT_RE = /(?:from\s+|import\(\s*)['"](@agentchat\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*)['"]/g;

/** 收集工作区包：路径 → package.json 对象 */
function findPackages() {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (ent.name !== 'package.json') continue;
      const pkgDir = path.dirname(full);
      let pkg;
      try { pkg = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
      if (pkg?.name?.startsWith('@agentchat/')) out.push({ pkgDir, pkg });
    }
  };
  walk(SRC);
  return out;
}

function listFiles(pkgDir) {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (ent.name === 'node_modules' || ent.name === 'dist') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (/\.(ts|tsx|mts|mjs|vue)$/.test(ent.name)) out.push(full);
    }
  };
  for (const sub of ['src', 'tests']) walk(path.join(pkgDir, sub));
  return out;
}

const errors = [];
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

for (const { pkgDir, pkg } of findPackages()) {
  const deps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
  const devDeps = new Set(Object.keys(pkg.devDependencies ?? {}));
  const files = listFiles(pkgDir);
  const imported = new Set();

  for (const file of files) {
    const isTest = file.replaceAll(path.sep, '/').includes('/tests/') || /\.test\.[a-z]+$/.test(file);
    const content = fs.readFileSync(file, 'utf8');
    for (const m of content.matchAll(IMPORT_RE)) {
      const spec = m[1];
      const segments = spec.split('/');
      const target = segments.slice(0, 2).join('/');
      imported.add(target);
      if (target === pkg.name) continue; // 自引用按内部路径处理
      // R3 深路径
      if (segments.length > 2 && !DEEP_PATH_ALLOW.has(rel(file))) {
        errors.push(`R3 深路径 import：${rel(file)} → '${spec}'（应改走包入口导出）`);
      }
      // R1/R2 声明检查
      if (isTest) {
        if (!deps.has(target) && !devDeps.has(target)) {
          errors.push(`R2 测试未声明依赖：${rel(file)} → '${target}'`);
        }
      } else if (!deps.has(target)) {
        errors.push(`R1 运行时未声明依赖：${rel(file)} → '${target}'（需加入 dependencies）`);
      }
    }
  }

  // R4 无用声明（仅 @agentchat/* 工作区依赖；vendor 包按上游声明原样保留）
  if (!rel(pkgDir).startsWith('src/vendor/')) {
    for (const name of [...deps, ...devDeps]) {
      if (!name.startsWith('@agentchat/')) continue;
      if (!imported.has(name) && name !== pkg.name) {
        errors.push(`R4 无用声明：${pkg.name} → ${name}（src/tests 均未 import）`);
      }
    }
  }
}

// ============================================================
// R5 包级运行时循环依赖（src/ 全工作区包；src/vendor 上游除外）
// ============================================================

/** 收集全部工作区包（含 ac-*；不含 src/vendor 上游与隐藏目录） */
function findAllPackages() {
  const out = new Map(); // name → pkgDir
  const walk = (dir, vendored) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full, vendored || ent.name === 'vendor'); continue; }
      if (ent.name !== 'package.json' || vendored) continue;
      const pkgDir = path.dirname(full);
      let pkg;
      try { pkg = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
      if (typeof pkg?.name === 'string' && pkg.name) out.set(pkg.name, pkgDir);
    }
  };
  walk(SRC, false);
  return out;
}

/** import 声明是否 type-only（`import type` 或全部具名绑定带 type 前缀） */
function importIsTypeOnly(clause) {
  if (!clause) return false; // 副作用裸 import：算运行时边
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  const specs = bindings && ts.isNamedImports(bindings) ? [...bindings.elements] : [];
  if (clause.name !== undefined) return false; // 默认绑定是值
  if (bindings && ts.isNamespaceImport(bindings)) return false;
  return specs.length > 0 && specs.every((s) => s.isTypeOnly);
}

/** 解析单个源文件的运行时 import 目标（工作区包名） */
function runtimeImportsOf(file, names) {
  const out = new Set();
  const resolve = (spec) => {
    const segments = spec.split('/');
    const scoped = spec.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
    if (names.has(spec)) return spec;
    if (names.has(scoped)) return scoped;
    return undefined;
  };
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier) && !importIsTypeOnly(node.importClause)) {
        const t = resolve(node.moduleSpecifier.text);
        if (t !== undefined) out.add(t);
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      // re-export 是运行时值导出（export type 除外）
      if (!(node.exportClause?.isTypeOnly === true)) {
        const t = resolve(node.moduleSpecifier.text);
        if (t !== undefined) out.add(t);
      }
    } else if (
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
    ) {
      const t = resolve(node.arguments[0].text); // 动态 import = 运行时
      if (t !== undefined) out.add(t);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

{
  const packages = findAllPackages();
  const names = new Set(packages.keys());
  const graph = new Map(); // pkg → Set<运行时依赖包>
  for (const [name, pkgDir] of packages) {
    const edges = new Set();
    for (const file of listFiles(pkgDir)) {
      if (file.replaceAll(path.sep, '/').includes('/tests/') || /\.test\.[a-z]+$/.test(file)) continue;
      if (!/\.(ts|tsx|mts)$/.test(file)) continue; // .vue 不进包级环图（前端面）
      for (const target of runtimeImportsOf(file, names)) {
        if (target !== name) edges.add(target);
      }
    }
    graph.set(name, edges);
  }

  // Tarjan SCC：>1 节点的强连通分量（或自环）= 运行时循环依赖
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  let counter = 0;
  const cycles = [];

  const strongconnect = (v) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue; // 非本图节点（vendor/外部）不追
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const scc = [];
      for (;;) {
        const w = stack.pop();
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      if (scc.length > 1 || (graph.get(v) ?? new Set()).has(v)) cycles.push(scc);
    }
  };
  for (const v of graph.keys()) {
    if (!index.has(v)) strongconnect(v);
  }

  for (const scc of cycles) {
    // 环内按可追溯顺序展示一条回路（成员 → 成员，回到起点）
    const members = [...scc].sort();
    const loop = [...members, members[0]].join(' → ');
    errors.push(`R5 运行时循环依赖：${loop}（下沉公共纯库或改单向依赖/type-only）`);
  }
}

if (errors.length > 0) {
  console.error(`✗ 依赖卫生检查未通过（${errors.length} 项）：\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('✓ 依赖卫生检查通过（R1 未声明 / R2 测试声明 / R3 深路径 / R4 无用声明 / R5 运行时环）');

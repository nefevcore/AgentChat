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
//
// 用法：node scripts/check-deps.mjs（或 pnpm check:deps）
// 退出码：发现违例 = 1（CI 阻断）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

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

if (errors.length > 0) {
  console.error(`✗ 依赖卫生检查未通过（${errors.length} 项）：\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('✓ 依赖卫生检查通过（R1 未声明 / R2 测试声明 / R3 深路径 / R4 无用声明）');

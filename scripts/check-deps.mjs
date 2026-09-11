// ============================================================
// scripts/check-deps.mjs —— 工作区依赖卫生守卫
//
// 防止耦合分析（2026-08-20）中发现的问题回归 + M29 P0-1 开眼：
//   R1 未声明依赖：包 src//client/ 生产代码的【运行时值导入】所及
//      @agentchat/* 与 ac-* 工作区包必须声明在 dependencies（或
//      peerDependencies）；type-only 导入至少 devDependencies
//      （M29：IMPORT 面自正则升级为 TS AST——非域名裸名 ac-* 纳入、
//      side-effect 裸 import（css 等）与 export type 边界一并可见）
//   R2 测试依赖：tests/ 或 *.test.* import 的 @agentchat/* 与 ac-* 至少
//      声明在 dependencies ∪ devDependencies（type-only 同样计入——
//      测试文件无运行时/类型之分的地毯要求）
//   R3 深路径 import：@agentchat/<pkg>/<deep/...> 形式禁止（绕过包入口，
//      内部文件移动即断；exports 映射的非通配显式子路径 = 合法入口，
//      './src/*' 通配覆盖同样算深路径）；暂无豁免条目。裸名 ac-* 不适用
//      （UI 行 client/ 子路径 = 设计入口，M29 裁决豁免）
//   R4 无用声明：@agentchat/* 与 ac-* 声明后全包（src + tests + client）
//      零 import（值或类型）视为冗余；npm 依赖同判（dependencies 面
//      ——2026-11 补扫：消费证据 = 源码裸名 import〔静态 from / 动态
//      import() / require，值与类型同计〕、vite.config.* 打包面引用
//      〔manualChunks 分组等〕、.vue 生产文件对 vue 的 SFC 隐式消费、
//      @iconify-json/* 的 unplugin-icons 约定消费、工作区依赖的
//      peerDependencies 供给义务；devDependencies 的 npm 侧不扫——
//      tsc/vitest/@types 等工具链无 import 消费形态）
//   R5 运行时循环依赖：工作区包（src/vendor 上游除外）源文件的
//      【运行时值导入】构建包级图，Tarjan SCC 检环——环 = 构建期硬失败
//      （type-only 互相引用是弱依赖，不构成环）。.ts 边进图，.vue 边
//      不进（bundler 层 .vue 环由 R7 相位守卫按 base→domain 方向覆盖）
//   R6 行包图跨域边（M29 改守；2026-11 扩权 .ts/.vue 同权重）：原守
//      webui/src/clients 目录已随 M28 退役（幽灵规则）；改为守行包图——
//      domain 行生产文件（.ts 与 .vue）的运行时值导入不得指向其他
//      domain 行（域间运行时耦合只允许经 base 服务面/席位贡献）。
//      2026-11 前仅守 .ts 边，.vue 媒介数据面 import 落盲区
//      （PoolManager→rosterApi 实证）；扩权后 .vue 组件/数据面跨域边
//      一律显式入册 scripts/dep-cycles.yml（基线一次性扩充裁决）
//   R7 相位守卫（M29 新增）：base 行不得静态运行时依赖 domain 行
//      （T4；.ts 与 .vue 边同权重——bundler 层 .vue 互引同样是运行时边，
//      复审 F1 实证）。相位源 = 各行 package.json
//      agentchat.client.phase。存量违例以 scripts/dep-cycles.yml 白名单
//      入册，**白名单只减不增**：新边 = 红；条目消化后不删 = 红
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

/** import 说明符 → 工作区包名（@scope/name 取前两段；裸名取第一段） */
const packageNameOf = (spec) => {
  const segments = spec.split('/');
  return spec.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
};

/** 收集全部工作区包：name → { pkgDir, pkg }（vendor 上游同收——R1-R4 对其生效） */
function findAllPackages() {
  const out = new Map();
  const walk = (dir, vendored) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full, vendored || ent.name === 'vendor'); continue; }
      if (ent.name !== 'package.json') continue;
      const pkgDir = path.dirname(full);
      let pkg;
      try { pkg = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
      if (typeof pkg?.name === 'string' && pkg.name) out.set(pkg.name, { pkgDir, pkg });
    }
  };
  walk(SRC, false);
  return out;
}

const workspace = findAllPackages();
const names = new Set(workspace.keys());

/** 包 exports 映射的非通配公开子路径（'.' 之外的显式键——css/入口类） */
const explicitExports = new Map(); // pkg name → Set<'./tokens.css' 之类>
for (const [name, { pkg }] of workspace) {
  const ex = pkg?.exports;
  if (!ex || typeof ex !== 'object' || Array.isArray(ex)) continue;
  const keys = typeof ex === 'string' ? [] : Object.keys(ex);
  explicitExports.set(name, new Set(keys.filter((k) => k !== '.' && !k.includes('*'))));
}

/**
 * R3 深路径判定（仅 @agentchat/* 域名包）：子路径超出包名且【不在】
 * exports 映射的非通配显式键上 = 绕过策展入口（'./src/*' 通配同样算
 * 深路径——入口自述与文件布局解耦才是 R3 的保护对象）。
 * 裸名 ac-* 不适用（UI 行 client/ 子路径 = 设计入口，M29 裁决豁免）。
 */
function isDeepPath(spec) {
  if (!spec.startsWith('@agentchat/')) return false;
  const segments = spec.split('/');
  if (segments.length <= 2) return false;
  const pkgName = packageNameOf(spec);
  const subpath = `./${segments.slice(2).join('/')}`;
  return !(explicitExports.get(pkgName)?.has(subpath) ?? false);
}

/** 扫描包源码目录：src/ + tests/ + client/（M29 P0-1 补 client——UI 行半边） */
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
  for (const sub of ['src', 'tests', 'client']) walk(path.join(pkgDir, sub));
  return out;
}

const isTestFile = (file) =>
  file.replaceAll(path.sep, '/').includes('/tests/') || /\.test\.[a-z]+$/.test(file);

const errors = [];
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

// ============================================================
// import 边提取（TS AST；.vue 取 <script> 块，带文件内行号）
// ============================================================

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

/**
 * 解析单个源文件的全部工作区 import 边（.ts 直读；.vue 逐 <script> 块）。
 * 返回 [{ target, spec, line, typeOnly }]——target = 工作区包名，
 * line = 文件内 1 起行号，typeOnly = 弱依赖（类型层认识，非运行时边）。
 */
function importEntries(file) {
  const content = fs.readFileSync(file, 'utf8');
  const out = [];
  const analyze = (text, lineOffset) => {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      let spec = null;
      let typeOnly = false;
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        spec = node.moduleSpecifier.text;
        typeOnly = importIsTypeOnly(node.importClause);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        // re-export：`export type {…} from` 的 isTypeOnly 在声明节点上
        spec = node.moduleSpecifier.text;
        typeOnly = node.isTypeOnly === true;
      } else if (
        ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
      ) {
        spec = node.arguments[0].text; // 动态 import = 运行时
      }
      if (spec !== null) {
        const target = packageNameOf(spec);
        if (names.has(target)) {
          out.push({ target, spec, line: lineOffset + sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, typeOnly });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  };
  if (file.endsWith('.vue')) {
    for (const m of content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      analyze(m[1], content.slice(0, m.index).split('\n').length - 1);
    }
  } else {
    analyze(content, 0);
  }
  return out;
}

/** 运行时值边（R5/R6/R7 用——type-only 是弱依赖，不构成边） */
const runtimeImportEntries = (file) => importEntries(file).filter((e) => !e.typeOnly);

// ============================================================
// R1-R4 声明检查（AST 面：值导入 / 类型导入 / side-effect 一并可见）
// ============================================================
for (const [, { pkgDir, pkg }] of workspace) {
  if (rel(pkgDir).startsWith('src/vendor/')) continue; // 上游按自带声明原样保留
  const deps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
  const devDeps = new Set(Object.keys(pkg.devDependencies ?? {}));
  const importedAny = new Set(); // 值 + 类型（R4 判「无用」用）

  for (const file of listFiles(pkgDir)) {
    const isTest = isTestFile(file);
    for (const e of importEntries(file)) {
      importedAny.add(e.target);
      if (e.target === pkg.name) continue; // 自引用按内部路径处理
      // R3 深路径（exports 映射感知，见 isDeepPath）
      if (isDeepPath(e.spec) && !DEEP_PATH_ALLOW.has(rel(file))) {
        errors.push(`R3 深路径 import：${rel(file)}:${e.line} → '${e.spec}'（应改走包入口导出）`);
      }
      if (isTest) {
        // R2：测试文件地毯要求（type-only 同样计入）
        if (!deps.has(e.target) && !devDeps.has(e.target)) {
          errors.push(`R2 测试未声明依赖：${rel(file)}:${e.line} → '${e.target}'`);
        }
      } else if (!e.typeOnly) {
        // R1：生产代码运行时值导入 → dependencies
        if (!deps.has(e.target)) {
          errors.push(`R1 运行时未声明依赖：${rel(file)}:${e.line} → '${e.target}'（需加入 dependencies）`);
        }
      } else if (!deps.has(e.target) && !devDeps.has(e.target)) {
        // R1 弱形态：生产代码 type-only 导入 → 至少 devDependencies
        errors.push(`R1 类型导入未声明：${rel(file)}:${e.line} → '${e.target}'（至少 devDependencies）`);
      }
    }
  }

  // R4 无用声明（工作区依赖；vendor 上游已在循环头排除）
  for (const name of [...deps, ...devDeps]) {
    if (!name.startsWith('@agentchat/') && !name.startsWith('ac-')) continue;
    if (!importedAny.has(name) && name !== pkg.name) {
      errors.push(`R4 无用声明：${pkg.name} → ${name}（src/tests/client 均未 import）`);
    }
  }

  // R4 无用声明（npm dependencies 面——2026-11 补扫，实证：settings
  // 声明 pinia 零 import 漏网）。消费证据四白名单见文件头 R4 注记。
  const npmDeps = [...deps].filter((d) => !d.startsWith('@agentchat/') && !d.startsWith('ac-'));
  if (npmDeps.length > 0) {
    // peer 供给面：工作区依赖声明的 peerDependencies = 本包应供给的
    // npm 名（如 ac-client-runtime peer vue——数据面行无 import/.vue 也
    // 须提供，peer 解析不落 hoisting）
    const peerProvisions = new Set();
    for (const w of [...deps, ...devDeps]) {
      const wd = names.has(w) ? workspace.get(w)?.pkg?.peerDependencies : undefined;
      if (wd) for (const p of Object.keys(wd)) peerProvisions.add(p);
    }
    const bareUsed = new Set(); // 源码裸名（值 + 类型 + 动态 import + require）
    let hasProdVue = false;
    for (const file of listFiles(pkgDir)) {
      if (!hasProdVue && file.endsWith('.vue') && !isTestFile(file)) hasProdVue = true;
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (!/^[a-z@]/.test(spec) || spec.startsWith('@/')) continue; // 相对/别名路径除外
        const parts = spec.split('/');
        bareUsed.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
      }
    }
    // vite.config.* 打包面（包根；manualChunks 分组等零源码 import 的真消费）
    let viteCfg = '';
    if (fs.existsSync(pkgDir)) {
      for (const ent of fs.readdirSync(pkgDir)) {
        if (/^vite\.config\./.test(ent)) viteCfg += fs.readFileSync(path.join(pkgDir, ent), 'utf8');
      }
    }
    for (const name of npmDeps) {
      if (bareUsed.has(name)) continue;
      if (name === 'vue' && hasProdVue) continue; // SFC 隐式消费（编译器注入，无 import）
      if (name.startsWith('@iconify-json/')) continue; // unplugin-icons ~icons/<集> 约定消费
      if (viteCfg.includes(`'${name}'`) || viteCfg.includes(`"${name}"`)) continue;
      if (peerProvisions.has(name)) continue; // 工作区依赖的 peer 供给义务
      errors.push(`R4 无用声明（npm dependencies）：${pkg.name} → ${name}（src/tests/client 与打包面均无消费）`);
    }
  }
}

// ============================================================
// R5 包级运行时循环依赖（src/ 全工作区包；src/vendor 上游除外）
// ============================================================
{
  const graph = new Map(); // pkg → Set<运行时依赖包>
  for (const [name, { pkgDir }] of workspace) {
    if (rel(pkgDir).startsWith('src/vendor/')) continue;
    const edges = new Set();
    for (const file of listFiles(pkgDir)) {
      if (isTestFile(file)) continue;
      if (!/\.(ts|tsx|mts)$/.test(file)) continue; // .vue 不进包级环图（前端面；.vue 环由 R7 相位方向覆盖）
      for (const e of runtimeImportEntries(file)) {
        if (e.target !== name) edges.add(e.target);
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

// ============================================================
// 白名单（scripts/dep-cycles.yml）——R6/R7 共用裁决账本，只减不增
// ============================================================

/** 解析 dep-cycles.yml（受限格式：edges: 下的 `- from:/to:/ruling:` 标量条目） */
function loadDepWhitelist() {
  const file = path.join(ROOT, 'scripts', 'dep-cycles.yml');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const edges = [];
  let inEdges = false;
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^edges:\s*$/.test(line)) { inEdges = true; continue; }
    if (!inEdges) continue;
    const head = /^\s*-\s*from:\s*(.+?)\s*$/.exec(line);
    if (head) { cur = { from: head[1], to: '', ruling: '' }; edges.push(cur); continue; }
    const kv = /^\s*(to|ruling):\s*(.*?)\s*$/.exec(line);
    if (kv && cur) cur[kv[1]] = kv[2];
  }
  return edges.filter((e) => e.from && e.to);
}

// ============================================================
// R6 行包图跨域边 + R7 相位守卫（M29 P0-1；R6 2026-11 扩权）
//
// 相位表 = agentchat.client.phase（'base' | 'domain'）。生产文件 =
// client/ + src/（排除 tests）。R7：base→domain 运行时边（.ts/.vue
// 同权重）；R6：domain→domain 跨行运行时边（.ts/.vue 同权重——
// 2026-11 扩权，消 .vue 媒介盲区）。两者均需白名单裁决。
// ============================================================
let whitelistRemaining = 0;
{
  const whitelist = loadDepWhitelist();
  const whitelistKeys = new Set(whitelist.map((e) => `${e.from} → ${e.to}`));

  const phaseOf = new Map(); // name → phase（仅 UI 行包入表）
  for (const [name, { pkgDir, pkg }] of workspace) {
    if (rel(pkgDir).startsWith('src/vendor/')) continue;
    const phase = pkg?.agentchat?.client?.phase;
    if (phase === 'base' || phase === 'domain') phaseOf.set(name, phase);
  }

  /** 违例收集：key "from → to" → 证据（相对路径:行）列表 */
  const collect = (predicate) => {
    const found = new Map();
    for (const [name, { pkgDir }] of workspace) {
      const phase = phaseOf.get(name);
      if (!phase) continue;
      for (const file of listFiles(pkgDir)) {
        if (isTestFile(file)) continue;
        const isTs = /\.(ts|tsx|mts)$/.test(file);
        if (!isTs && !file.endsWith('.vue')) continue;
        for (const e of runtimeImportEntries(file)) {
          const tPhase = phaseOf.get(e.target);
          if (tPhase === undefined || e.target === name) continue;
          if (!predicate(phase, tPhase, isTs)) continue;
          const key = `${name} → ${e.target}`;
          if (!found.has(key)) found.set(key, []);
          found.get(key).push(`${rel(file)}:${e.line}`);
        }
      }
    }
    return found;
  };

  const r7 = collect((from, to) => from === 'base' && to === 'domain'); // 相位违例（T4）
  const r6 = collect((from, to) => from === 'domain' && to === 'domain'); // 跨域边（.ts/.vue 同权重——2026-11 扩权）

  const used = new Set();
  const report = (found, label) => {
    for (const [key, evs] of [...found.entries()].sort()) {
      if (whitelistKeys.has(key)) { used.add(key); continue; }
      errors.push(`${label}：${key}（${evs.join('、')}）——白名单外新增边（scripts/dep-cycles.yml 记裁决或消边）`);
    }
  };
  report(r7, 'R7 相位违例（base→domain）');
  report(r6, 'R6 行包跨域边（domain→domain，.ts/.vue 同权重）');

  // 白名单只减不增：消化后未删条目 = 红（防账本腐化）
  for (const e of whitelist) {
    const key = `${e.from} → ${e.to}`;
    if (!used.has(key)) {
      errors.push(`R7/R6 白名单条目已消化或不存在：${key}（ruling: ${e.ruling}）——白名单只减不增，请删除`);
    }
  }
  whitelistRemaining = used.size;
}

if (errors.length > 0) {
  console.error(`✗ 依赖卫生检查未通过（${errors.length} 项）：\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `✓ 依赖卫生检查通过（R1 未声明 / R2 测试声明 / R3 深路径 / R4 无用声明〔工作区 + npm dependencies〕 / R5 运行时环 / R6 行包跨域边〔.ts/.vue 同权重〕 / R7 相位 base↛domain）` +
    `——白名单余 ${whitelistRemaining} 条（scripts/dep-cycles.yml，只减不增）`,
);

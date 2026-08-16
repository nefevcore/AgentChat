#!/usr/bin/env node
// ============================================================
// gen-deps-graph.mjs —— 生成 AgentChat 插件依赖图（自包含交互 HTML/SVG）
//
// 用法：node scripts/gen-deps-graph.mjs
// 输出：docs/dependency-graph.html（双击浏览器打开，无外部依赖）
//
// 页面内容：
//   图 1 包依赖图：包按依赖层（列）布局，A→B 表示 A 依赖 B（箭头指向被依赖方）
//         · 值边（solid）      src 值导入（注册/装配链）
//         · 类型边（dashed）   src 仅 import type（环的反向边即此类）
//         · 仅测试边（dotted） 只有 tests 引用
//         · 未使用声明（faint）package.json 声明但无 import
//         · boot 为装配聚合根（扇入/扇出过大），图 1 默认排除，单独见图 2
//         · 交互：悬停高亮邻接、点击看详情、边类型开关、搜索、滚轮缩放、拖拽平移
//   图 2 cordis 运行时组合图：cordis.yml 插件行 → ctx 服务 → boot 装配
//
// 数据口径与 docs/dependencies.md 一致，随代码演进可重跑。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const OUT = path.join(root, 'docs', 'dependency-graph.html');

// 图 1 排除项：装配聚合根 boot 扇出到几乎所有包，画进去会遮蔽分层结构；
// 本地 vendor 生态（cordis 系列）也不入图；两者分别在 docs/dependencies.md 与
// docs/plugins/vendor-ecosystem.md 说明。
const EXCLUDE_FROM_PACKAGE_GRAPH = new Set(['@agentchat/boot']);

// ---------------- 1. 枚举包 ----------------
const pkgs = []; // { name, short, domain, dir, desc }
const pkgDir = path.join(root, 'src');
for (const domain of fs.readdirSync(pkgDir)) {
  const domDir = path.join(pkgDir, domain);
  if (!fs.statSync(domDir).isDirectory()) continue;
  if (domain === 'vendor') continue;
  for (const p of fs.readdirSync(domDir)) {
    const pj = path.join(domDir, p, 'package.json');
    if (!fs.existsSync(pj)) continue;
    const j = JSON.parse(fs.readFileSync(pj, 'utf8').replace(/^\uFEFF/, ''));
    if (!j.name || !j.name.startsWith('@agentchat/')) continue;
    if (EXCLUDE_FROM_PACKAGE_GRAPH.has(j.name)) continue;
    pkgs.push({
      name: j.name,
      short: j.name.slice('@agentchat/'.length),
      domain,
      dir: path.join(domDir, p),
      desc: j.description || '',
    });
  }
}
const byName = new Map(pkgs.map((p) => [p.name, p]));

// ---------------- 2. 声明依赖 ----------------
const declared = new Map(); // pkgName -> [depName]
for (const p of pkgs) {
  const j = JSON.parse(fs.readFileSync(path.join(p.dir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  declared.set(
    p.name,
    Object.keys(j.dependencies || {})
      .filter((d) => d.startsWith('@agentchat/') && d !== p.name && byName.has(d))
      .sort(),
  );
}

// ---------------- 3. 边分类（扫描 src/tests 的 import） ----------------
// kind: value（src 值导入）| type（src 仅 import type）| tests（仅测试引用）| unused（声明未用）
// 分类方式：定位每个 `from '@agentchat/x'` 所属的 import/export 语句起点，
// 再看该语句是否为 `import type`/`export type` —— 避免 `[^'"]*?` 跨语句误配。
const kindOf = new Map(); // "from->to" -> kind

const RE_FROM = /from\s+['"](@agentchat\/[a-z0-9-]+)[/'"]/g;
const RE_DYN = /import\(\s*['"](@agentchat\/[a-z0-9-]+)['"]\s*\)/g;

function classifyFile(c) {
  const hits = { value: new Set(), type: new Set() };
  // 去注释（先去掉 // 行注释，再删 /* */ 块注释）：
  // 若先删块注释，行注释里的 `skills/*/SKILL.md` 这类文本会被误判为块注释起点，
  // 把中间的 import 一起吞掉（agent-skill 未使用边误报的根因）。
  const clean = c.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  let m;
  RE_FROM.lastIndex = 0;
  while ((m = RE_FROM.exec(clean))) {
    const i = m.index;
    // 语句起点 = 最近的 import/export 关键字（from 必属于含关键字的语句）
    const kw = Math.max(clean.lastIndexOf('import', i), clean.lastIndexOf('export', i));
    const stmt = clean.slice(Math.max(0, kw), i);
    const isType = /^(?:import|export)\s+type\b/.test(stmt);
    if (isType) hits.type.add(m[1]);
    else hits.value.add(m[1]);
  }
  RE_DYN.lastIndex = 0;
  while ((m = RE_DYN.exec(c))) hits.value.add(m[1]);
  return hits;
}

function scanDir(dir) {
  const hits = { value: new Set(), type: new Set() };
  if (!fs.existsSync(dir)) return hits;
  const files = fs
    .readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  for (const f of files) {
    const r = classifyFile(fs.readFileSync(path.join(dir, f), 'utf8'));
    r.value.forEach((x) => hits.value.add(x));
    r.type.forEach((x) => hits.type.add(x));
  }
  return hits;
}

for (const p of pkgs) {
  const src = scanDir(path.join(p.dir, 'src'));
  const tst = scanDir(path.join(p.dir, 'tests'));
  for (const dep of declared.get(p.name)) {
    const key = `${p.name}->${dep}`;
    if (src.value.has(dep)) kindOf.set(key, 'value');
    else if (src.type.has(dep)) kindOf.set(key, 'type');
    else if (tst.value.has(dep) || tst.type.has(dep)) kindOf.set(key, 'tests');
    else kindOf.set(key, 'unused');
  }
}

// ---------------- 4. 分层（列） ----------------
// 层号 = 依赖深度（0 根 → 12 示例）；与 docs/dependencies.md 保持一致
const LAYERS = {
  types: 0, protocol: 0, util: 0,
  llm: 1,
  'agent-loop': 2,
  'agent-config': 3, hooks: 3,
  agents: 4,
  router: 5, toolkit: 5, edit: 5,
  tools: 6,
  fs: 7, shell: 7, web: 7, dev: 7, 'session-tools': 7, restart: 7, interaction: 7, math: 7,
  'agent-prompt': 8, 'agent-skill': 8, 'agent-session': 8, 'agent-memory': 8, 'agent-mcp': 8, security: 8, 'agent-tools': 8,
  timer: 9, subagent: 9, archive: 9, backup: 9, workspace: 9,
  server: 10,
  plugins: 11, webui: 11,
  hello: 12,
};
// 兜底：未知包按声明依赖最长路径推算层号（环内取已见最大值+1）
for (const p of pkgs) {
  if (p.short in LAYERS) continue;
  const seen = new Set();
  const layerOf = (short) => {
    if (short in LAYERS) return LAYERS[short];
    if (seen.has(short)) return 1;
    seen.add(short);
    const pkg = byName.get('@agentchat/' + short);
    const deps = pkg ? declared.get(pkg.name) || [] : [];
    const l = deps.reduce((mx, d) => Math.max(mx, layerOf(byName.get(d).short) + 1), 0);
    return l;
  };
  LAYERS[p.short] = layerOf(p.short);
}

// 校验：值边不允许"向更深处"（即层号增大方向；同层边合法——环就在同层）
for (const p of pkgs) {
  for (const dep of declared.get(p.name)) {
    const kind = kindOf.get(`${p.name}->${dep}`);
    if (kind === 'value' && LAYERS[byName.get(dep).short] > LAYERS[p.short]) {
      console.warn(`[warn] 值边方向异常: ${p.name} -> ${dep}（层 ${LAYERS[p.short]} -> ${LAYERS[byName.get(dep).short]}）`);
    }
  }
}

// ---------------- 5. 列内排序（barycenter，减少交叉） ----------------
const byLayer = {};
pkgs.forEach((p) => {
  const L = LAYERS[p.short];
  (byLayer[L] = byLayer[L] || []).push(p);
});
Object.keys(byLayer).forEach((L) => byLayer[L].sort((a, b) => (a.short < b.short ? -1 : 1)));

const layersSorted = Object.keys(byLayer)
  .map(Number)
  .sort((a, b) => a - b);

const edges = []; // { from, to, kind }
for (const p of pkgs) {
  for (const dep of declared.get(p.name)) {
    edges.push({ from: p.name, to: dep, kind: kindOf.get(`${p.name}->${dep}`) });
  }
}

for (let iter = 0; iter < 10; iter++) {
  const down = iter % 2 === 0;
  const seq = down ? [...layersSorted] : [...layersSorted].reverse();
  for (const L of seq) {
    const idx = new Map(byLayer[L].map((p, i) => [p.name, i]));
    const pos = new Map();
    for (const p of byLayer[L]) {
      let sum = 0;
      let n = 0;
      const consider = (other, iOther) => {
        if (byLayer[other] && idx.has(other)) {
          sum += iOther;
          n++;
        }
      };
      for (const e of edges) {
        if (e.from === p.name) consider(e.to, idx.get(e.to));
        if (e.to === p.name) consider(e.from, idx.get(e.from));
      }
      pos.set(p.name, n ? sum / n : null);
    }
    byLayer[L].sort((a, b) => {
      const pa = pos.get(a.name);
      const pb = pos.get(b.name);
      if (pa == null && pb == null) return a.short < b.short ? -1 : 1;
      if (pa == null) return -1;
      if (pb == null) return 1;
      return pa - pb || (a.short < b.short ? -1 : 1);
    });
  }
}

// ---------------- 6. 布局常量 ----------------
const COL_GAP = 200;
const ROW_GAP = 56;
const NODE_H = 32;
const MARGIN_X = 46;
const MARGIN_Y = 56;
const MAX_LAYER = Math.max(...layersSorted);

const nodeW = (short) => Math.max(76, short.length * 7.8 + 20);
const nodeX = (L) => MARGIN_X + L * COL_GAP;
const nodeY = (idx, count) => MARGIN_Y + (idx + 0.5 - count / 2) * ROW_GAP;

const W = MARGIN_X * 2 + MAX_LAYER * COL_GAP;
const H = MARGIN_Y * 2 + Math.max(...layersSorted.map((L) => byLayer[L].length)) * ROW_GAP;

const layout = {}; // name -> { x, y, w }
for (const L of layersSorted) {
  const list = byLayer[L];
  list.forEach((p, i) => {
    layout[p.name] = { x: nodeX(L), y: nodeY(i, list.length), w: nodeW(p.short) };
  });
}

// ---------------- 7. 边路径 ----------------
const LAYER_LABEL = {
  0: '0 根', 1: '1 LLM', 2: '2 ReAct', 3: '3 配置/钩子', 4: '4 单 Agent',
  5: '5 路由/工具基础', 6: '6 工具注册', 7: '7 工具领域', 8: '8 扩展域',
  9: '9 服务域', 10: '10 宿主', 11: '11 插件/UI', 12: '12 示例',
};

function edgePath(from, to, ei) {
  const a = layout[from];
  const b = layout[to];
  const sameLayer = LAYERS[byName.get(from).short] === LAYERS[byName.get(to).short];
  const toLeft = a.x > b.x;
  if (sameLayer) {
    // 同列弧线：凸向列间空隙，按端点上下错开
    const sx = toLeft ? a.x - a.w / 2 : a.x + a.w / 2;
    const sy = a.y;
    const ex = toLeft ? b.x + b.w / 2 : b.x - b.w / 2;
    const ey = b.y;
    const bulge = (toLeft ? -1 : 1) * COL_GAP * 0.42;
    const cxm = (sx + ex) / 2 + (toLeft ? -1 : 1) * 30;
    const cym = (sy + ey) / 2 + (ey > sy ? 26 : -26) * ((ei % 2) * 2 - 1);
    return { d: `M ${sx} ${sy} Q ${cxm} ${cym} ${ex} ${ey}`, toLeft };
  }
  // 跨层：从起点的左右侧出，到终点的左右侧入
  const sx = toLeft ? a.x - a.w / 2 : a.x + a.w / 2;
  const sy = a.y;
  const ex = toLeft ? b.x + b.w / 2 : b.x - b.w / 2;
  const ey = b.y;
  const t = Math.min(0.45, Math.abs(LAYERS[byName.get(from).short] - LAYERS[byName.get(to).short]) * 0.1);
  const c1x = sx + (ex - sx) * 0.45;
  const c2x = sx + (ex - sx) * 0.55;
  const c1y = a.y + (b.y - a.y) * t;
  const c2y = a.y + (b.y - a.y) * (1 - t);
  return { d: `M ${sx} ${sy} C ${c1x} ${c1y} ${c2x} ${c2y} ${ex} ${ey}`, toLeft };
}

const edgesSvg = edges.map((e, i) => ({ ...e, ...edgePath(e.from, e.to, i) }));

// ---------------- 8. 颜色 ----------------
const PKG_COLOR = {
  types: '#64748b', protocol: '#64748b', util: '#64748b',
  llm: '#3b82f6', 'agent-loop': '#3b82f6',
  'agent-config': '#0ea5e9', tools: '#d97706', hooks: '#6d28d9',
  agents: '#0d9488', router: '#0d9488',
  toolkit: '#16a34a', edit: '#16a34a',
  fs: '#65a30d', shell: '#65a30d', web: '#65a30d', dev: '#65a30d',
  'session-tools': '#65a30d', restart: '#65a30d', interaction: '#65a30d', math: '#65a30d',
  'agent-prompt': '#9333ea', 'agent-skill': '#c026d3', 'agent-session': '#9333ea',
  'agent-memory': '#9333ea', 'agent-mcp': '#9333ea', security: '#9333ea', 'agent-tools': '#9333ea',
  timer: '#e11d48', subagent: '#e11d48', archive: '#e11d48', backup: '#e11d48', workspace: '#e11d48',
  server: '#ea580c',
  plugins: '#7c3aed', webui: '#7c3aed',
  hello: '#9ca3af',
};
const KIND_ATTR = {
  value: { stroke: '#475569', width: 1.4, dash: '', marker: 'mk-value' },
  type: { stroke: '#94a3b8', width: 1.25, dash: '6 4', marker: 'mk-type' },
  tests: { stroke: '#cbd5e1', width: 1.1, dash: '2 3', marker: 'mk-tests' },
  unused: { stroke: '#e2e8f0', width: 1.1, dash: '3 3', marker: 'mk-unused' },
};
const KIND_LABEL = { value: '值边（src 值导入）', type: '类型边（src 仅 import type）', tests: '仅测试引用', unused: '未使用声明' };

// ---------------- 9. cordis 运行时组合图（手工布局） ----------------
// v0.6.3（2026-08-16）：cordis.yml 39 个活动插件行（另含注释掉的 HMR 行）。
// 图只画【服务契约图】—— cordis.yml 仅声明行列表，行序无激活语义；
// inject 由各插件模块导出，Loader 按服务依赖自动排序激活。
const COMP_NODES = [
  // 左列：插件行（能力提供）
  { id: 'r-ag', label: 'agent-loop/src/plugin', sub: '服务行 · 提供 ReAct 引擎', x: 165, y: 36, cls: 'plugin' },
  { id: 'r-llm', label: 'llm/src/plugin', sub: '服务行 · LLM 适配器工厂', x: 165, y: 106, cls: 'plugin' },
  { id: 'r-llm-ad', label: 'llm 适配器 ×2', sub: 'plugin-deepseek → deepseek\nplugin-openai → openai/default\n（inject: llm，可替换后端）', x: 165, y: 196, cls: 'group' },
  { id: 'r-tools', label: 'tools/src/plugin', sub: '服务行 · 工具注册中心', x: 165, y: 286, cls: 'plugin' },
  { id: 'g-tools', label: '工具领域 ×7', sub: 'fs · shell · web · dev\nsession-tools · restart\ninteraction\n（每域一行 · inject: tools）', x: 165, y: 386, cls: 'group' },
  { id: 'r-hooks', label: 'hooks/src/plugin', sub: '服务行 · 钩子注册中心\n（内联 hooks.log-tool）', x: 165, y: 486, cls: 'plugin' },
  { id: 'g-ext', label: '扩展域 ×7', sub: 'agent-prompt · agent-skill\nagent-session · agent-memory\nagent-mcp · security\nagent-tools（inject: hooks/tools）', x: 165, y: 596, cls: 'group' },
  { id: 'g-reg', label: '工具注册 ×3', sub: 'timer/src/plugin\nsubagent/src/plugin\nmath/src/plugin\n（inject: tools）', x: 165, y: 716, cls: 'group' },
  { id: 'r-http', label: 'server/src/http-plugin', sub: '服务行 · HTTP 路由注册口', x: 165, y: 816, cls: 'plugin' },
  { id: 'r-ph', label: 'plugins/src/plugin', sub: '服务行 · 动态插件装载器', x: 165, y: 886, cls: 'plugin' },
  { id: 'r-hello', label: '@agentchat/hello', sub: '链路验证插件（无依赖）', x: 165, y: 956, cls: 'plugin' },
  // 中列：ctx 服务
  { id: 'e-ag', label: 'ctx.agentLoop', sub: 'AgentLoopService\nrun / createContext / pushSteer', x: 500, y: 36, cls: 'svc' },
  { id: 'e-llm', label: 'ctx.llm', sub: 'LLMService\n（适配器注册表）', x: 500, y: 176, cls: 'svc' },
  { id: 'e-tools', label: 'ctx.tools', sub: 'ToolsService\n（owner 归属 · presets 过滤）', x: 500, y: 340, cls: 'svc' },
  { id: 'e-hooks', label: 'ctx.hooks', sub: 'HooksService\n（7 类钩子 · 顺序表驱动）', x: 500, y: 540, cls: 'svc' },
  { id: 'e-http', label: 'ctx.http', sub: 'HttpRouteRegistry\n（业务路由各行注册）', x: 500, y: 816, cls: 'svc' },
  { id: 'e-ph', label: 'ctx.pluginHost', sub: 'PluginHost\n（动态 import / owner 回收）', x: 500, y: 886, cls: 'svc' },
  // 右列：装配/宿主行
  { id: 'r-boot', label: 'boot/src/plugin', sub: '装配行 · inject: agentLoop, llm,\ntools, hooks → ctx.bootstrap\n（Assembly/Router/Registry/Loader）', x: 880, y: 226, cls: 'boot' },
  { id: 'r-ws', label: 'workspace/src/plugin', sub: 'inject: bootstrap → ctx.workspace\nfiles 指引 / user / admin / loadAgents', x: 880, y: 316, cls: 'plugin' },
  { id: 'r-arc', label: 'archive/src/plugin', sub: 'inject: bootstrap → ctx.archive\n+ services.archiveSession / idleReset', x: 880, y: 406, cls: 'plugin' },
  { id: 'r-timer-svc', label: 'timer/src/service-plugin', sub: 'inject: bootstrap, archive\n→ ctx.timerManager + services.timer', x: 880, y: 496, cls: 'plugin' },
  { id: 'r-sub-svc', label: 'subagent/src/service-plugin', sub: 'inject: bootstrap, agentLoop\n→ ctx.subagent + services.subAgent', x: 880, y: 586, cls: 'plugin' },
  { id: 'r-l4', label: 'server/src/service-plugin', sub: 'inject: bootstrap, workspace, timerManager,\nsubagent, archive, http → ctx.l4\nL4 门面 + /api/agents|history|groups', x: 880, y: 676, cls: 'group' },
  { id: 'r-final', label: 'boot/src/plugin-finalize', sub: 'inject: bootstrap, workspace, archive,\ntimerManager, subagent, l4\n→ webServerHost / pluginManager / flush', x: 880, y: 786, cls: 'boot' },
  { id: 'r-routes', label: 'server/src/http-routes-plugin', sub: 'inject: http, l4\nupload/config/browse/workspace/\nbackup/version/usage/sessions', x: 880, y: 886, cls: 'plugin' },
  { id: 'r-ph-http', label: 'plugins/src/http-plugin', sub: 'inject: pluginManager\n/api/plugins（catalog/library/assembly）', x: 880, y: 976, cls: 'plugin' },
  { id: 'r-diag', label: 'boot/src/plugin-diagnostics', sub: '无 inject · 5s 后检查 7 个必需服务\n缺失即告警（进程不崩）', x: 880, y: 1066, cls: 'plugin' },
  { id: 'r-webui', label: 'webui/src/plugin', sub: 'inject: webServerHost, http\nHTTP + WS + SPA（默认 3830）', x: 880, y: 1156, cls: 'plugin' },
];
const COMP_EDGES = [
  { from: 'r-ag', to: 'e-ag', label: '提供' },
  { from: 'r-llm', to: 'e-llm', label: '提供' },
  { from: 'r-llm-ad', to: 'e-llm', label: '注册适配器' },
  { from: 'r-tools', to: 'e-tools', label: '提供' },
  { from: 'g-tools', to: 'e-tools', label: '每域注册工具' },
  { from: 'r-hooks', to: 'e-hooks', label: '提供' },
  { from: 'g-ext', to: 'e-hooks', label: '注册钩子' },
  { from: 'g-ext', to: 'e-tools', label: 'agent-tools 注册工具' },
  { from: 'g-reg', to: 'e-tools', label: '注册 timer/subagent/math' },
  { from: 'r-http', to: 'e-http', label: '提供' },
  { from: 'r-ph', to: 'e-ph', label: '提供' },
  { from: 'e-ag', to: 'r-boot', label: 'inject' },
  { from: 'e-llm', to: 'r-boot', label: 'inject' },
  { from: 'e-tools', to: 'r-boot', label: 'inject' },
  { from: 'e-hooks', to: 'r-boot', label: 'inject' },
  { from: 'r-boot', to: 'r-ws', label: 'inject bootstrap' },
  { from: 'r-boot', to: 'r-arc', label: 'inject bootstrap' },
  { from: 'r-boot', to: 'r-timer-svc', label: 'inject bootstrap' },
  { from: 'r-boot', to: 'r-sub-svc', label: 'inject bootstrap' },
  { from: 'r-boot', to: 'r-l4', label: 'inject bootstrap' },
  { from: 'r-boot', to: 'r-final', label: 'inject bootstrap' },
  { from: 'e-ag', to: 'r-sub-svc', label: 'inject agentLoop' },
  { from: 'r-ws', to: 'r-l4', label: 'inject workspace' },
  { from: 'r-arc', to: 'r-timer-svc', label: 'inject archive' },
  { from: 'r-arc', to: 'r-l4', label: 'inject archive' },
  { from: 'r-arc', to: 'r-final', label: 'inject archive' },
  { from: 'r-timer-svc', to: 'r-l4', label: 'inject timerManager' },
  { from: 'r-timer-svc', to: 'r-final', label: 'inject timerManager' },
  { from: 'r-sub-svc', to: 'r-l4', label: 'inject subagent' },
  { from: 'r-sub-svc', to: 'r-final', label: 'inject subagent' },
  { from: 'e-http', to: 'r-l4', label: 'inject http' },
  { from: 'r-l4', to: 'r-final', label: 'inject l4' },
  { from: 'r-l4', to: 'r-routes', label: 'inject l4' },
  { from: 'e-http', to: 'r-routes', label: 'inject http' },
  { from: 'e-http', to: 'r-webui', label: 'inject http' },
  { from: 'r-final', to: 'r-webui', label: 'webServerHost' },
  { from: 'r-final', to: 'r-ph-http', label: 'pluginManager' },
];
const COMP_CLS = {
  cfg: { fill: '#f8fafc', stroke: '#64748b' },
  plugin: { fill: '#eff6ff', stroke: '#3b82f6' },
  fn: { fill: '#fff7ed', stroke: '#ea580c' },
  svc: { fill: '#f0fdf4', stroke: '#16a34a' },
  group: { fill: '#faf5ff', stroke: '#9333ea' },
  boot: { fill: '#fef2f2', stroke: '#dc2626' },
};

// 图 2 视口宽度：按节点实际渲染宽度动态计算（防右侧裁切；CJK 按双倍宽估算）
function compNodeWidth(n) {
  const lines = n.sub.split('\n');
  const w = (s) => [...s].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 0x2e80 ? 12.5 : 6.9), 0);
  return Math.max(150, ...lines.map((l) => w(l) + 24), w(n.label) + 24);
}
const COMP_W = Math.ceil(Math.max(...COMP_NODES.map((n) => n.x + compNodeWidth(n) / 2)) + 24);

// ---------------- 10. 渲染 ------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderNode(p) {
  const color = PKG_COLOR[p.short] || '#475569';
  const L = layout[p.name];
  return `<g class="gnode" data-name="${p.name}" data-x="${L.x}" data-y="${L.y}" transform="translate(${L.x - L.w / 2},${L.y - NODE_H / 2})">
    <rect width="${L.w}" height="${NODE_H}" rx="7" fill="#ffffff" stroke="${color}" stroke-width="2"/>
    <text x="${L.w / 2}" y="${NODE_H / 2 + 4}" text-anchor="middle" font-size="12.5" font-family="Consolas, Menlo, monospace" fill="#0f172a">${esc(p.short)}</text>
    <title>${esc(p.name)}\n层 ${LAYERS[p.short]} · ${p.domain}\n${esc(p.desc)}</title>
  </g>`;
}

function renderEdge(e) {
  const k = KIND_ATTR[e.kind];
  return `<g class="edge kind-${e.kind}" data-from="${e.from}" data-to="${e.to}">
    <path d="${e.d}" fill="none" stroke="${k.stroke}" stroke-width="${k.width}" stroke-dasharray="${k.dash}" marker-end="url(#${k.marker})"/>
    <title>${esc(e.from)} → ${esc(e.to)}（${KIND_LABEL[e.kind]}）</title>
  </g>`;
}

function renderLayerLabels() {
  let s = '';
  for (const L of layersSorted) {
    s += `<g class="layer-label"><text x="${nodeX(L)}" y="22" text-anchor="middle" font-size="11" fill="#94a3b8" font-family="Consolas, Menlo, monospace">${LAYER_LABEL[L]}</text><line x1="${nodeX(L)}" y1="30" x2="${nodeX(L)}" y2="${H - 8}" stroke="#f1f5f9" stroke-width="1" stroke-dasharray="2 4"/></g>`;
  }
  return s;
}

const markers = `
  <marker id="mk-value" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L8,4.5 L0,9 z" fill="#475569"/></marker>
  <marker id="mk-type" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L8,4.5 L0,9 z" fill="#94a3b8"/></marker>
  <marker id="mk-tests" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><circle cx="4" cy="4" r="3" fill="#cbd5e1"/></marker>
  <marker id="mk-unused" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><circle cx="4" cy="4" r="3" fill="#e2e8f0"/></marker>`;

function renderCompNode(n) {
  const c = COMP_CLS[n.cls];
  const lines = n.sub.split('\n');
  const h = 34 + lines.length * 15;
  const w = compNodeWidth(n);
  const x = n.x - w / 2;
  const y = n.y - h / 2;
  return `<g class="cnode" data-id="${n.id}" data-name="${n.label}" transform="translate(${x},${y})">
    <rect width="${w}" height="${h}" rx="9" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.8"/>
    <text x="${w / 2}" y="${n.sub.includes('\n') ? 22 : 26}" text-anchor="middle" font-size="12.5" font-family="Consolas, Menlo, monospace" font-weight="600" fill="#0f172a">${esc(n.label)}</text>
    ${lines.map((l, i) => `<text x="${w / 2}" y="${40 + i * 15}" text-anchor="middle" font-size="10" fill="#64748b" font-family="Consolas, Menlo, monospace">${esc(l)}</text>`).join('')}
  </g>`;
}

function renderCompEdge(e, i) {
  const a = COMP_NODES.find((n) => n.id === e.from);
  const b = COMP_NODES.find((n) => n.id === e.to);
  const x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const label = e.label ? `<text x="${mx + 6}" y="${my - 6}" font-size="10" fill="#94a3b8" class="cedge-label">${esc(e.label)}</text>` : '';
  return `<g class="cedge" data-from="${e.from}" data-to="${e.to}">
    <path d="M ${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" fill="none" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#mk-com)"/>
    ${label}
  </g>`;
}

const counts = { value: 0, type: 0, tests: 0, unused: 0 };
edges.forEach((e) => counts[e.kind]++);
const valueBack = edges.filter((e) => e.kind === 'value' && LAYERS[byName.get(e.to).short] > LAYERS[byName.get(e.from).short]);
const valueBackText = valueBack.length
  ? `实线指向右 = 值级反向边（${valueBack.map((e) => e.from.slice('@agentchat/'.length) + '→' + e.to.slice('@agentchat/'.length)).join(', ')}）`
  : '值级无环';

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>AgentChat 插件依赖图</title>
<style>
  :root { --ink:#0f172a; --mut:#64748b; --line:#e2e8f0; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background:#f8fafc; }
  header { background:#0f172a; color:#e2e8f0; padding:14px 24px; display:flex; align-items:baseline; gap:16px; flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; color:#fff; }
  header .sub { font-size:12px; color:#94a3b8; }
  main { padding:18px 24px 60px; max-width: 2400px; margin: 0 auto; }
  .card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin-bottom:22px; box-shadow:0 1px 2px rgba(15,23,42,.05); }
  .card h2 { font-size:14px; margin:0 0 4px; }
  .card .hint { font-size:12px; color:var(--mut); margin-bottom:10px; }
  .controls { display:flex; gap:14px; align-items:center; flex-wrap:wrap; font-size:12.5px; margin-bottom:10px; }
  .controls label { display:flex; align-items:center; gap:5px; cursor:pointer; user-select:none; }
  .dot { display:inline-block; width:16px; height:3px; border-radius:2px; vertical-align:middle; }
  .search { margin-left:auto; }
  .search input { border:1px solid var(--line); border-radius:7px; padding:5px 9px; font-size:12.5px; width:190px; outline:none; }
  .search input:focus { border-color:#94a3b8; }
  .stage { position:relative; overflow:hidden; border:1px solid var(--line); border-radius:10px; background:#ffffff; cursor:grab; }
  .stage:active { cursor:grabbing; }
  svg { display:block; }
  /* 图 2 响应式填充舞台宽度（viewBox 等比缩放；上限 2x 防超大屏失真后居中） */
  #svg2 { width:100%; height:auto; max-width:1316px; margin:0 auto; }
  .gnode { cursor:pointer; }
  .gnode rect { transition: opacity .12s; }
  .gnode.hot rect { stroke-width:3.5; filter: drop-shadow(0 0 5px rgba(239,68,68,.55)); }
  .gnode.dim rect, .gnode.dim text { opacity:.12; }
  .gnode.sel rect { stroke:#ef4444; stroke-width:3.5; }
  .edge { transition: opacity .12s; }
  .edge.dim { opacity:.05; }
  .edge.hot { opacity:1; }
  .edge.hot path { stroke:#ef4444 !important; stroke-width:2.6 !important; }
  .cnode { cursor:pointer; }
  .cnode.hot rect { stroke-width:3; filter: drop-shadow(0 0 4px rgba(239,68,68,.5)); }
  .cnode.dim { opacity:.15; }
  .cedge.dim { opacity:.06; }
  .cedge.hot { opacity:1; }
  .cedge.hot path { stroke:#ef4444 !important; stroke-width:2.4 !important; }
  .tooltip { position:absolute; pointer-events:none; background:#0f172a; color:#e2e8f0; font-size:12px; line-height:1.5;
    padding:8px 11px; border-radius:8px; max-width:320px; opacity:0; transition:opacity .1s; z-index:10; box-shadow:0 4px 14px rgba(15,23,42,.3); }
  .tooltip b { color:#fff; }
  .panel { position:fixed; right:0; top:0; bottom:0; width:300px; background:#fff; border-left:1px solid var(--line);
    transform:translateX(102%); transition:transform .18s ease; z-index:20; overflow-y:auto; padding:16px 18px; box-shadow:-6px 0 24px rgba(15,23,42,.12); }
  .panel.open { transform:none; }
  .panel h3 { margin:2px 0 2px; font-size:15px; }
  .panel .meta { font-size:12px; color:var(--mut); margin-bottom:12px; }
  .panel .close { position:absolute; right:12px; top:12px; border:none; background:#f1f5f9; border-radius:6px; width:26px; height:26px; cursor:pointer; font-size:13px; }
  .panel h4 { font-size:12px; margin:14px 0 6px; color:var(--mut); }
  .panel ul { margin:0; padding-left:2px; list-style:none; }
  .panel li { font-size:12.5px; padding:3px 0; border-bottom:1px dashed #f1f5f9; }
  .panel .kind { font-size:10px; padding:1px 6px; border-radius:99px; margin-left:6px; color:#fff; }
  .legend { display:flex; gap:16px; flex-wrap:wrap; font-size:12px; color:#475569; margin-top:2px; }
  .legend span { display:inline-flex; align-items:center; gap:6px; }
  footer { font-size:11.5px; color:#94a3b8; padding:0 24px 30px; max-width:2400px; margin:0 auto; line-height:1.7; }
</style>
</head>
<body>
<header>
  <h1>AgentChat 插件依赖图</h1>
  <span class="sub">${pkgs.length} 包（不含 boot：装配聚合根，见图 2）· ${edges.length} 条声明边 · 值 ${counts.value} / 类型 ${counts.type} / 仅测试 ${counts.tests} / 未使用 ${counts.unused} · 生成于 ${new Date().toISOString().slice(0, 10)}</span>
</header>
<main>

<div class="card">
  <h2>图 1 · 包依赖图</h2>
  <div class="hint">列 = 依赖层（左根右叶）· <b>A → B 表示 A 依赖 B</b>（箭头指向被依赖方）· 数据源：<code>package.json</code> workspace 依赖 + src/tests import 分类（<b>非 inject</b>；inject/服务契约见图 2）· <b>已隐藏 boot</b>（装配聚合根，见图 2）· 悬停高亮邻接 · 点击看详情 · 滚轮缩放 / 拖拽平移</div>
  <div class="controls">
    <label><input type="checkbox" class="tk" data-kind="value" checked/><span class="dot" style="background:#475569"></span>值边 ${counts.value}</label>
    <label><input type="checkbox" class="tk" data-kind="type" checked/><span class="dot" style="background:#94a3b8"></span>类型边 ${counts.type}</label>
    <label><input type="checkbox" class="tk" data-kind="tests"/><span class="dot" style="background:#cbd5e1"></span>仅测试 ${counts.tests}</label>
    <label><input type="checkbox" class="tk" data-kind="unused"/><span class="dot" style="background:#e2e8f0"></span>未使用声明 ${counts.unused}</label>
    <span class="search"><input id="q" placeholder="搜索包名，如 agent-prompt" /></span>
  </div>
  <div class="stage" id="stage1">
    <svg id="svg1" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <defs>${markers}</defs>
      <g id="world1">
        ${renderLayerLabels()}
        ${edgesSvg.map(renderEdge).join('\n')}
        ${pkgs.map(renderNode).join('\n')}
      </g>
    </svg>
    <div class="tooltip" id="tip1"></div>
  </div>
</div>

<div class="card">
  <h2>图 2 · cordis 运行时组合图</h2>
  <div class="hint">服务契约图（v0.6.3）：cordis.yml 仅声明行列表、行序无激活语义（Loader 按 inject 自动排序）；左列 = 能力插件行，中列 = 它们提供的 ctx 服务，右列 = 装配/宿主插件行及其 inject 依赖（服务依赖即激活顺序）。</div>
  <div class="stage" id="stage2">
    <svg id="svg2" width="${COMP_W}" height="1220" viewBox="0 0 ${COMP_W} 1220">
      <defs><marker id="mk-com" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L8,4.5 L0,9 z" fill="#94a3b8"/></marker></defs>
      <g id="world2">
        ${COMP_EDGES.map(renderCompEdge).join('\n')}
        ${COMP_NODES.map(renderCompNode).join('\n')}
      </g>
    </svg>
    <div class="tooltip" id="tip2"></div>
  </div>
</div>

</main>
<footer>
  来源：<code>scripts/gen-deps-graph.mjs</code>（自动扫描各包 package.json + src/tests import 分类）· 重新生成：<code>node scripts/gen-deps-graph.mjs</code> ·
  口径与 <code>docs/dependencies.md</code> 一致（图 1 不含 boot 与 vendor）· 图例：实线=值边，虚线=类型边（环的反向边），点线=仅测试/未使用；${valueBackText}。
</footer>

<div class="panel" id="panel">
  <button class="close" id="panel-close" title="关闭">✕</button>
  <h3 id="p-name">—</h3>
  <div class="meta" id="p-meta"></div>
  <h4>依赖（声明 → 被依赖方）</h4>
  <ul id="p-out"></ul>
  <h4>被依赖（谁依赖它）</h4>
  <ul id="p-in"></ul>
</div>

<script>
(function () {
  'use strict';
  var DATA = ${JSON.stringify({ pkgs, edges, LAYERS, counts, compNodes: COMP_NODES, compEdges: COMP_EDGES })};

  var KIND_TEXT = { value: '值边', type: '类型边', tests: '仅测试', unused: '未使用' };
  var KIND_COLOR = { value: '#475569', type: '#94a3b8', tests: '#cbd5e1', unused: '#e2e8f0' };

  // ---- 图 1：包依赖图 ----
  var svg1 = document.getElementById('svg1');
  var world1 = document.getElementById('world1');
  var stage1 = document.getElementById('stage1');
  var tip1 = document.getElementById('tip1');

  var adj = {};
  DATA.edges.forEach(function (e) {
    (adj[e.from] = adj[e.from] || []).push(e.to);
    (adj[e.to] = adj[e.to] || []).push(e.from);
  });
  var nodeEls = {};
  var nodes = world1.querySelectorAll('.gnode');
  nodes.forEach(function (el) { nodeEls[el.getAttribute('data-name')] = el; });
  var allEdges = Array.prototype.slice.call(world1.querySelectorAll('.edge'));

  function setHot(name, active) {
    var conn = {};
    if (active && name) {
      conn[name] = 1;
      (adj[name] || []).forEach(function (n) { conn[n] = 1; });
    }
    Object.keys(nodeEls).forEach(function (n) {
      var on = conn[n] === 1;
      nodeEls[n].classList.toggle('hot', active && on);
      nodeEls[n].classList.toggle('dim', active && !on);
    });
    allEdges.forEach(function (el) {
      var f = el.getAttribute('data-from'), t = el.getAttribute('data-to');
      var on = conn[f] === 1 && conn[t] === 1;
      el.classList.toggle('hot', active && on);
      el.classList.toggle('dim', active && !on);
    });
  }

  function showTip(el, text, x, y) {
    tip1.innerHTML = text;
    tip1.style.opacity = '1';
    var sr = stage1.getBoundingClientRect();
    var px = x - sr.left + 14, py = y - sr.top + 14;
    if (px + 340 > sr.width) px = x - sr.left - 330;
    if (py + 160 > sr.height) py = y - sr.top - 130;
    tip1.style.left = px + 'px';
    tip1.style.top = py + 'px';
  }
  function hideTip() { tip1.style.opacity = '0'; }

  function findPkg(name) {
    for (var i = 0; i < DATA.pkgs.length; i++) if (DATA.pkgs[i].name === name) return DATA.pkgs[i];
    return null;
  }

  function openPanel(name) {
    var p = findPkg(name);
    if (!p) return;
    document.getElementById('p-name').textContent = p.short;
    document.getElementById('p-meta').textContent = p.name + ' · 层 ' + DATA.LAYERS[p.short] + ' · ' + p.domain + (p.desc ? ' · ' + p.desc : '');
    var out = document.getElementById('p-out'); out.innerHTML = '';
    DATA.edges.filter(function (e) { return e.from === name; }).forEach(function (e) {
      var li = document.createElement('li');
      li.textContent = e.to.slice(10);
      li.appendChild(kindBadge(e.kind));
      out.appendChild(li);
    });
    var inn = document.getElementById('p-in'); inn.innerHTML = '';
    DATA.edges.filter(function (e) { return e.to === name; }).forEach(function (e) {
      var li = document.createElement('li');
      li.textContent = e.from.slice(10);
      li.appendChild(kindBadge(e.kind));
      inn.appendChild(li);
    });
    document.getElementById('panel').classList.add('open');
  }
  function kindBadge(k) {
    var s = document.createElement('span');
    s.className = 'kind';
    s.style.background = KIND_COLOR[k];
    s.textContent = KIND_TEXT[k];
    return s;
  }
  document.getElementById('panel-close').addEventListener('click', function () {
    document.getElementById('panel').classList.remove('open');
  });

  nodes.forEach(function (el) {
    var name = el.getAttribute('data-name');
    var p = findPkg(name);
    el.addEventListener('mouseenter', function (ev) {
      setHot(name, true);
      showTip(el, '<b>' + p.short + '</b> · 层 ' + DATA.LAYERS[p.short] + '<br/>' + p.name + '<br/>' + (p.desc || ''));
    });
    el.addEventListener('mousemove', function (ev) {
      tip1.style.left = ev.clientX - stage1.getBoundingClientRect().left + 14 + 'px';
      tip1.style.top = ev.clientY - stage1.getBoundingClientRect().top + 14 + 'px';
    });
    el.addEventListener('mouseleave', function () { setHot(name, false); hideTip(); });
    el.addEventListener('click', function (ev) { ev.stopPropagation(); openPanel(name); });
  });
  svg1.addEventListener('mousemove', function (ev) {
    if (ev.target === svg1 || ev.target === world1 || ev.target.tagName === 'line' || ev.target.classList.contains('layer-label')) {
      var hit = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!hit || !hit.closest('.gnode')) { setHot(null, false); hideTip(); }
    }
  });
  svg1.addEventListener('mouseleave', function () { setHot(null, false); hideTip(); });

  // 边类型开关
  document.querySelectorAll('.tk').forEach(function (cb) {
    cb.addEventListener('change', function () {
      var k = cb.getAttribute('data-kind');
      var show = cb.checked;
      allEdges.forEach(function (el) {
        if (el.classList.contains('kind-' + k)) el.style.display = show ? '' : 'none';
      });
    });
  });

  // 搜索
  var q = document.getElementById('q');
  q.addEventListener('input', function () {
    var s = q.value.trim().toLowerCase();
    if (!s) { setHot(null, false); return; }
    var hit = null;
    Object.keys(nodeEls).forEach(function (n) {
      var m = n.toLowerCase().indexOf(s) !== -1 || n.slice(10).toLowerCase().indexOf(s) !== -1;
      if (m) hit = n;
    });
    if (hit) setHot(hit, true);
  });

  // 缩放 / 平移（图 1）
  var view1 = { k: 1, x: 0, y: 0 };
  function apply1() { world1.setAttribute('transform', 'translate(' + view1.x + ',' + view1.y + ') scale(' + view1.k + ')'); }
  stage1.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var r = stage1.getBoundingClientRect();
    var mx = ev.clientX - r.left, my = ev.clientY - r.top;
    var f = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    view1.k = Math.min(4, Math.max(0.2, view1.k * f));
    view1.x = mx - (mx - view1.x) * f;
    view1.y = my - (my - view1.y) * f;
    apply1();
  }, { passive: false });
  var pan1 = null;
  stage1.addEventListener('mousedown', function (ev) {
    if (ev.target === stage1 || ev.target === svg1 || ev.target.id === 'svg1' || ev.target.tagName === 'line') {
      pan1 = { x: ev.clientX, y: ev.clientY, vx: view1.x, vy: view1.y };
      ev.preventDefault();
    }
  });
  window.addEventListener('mousemove', function (ev) {
    if (pan1) {
      view1.x = pan1.vx + (ev.clientX - pan1.x);
      view1.y = pan1.vy + (ev.clientY - pan1.y);
      apply1();
    }
  });
  window.addEventListener('mouseup', function () { pan1 = null; });

  // ---- 图 2：运行时组合图 ----
  var world2 = document.getElementById('world2');
  var tip2 = document.getElementById('tip2');
  var stage2 = document.getElementById('stage2');
  var cadj = {};
  DATA.compEdges.forEach(function (e) {
    (cadj[e.from] = cadj[e.from] || []).push(e.to);
    (cadj[e.to] = cadj[e.to] || []).push(e.from);
  });
  var cNodes = {};
  world2.querySelectorAll('.cnode').forEach(function (el) { cNodes[el.getAttribute('data-id')] = el; });
  var cEdges = Array.prototype.slice.call(world2.querySelectorAll('.cedge'));

  function cHot(id, active) {
    var conn = {};
    if (active && id) {
      conn[id] = 1;
      (cadj[id] || []).forEach(function (n) { conn[n] = 1; });
    }
    Object.keys(cNodes).forEach(function (n) {
      var on = conn[n] === 1;
      cNodes[n].classList.toggle('hot', active && on);
      cNodes[n].classList.toggle('dim', active && !on);
    });
    cEdges.forEach(function (el) {
      var f = el.getAttribute('data-from'), t = el.getAttribute('data-to');
      var on = conn[f] === 1 && conn[t] === 1;
      el.classList.toggle('hot', active && on);
      el.classList.toggle('dim', active && !on);
    });
  }
  world2.querySelectorAll('.cnode').forEach(function (el) {
    var id = el.getAttribute('data-id');
    var name = el.getAttribute('data-name');
    el.addEventListener('mouseenter', function (ev) {
      cHot(id, true);
      tip2.innerHTML = '<b>' + name + '</b>';
      tip2.style.opacity = '1';
      tip2.style.left = ev.clientX - stage2.getBoundingClientRect().left + 14 + 'px';
      tip2.style.top = ev.clientY - stage2.getBoundingClientRect().top + 14 + 'px';
    });
    el.addEventListener('mousemove', function (ev) {
      tip2.style.left = ev.clientX - stage2.getBoundingClientRect().left + 14 + 'px';
      tip2.style.top = ev.clientY - stage2.getBoundingClientRect().top + 14 + 'px';
    });
    el.addEventListener('mouseleave', function () { cHot(id, false); tip2.style.opacity = '0'; });
  });
  world2.addEventListener('mouseleave', function () { cHot(null, false); tip2.style.opacity = '0'; });

  var view2 = { k: 1, x: 0, y: 0 };
  function apply2() { world2.setAttribute('transform', 'translate(' + view2.x + ',' + view2.y + ') scale(' + view2.k + ')'); }
  stage2.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var r = stage2.getBoundingClientRect();
    var mx = ev.clientX - r.left, my = ev.clientY - r.top;
    var f = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    view2.k = Math.min(4, Math.max(0.2, view2.k * f));
    view2.x = mx - (mx - view2.x) * f;
    view2.y = my - (my - view2.y) * f;
    apply2();
  }, { passive: false });
  var pan2 = null;
  stage2.addEventListener('mousedown', function (ev) {
    if (ev.target === stage2 || ev.target.id === 'svg2') {
      pan2 = { x: ev.clientX, y: ev.clientY, vx: view2.x, vy: view2.y };
      ev.preventDefault();
    }
  });
  window.addEventListener('mousemove', function (ev) {
    if (pan2) {
      view2.x = pan2.vx + (ev.clientX - pan2.x);
      view2.y = pan2.vy + (ev.clientY - pan2.y);
      apply2();
    }
  });
  window.addEventListener('mouseup', function () { pan2 = null; });
})();
</script>
</body>
</html>
`;

fs.writeFileSync(OUT, html, 'utf8');
const short = (n) => n.slice('@agentchat/'.length);
console.log(`已生成 ${OUT}`);
console.log(`  图 1 排除：${[...EXCLUDE_FROM_PACKAGE_GRAPH].map(short).join(', ')}（装配聚合根，见图 2）`);
console.log(`  包：${pkgs.length} | 声明边：${edges.length}（值 ${counts.value} / 类型 ${counts.type} / 仅测试 ${counts.tests} / 未使用 ${counts.unused}）`);
const cycles = edges.filter((e) => e.kind === 'type' && LAYERS[byName.get(e.to).short] >= LAYERS[byName.get(e.from).short]);
console.log(`  类型级反向边（环）${cycles.length} 条：${cycles.map((e) => short(e.from) + '→' + short(e.to)).join(', ')}`);
if (valueBack.length) console.log(`  值级反向边（值环，注意！）${valueBack.length} 条：${valueBack.map((e) => short(e.from) + '→' + short(e.to)).join(', ')}`);
const testsOnly = edges.filter((e) => e.kind === 'tests').map((e) => short(e.from) + '→' + short(e.to));
console.log(`  仅测试引用 ${testsOnly.length} 条：${testsOnly.join(', ')}`);
const unused = edges.filter((e) => e.kind === 'unused').map((e) => short(e.from) + '→' + short(e.to));
console.log(`  未使用声明 ${unused.length} 条：${unused.join(', ')}`);

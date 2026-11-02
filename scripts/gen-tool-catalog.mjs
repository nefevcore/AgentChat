// ============================================================
// gen-tool-catalog.mjs —— 工具/事件目录快照生成器（cr-825/826 读面搬迁批三）
//
// 形态：真装配 dump（非源码扫描——sap-adt 等 description 内嵌运行时值，
//   字面量提取拿不到完整定义）。以 row-catalog.json 的行声明为寻址单源，
//   临时数据根 bootShell 点名全部工具行（行集闭包自动补依赖），等注册面
//   稳定后 dump → apps/catalog/tool-catalog.json。数据 = 注册代码的
//   单源派生物（零人工维护）；对账锁 = 同装配对拍测试（catalog↔装配
//   漂移测试同构——漂移即红，提示重跑本脚本）。
//
// 产物三段（cr-826 扩事件目录）：
//   · tools      —— ctx.tools.listWithOwner()（tools/list 静态底座）
//   · events     —— _hooks 注册面投影（events/listeners 快照底座；过滤
//                   internal/*——治理面词汇，与旧主线同口径）
//   · eventDescs —— 各行包顶层 export const extension 的 listeners 声明
//                   （events/descriptions 静态目录——按行 path 动态 import）
// ============================================================
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '..');
const CATALOG = path.join(REPO, 'apps', 'catalog', 'row-catalog.json');
const OUT = path.join(REPO, 'apps', 'catalog', 'tool-catalog.json');

// 数据根隔离红线：生成器进程必须独立临时目录（不触真实数据根）
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-catalog-'));

const { bootShell } = await import('../apps/shell/boot.ts');

const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf-8'));
// 全点名：全部声明了 tools 的行 + mcp（动态注册面，静态目录不含其工具，
// 但装配无副作用）——行集闭包自动补依赖（tools/jobs/conversation 等）
const toolRowIds = catalog.rows
  .filter((r) => r.tree === 'shell' && (r.tools !== undefined || r.id === 'mcp'))
  .map((r) => r.id);
// 平台分支差集：shell-tools 的 bash/pwsh 按 process.platform 二选一注册——
// 本机 dump 只见其一，对账基线剔除；缺席侧从在场侧克隆补条目（同注册
// 代码同定义，仅 name 差）。
const PLATFORM_SWAP = new Set(['bash', 'pwsh']);

const agentId = '__tool_catalog_gen__';
const agentDir = path.join(DATA_ROOT, 'agents', agentId);
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'config.json'), JSON.stringify({
  id: agentId,
  model: 'mock',
  mockProvider: true,
  rows: toolRowIds,
}), 'utf-8');

const boot = await bootShell(
  { dataRoot: DATA_ROOT, agentId, catalogFile: CATALOG, mockProvider: true },
  { emit: () => {} },
);
try {
  const tools = boot.ctx.get('tools');
  // sap-adt apply 尾部异步 init（demo 引擎拉起）晚于行 ACTIVE——轮询有界等待
  const deadline = Date.now() + 30_000;
  const want = new Set();
  for (const r of catalog.rows.filter((x) => x.tree === 'shell' && x.tools !== undefined)) {
    for (const t of r.tools) if (!PLATFORM_SWAP.has(t) || t === (process.platform === 'win32' ? 'pwsh' : 'bash')) want.add(t);
  }
  let entries = [];
  while (Date.now() < deadline) {
    entries = tools.listWithOwner().map((t) => ({
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters ?? {},
      owner: t.owner,
      ...(t.requiredTags ? { requiredTags: t.requiredTags } : {}),
      ...(t.needPermission ? { needPermission: true } : {}),
      ...(t.injection !== undefined && t.injection !== 'capability' ? { injection: t.injection } : {}),
      ...(t.requiresInteraction ? { requiresInteraction: true } : {}),
    }));
    const names = new Set(entries.map((t) => t.name));
    let missing = [];
    for (const w of want) if (!names.has(w)) missing.push(w);
    if (missing.length === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  const missing = entries.length === 0 ? ['(空)'] : [...want].filter((w) => !entries.some((t) => t.name === w));
  if (missing.length > 0) {
    console.error('注册面未覆盖目录声明：' + missing.join(', '));
    process.exit(1);
  }
  // 平台差补条目：缺席侧命令工具从在场侧克隆（同注册代码——shell-tools
  // executor 按平台选名，定义本体同构；owner/description/parameters 一致）
  const present = process.platform === 'win32' ? 'pwsh' : 'bash';
  const absent = process.platform === 'win32' ? 'bash' : 'pwsh';
  const src = entries.find((t) => t.name === present);
  if (src !== undefined && !entries.some((t) => t.name === absent)) {
    entries.push({ ...src, name: absent });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  // ---- 事件目录（cr-826）：监听器注册面 dump ----
  // _hooks 私有读（与 ac-event-policy service 同款立场——vendor 无公开列举
  // API）；过滤 internal/*（框架 seam 不进治理视图）。owner = fiber 名，
  // row = 聚合行名（computeRowAggregates——别名不同才写）。
  const { computeRowAggregates } = await import('ac-event-policy/src/aggregate.ts');
  const alias = computeRowAggregates(boot.ctx);
  const eventsOut = [];
  const hooksTable = boot.ctx.events;
  for (const [name, hooks] of Object.entries(hooksTable._hooks)) {
    if (name.startsWith('internal/')) continue;
    if (!Array.isArray(hooks) || hooks.length === 0) continue;
    const listeners = hooks.map((h) => ({
      owner: h.ctx?.fiber?.name ?? '(anonymous)',
      ...(alias.get(h.ctx?.fiber?.name ?? '') !== undefined && alias.get(h.ctx?.fiber?.name ?? '') !== h.ctx?.fiber?.name
        ? { row: alias.get(h.ctx?.fiber?.name ?? '') }
        : {}),
      prepend: h.prepend === true,
      global: h.global === true,
      ...(typeof h.description === 'string' && h.description !== '' ? { description: h.description } : {}),
    }));
    eventsOut.push({ name, listeners });
  }
  eventsOut.sort((a, b) => (a.name < b.name ? -1 : 1));

  // ---- 事件描述声明（cr-826）：行包顶层 extension.listeners ----
  // 按行 path 动态 import 行包模块读 export const extension（有则收；
  // 未声明的行不产生条目——前端「未声明不渲染」契约）。dynamic 源（插件
  // manifest provides.events）不在静态快照——活态消费面补。
  const descs = [];
  for (const r of catalog.rows) {
    if (r.tree !== 'shell' || r.path === undefined) continue;
    const paths = Array.isArray(r.path) ? r.path : [r.path];
    for (const p of paths) {
      try {
        // Windows 动态 import 绝对路径须 file:// URL（裸路径说明符非法）
        const mod = await import(pathToFileURL(path.join(REPO, p, 'src', 'index.ts')).href);
        const ext = mod.extension;
        if (ext === undefined || !Array.isArray(ext.listeners)) continue;
        for (const l of ext.listeners) {
          if (typeof l.event !== 'string') continue;
          descs.push({
            owner: typeof ext.name === 'string' ? ext.name : r.id,
            event: l.event,
            ...(typeof l.description === 'string' ? { description: l.description } : {}),
            ...(typeof l.role === 'string' ? { role: l.role } : {}),
            ...(typeof l.facet === 'string' ? { facet: l.facet } : {}),
            ...(l.respectsEnabled === true ? { respectsEnabled: true } : {}),
            source: 'builtin',
            ...(ext.automatic === true ? { automatic: true } : {}),
          });
        }
        break; // 一行多包取首个命中声明的包（同行多包 = 同一行的并入件）
      } catch { /* 无声明/导入失败——跳过 */ }
    }
  }
  descs.sort((a, b) => ((a.owner + a.event) < (b.owner + b.event) ? -1 : 1));

  fs.writeFileSync(OUT, JSON.stringify({
    // 快照元信息（诊断面：何时/何源生成）
    generatedAt: new Date().toISOString(),
    source: 'bootShell 真装配 dump（scripts/gen-tool-catalog.mjs）',
    tools: entries,
    events: eventsOut,
    eventDescs: descs,
  }, null, 2) + '\n', 'utf-8');
  console.log('已生成 ' + OUT + '（' + entries.length + ' 工具 / ' + eventsOut.length + ' 事件 / ' + descs.length + ' 声明）');
} finally {
  await boot.close();
  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
}

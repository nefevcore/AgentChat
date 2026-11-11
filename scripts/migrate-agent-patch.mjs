#!/usr/bin/env node
// ============================================================
// scripts/migrate-agent-patch.mjs —— 身份全量迁移（cr-906 / cr-918 /
// cr-1004 批2 v2 档）：任何旧形态 → agent.json（档案 + origin）+
// agent.patch.yml v2 差量（纯 cordis 条目数组 + `# ac-base` 基线戳，
// 取迁移时点存在合成指纹——§七 确定性转换：加法 = T − B、减法 = B − T）。
//
// 输入形态（逐级探测，幂等——已是 v2 = 跳过，--rebase = 只重算基线戳）：
//   v2（agent.patch.yml 顶层数组）→ 跳过
//   旧映射 agent.patch.yml / config.json → 组合读 → 拆写 agent.json + v2
//   settings 拆 <unit>.json（cr-906 既有档不变）；origin 并入 agent.json
//   （preset-origin.json 转 .migrated 可逆）。config.json 原样保留
//   （存量旧读者窗口——读序 v2 赢，残文件无害）。
//
// 可逆（--revert）：config.json 在场 = 回退到旧读窗口（删 agent.json 与
// agent.patch.yml；无 config.json 的 v2-only 身份拒绝回退——无回滚点）。
// 递归面：agents/<id>/ 与 children/<cid>/ 全树。
//
// 用法：node scripts/migrate-agent-patch.mjs <dataRoot> [--rebase] [--revert] [--dry]
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// TS 源直载（Node strip-only——与仓内 boot 链同形态，零构建产物依赖）
import {
  readAgentPatchAt, readAgentPatchV2At, readAgentProfileAt,
  writeAgentProfileAt, writeAgentPatchV2At, writePluginConfigAt,
  rowsToPatchEntries, mergeLevelsIntoEntries, patchToConfig, PATCH_FILE, PROFILE_FILE,
} from '../packages/ac-agents-core/src/index.ts';
import { readCatalog, defaultCatalogFile, assemblyBaseStamp } from '../packages/ac-rowset-core/src/index.ts';
import { slimAssemblyEntries } from '../packages/ac-rowset-core/src/index.ts';


const args = process.argv.slice(2);
const dataRoot = args.find((a) => !a.startsWith('--'));
const rebase = args.includes('--rebase');
const revert = args.includes('--revert');
const dry = args.includes('--dry');
if (dataRoot === undefined) {
  console.error('用法：node scripts/migrate-agent-patch.mjs <dataRoot> [--rebase] [--revert] [--dry]');
  process.exit(2);
}

const MIGRATED = 'preset-origin.json.migrated';
// B−T 转换面：数据根目录（profile/shell.yml 基座 ∨ row-catalog.json）赢，
// 回退仓库投影（迁移时点的存在合成单源）
const shellRows = (() => {
  let rows = readCatalog(defaultCatalogFile(dataRoot)).rows.filter((r) => r.tree === 'shell');
  if (rows.length === 0) {
    rows = readCatalog(fileURLToPath(new URL('../apps/catalog/row-catalog.json', import.meta.url))).rows
      .filter((r) => r.tree === 'shell');
  }
  return rows;
})();
const stamp = assemblyBaseStamp(dataRoot, 'shell');

function agentDirs(root) {
  const agents = path.join(root, 'agents');
  let ids;
  try { ids = fs.readdirSync(agents, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { ids = []; }
  const out = [];
  for (const id of ids) {
    if (id.includes('~')) continue; // 会话流域（对桶/群流）非身份——不物化档案
    out.push({ dir: path.join(agents, id), id, parent: null });
    const children = path.join(agents, id, 'children');
    let cids;
    try { cids = fs.readdirSync(children, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { cids = []; }
    for (const cid of cids) out.push({ dir: path.join(children, cid), id: cid, parent: id });
  }
  return out;
}

/** 组合读旧形态（映射 patch 赢 → config.json；v2/缺席 = null） */
function readLegacyConfig(entry) {
  const patch = readAgentPatchAt(entry.dir);
  if (patch !== null) return { config: patchToConfig(entry.id, patch), doc: patch };
  const configPath = path.join(entry.dir, 'config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (typeof cfg.id !== 'string' || cfg.id !== entry.id) return null;
    if (cfg.rows === undefined && cfg.tools !== undefined) { cfg.rows = cfg.tools; delete cfg.tools; }
    return { config: cfg, doc: {} };
  } catch {
    return { skip: 'config.json 不可读' };
  }
}

function migrateOne(entry) {
  const label = entry.parent !== null ? entry.parent + '/children/' + entry.id : entry.id;
  const v2 = readAgentPatchV2At(entry.dir);
  if (revert) {
    const acts = [];
    if (fs.existsSync(path.join(entry.dir, PROFILE_FILE))) { acts.push('删 ' + PROFILE_FILE); if (!dry) fs.rmSync(path.join(entry.dir, PROFILE_FILE)); }
    if (fs.existsSync(path.join(entry.dir, PATCH_FILE))) { acts.push('删 ' + PATCH_FILE); if (!dry) fs.rmSync(path.join(entry.dir, PATCH_FILE)); }
    return acts.length > 0 ? [label].concat(acts) : null;
  }
  if (v2 !== null) {
    if (!rebase && (v2.base === undefined || v2.base === stamp)) return null; // 幂等
    // rebase 顺带瘦身（cr-1007 §六）：滤除对新基础集的 no-op 加法——语义保持
    const next = rebase ? slimAssemblyEntries(v2.entries, shellRows) : v2.entries;
    if (!dry) writeAgentPatchV2At(entry.dir, next, stamp);
    return [rebase ? 'rebase（重算基线戳 + 瘦身 no-op 加法）' : '补戳', label];
  }
  const legacy = readLegacyConfig(entry);
  if (legacy === null) return null; // 无身份（兜底目录/会话域）
  if (legacy.skip !== undefined) return ['跳过（' + legacy.skip + '）', label];
  const cfg = legacy.config;
  // settings 拆单元文件（cr-906 既有档）
  for (const [unit, value] of Object.entries(cfg.settings ?? {})) {
    if (!dry) writePluginConfigAt(entry.dir, unit, value);
  }
  // origin：旧 patch origin 块 ∨ preset-origin.json → agent.json
  let origin = legacy.doc.origin;
  const originPath = path.join(entry.dir, 'preset-origin.json');
  const migratedPath = path.join(entry.dir, MIGRATED);
  let originAct = '';
  if (origin === undefined && fs.existsSync(originPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(originPath, 'utf-8'));
      if (typeof parsed.template === 'string' && typeof parsed.hash === 'string') origin = parsed;
    } catch { /* 坏 origin = 留旧文件 */ }
  }
  if (fs.existsSync(originPath) && origin !== undefined) {
    originAct = '；origin 并入 agent.json（.migrated 可逆）';
    if (!dry) fs.renameSync(originPath, migratedPath);
  }
  const access = cfg.access ?? (cfg.tier !== undefined ? cfg.tier : undefined);
  const toolMode = cfg.toolMode ?? (cfg['tool-mode'] !== undefined ? cfg['tool-mode'] : undefined);
  if (!dry) {
    writeAgentProfileAt(entry.dir, {
      ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      ...(cfg.provider !== undefined ? { provider: cfg.provider } : {}),
      ...(cfg.llmParams !== undefined ? { 'llm-params': cfg.llmParams } : {}),
      ...(cfg.maxSteps !== undefined ? { 'max-steps': cfg.maxSteps } : {}),
      ...(access !== undefined && access !== 'base-access' ? { tier: access } : {}),
      ...(toolMode !== undefined && toolMode !== 'tc-base' ? { 'tool-mode': toolMode } : {}),
      ...(cfg.name !== undefined ? { name: cfg.name } : {}),
      ...(cfg.description !== undefined ? { description: cfg.description } : {}),
      ...(cfg.virtual === true ? { virtual: true } : {}),
      ...(origin !== undefined ? { origin } : {}),
    });
    writeAgentPatchV2At(entry.dir, mergeLevelsIntoEntries(rowsToPatchEntries(cfg.rows, shellRows), cfg.levels), stamp);
  }
  return ['迁移 v2（agent.json + 差量 + 基线戳 ' + stamp + '）', label + originAct];
}

let n = 0;
for (const entry of agentDirs(dataRoot)) {
  const acts = migrateOne(entry);
  if (acts !== null) { n++; console.log('  ' + acts.join(' — ')); }
}
console.log(((revert && '回退') || (rebase && 'rebase') || '迁移') + '完成：' + n + ' 个身份' + (dry ? '（dry-run 未落盘）' : ''));

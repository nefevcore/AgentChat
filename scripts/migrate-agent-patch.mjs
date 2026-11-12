#!/usr/bin/env node
// ============================================================
// scripts/migrate-agent-patch.mjs —— 身份全量迁移（cr-906 / cr-918 /
// cr-1004 批2 / cr-1022 批2 v3 档）：任何旧形态 → agent.json（档案 +
// origin）+ agent.patch.yml v3 菜单片段（行定义 + src-fingerprint +
// `# ac-base` 基线戳）。
//
// 输入形态（逐级探测，幂等——已是 v3 = 跳过，--rebase = 只重算基线戳）：
//   v3（ac-menu 标记）→ 跳过
//   v2（顶层数组差量）/ 旧映射 agent.patch.yml / config.json → 组合读 →
//   菜单片段（v2 经 legacyToMenuDefs 桥；旧形态经正清单定义拷贝）
//   settings 拆 <unit>.json（cr-906 既有档不变）；origin 并入 agent.json
//   （preset-origin.json 转 .migrated 可逆）。config.json 原样保留
//   （存量旧读者窗口——读序 v3/v2 赢，残文件无害）。
//
// 可逆（--revert）：config.json 在场 = 回退到旧读窗口（删 agent.json 与
// agent.patch.yml；无 config.json 的 v3-only 身份拒绝回退——无回滚点）。
// 递归面：agents/<id>/ 与 children/<cid>/ 全树。
//
// 用法：node scripts/migrate-agent-patch.mjs <dataRoot> [--rebase] [--revert] [--dry]
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// TS 源直载（Node strip-only——与仓内 boot 链同形态，零构建产物依赖）
import yaml from 'js-yaml';
import {
  readAgentPatchAt, readAgentPatchV3At, readAgentProfileAt,
  writeAgentProfileAt, writeAgentPatchV3At, writePluginConfigAt,
  mergeLevelsIntoEntries, patchToConfig, PATCH_FILE, PROFILE_FILE,
} from '../packages/ac-agents-core/src/index.ts';
import {
  readCatalog, defaultCatalogFile, assemblyBaseStamp,
  menuDefinitionFingerprint, mergeMenu,
} from '../packages/ac-rowset-core/src/index.ts';
// —— 旧差量语义换算（cr-1022 批3 随读侧桥退役内聚于迁移工具——批2 起桥
// 从在役代码删除，v2 → v3 的确定性转换只在本脚本存在） ——

/** v2 差量语义下的恒并席位（旧 SEAT_ROW_IDS——B−T 停用面护栏词） */
const LEGACY_SEAT_ROW_IDS = [
  'conversation', 'persona', 'conduct', 'llm-pool', 'auto-title', 'host-face-client',
];
/** v2 差量语义下的捆绑行边界（旧 bundle 词行集——不在旧基础集） */
const LEGACY_BUNDLE_ROW_IDS = [
  'fs-tools', 'fs-search', 'str-replace-editor', 'shell-tools',
  'harness-tools', 'sap-adt', 'bench', 'plugin-dev', 'restart',
];

/** v2 差量条目（agent.patch.yml 旧数组形态——工具面只读 id/disabled/config；
 * v3（ac-menu 标记）与映射形态 = null） */
function readAgentPatchV2(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'agent.patch.yml'), 'utf-8');
  } catch {
    return null;
  }
  if (/^#s*ac-menu:s*1s*$/m.test(text)) return null;
  const data = yaml.load(text);
  if (!Array.isArray(data)) return null;
  return data.filter((e) => e !== null && typeof e === 'object' && typeof e.id === 'string');
}

/** 存量差量 → 菜单片段定义（批2 boot 桥 legacyToMenuDefs 的脚本内移植，
 * 语义逐位同构：全集 − 捆绑行为基础集 ∪ 加法 → 闭包 → − 停用〔席位
 * 拒绝〕；config.rows 旧形态 = T 白名单 B−T〔对席位∪点名∪闭包目标算〕） */
function legacyToMenuDefs(skeleton, capability, installed, input) {
  const warnings = [];
  const notices = [];
  const byId = new Map();
  for (const row of [...skeleton, ...capability, ...installed]) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  const rowConfigOf = new Map();
  const disabled = new Set();
  const adds = new Set();
  if (input.entries === undefined && input.rows !== undefined) {
    const tokens = Array.isArray(input.rows) ? input.rows : input.rows.include;
    const excludes = Array.isArray(input.rows) ? [] : input.rows.exclude ?? [];
    for (const x of excludes) disabled.add(x);
    if (tokens !== undefined) {
      const target = new Set(LEGACY_SEAT_ROW_IDS.filter((id) => byId.has(id)));
      const queue = [];
      for (const token of tokens) {
        if (!byId.has(token)) {
          warnings.push('条目未命中目录：' + token);
          continue;
        }
        if (!target.has(token)) {
          target.add(token);
          queue.push(token);
        }
      }
      while (queue.length > 0) {
        for (const req of byId.get(queue.pop())?.requires ?? []) {
          if (byId.has(req) && !target.has(req)) {
            target.add(req);
            queue.push(req);
          }
        }
      }
      for (const id of target) adds.add(id);
      for (const id of byId.keys()) {
        if (!target.has(id)) disabled.add(id);
      }
    }
  } else {
    for (const entry of input.entries ?? []) {
      if (entry.disabled === true) {
        if (!byId.has(entry.id)) {
          notices.push('disable 点名不在基座菜单（跳过）：' + entry.id);
          continue;
        }
        if (LEGACY_SEAT_ROW_IDS.includes(entry.id)) {
          notices.push(entry.id + '：恒并基座席位不可停用（拒绝生效）');
          continue;
        }
        disabled.add(entry.id);
        continue;
      }
      if (!byId.has(entry.id)) {
        warnings.push('agent.patch.yml 条目未命中目录：' + entry.id);
        continue;
      }
      adds.add(entry.id);
      if (entry.config !== null && typeof entry.config === 'object') {
        rowConfigOf.set(entry.id, { ...(rowConfigOf.get(entry.id) ?? {}), ...entry.config });
      }
    }
  }
  const picked = new Set([...byId.keys()].filter((id) => !LEGACY_BUNDLE_ROW_IDS.includes(id)));
  for (const id of adds) picked.add(id);
  const queue = [...picked];
  while (queue.length > 0) {
    for (const req of byId.get(queue.pop())?.requires ?? []) {
      if (byId.has(req) && !picked.has(req)) {
        picked.add(req);
        queue.push(req);
      }
    }
  }
  for (const id of disabled) picked.delete(id);
  const outZone = new Map();
  for (const row of [...capability, ...installed]) outZone.set(row.id, row);
  const defs = [];
  const rowConfigs = {};
  for (const row of outZone.values()) {
    if (!picked.has(row.id)) continue;
    defs.push({
      id: row.id,
      ...(row.name !== undefined ? { name: row.name } : {}),
      ...(row.requires !== undefined ? { requires: row.requires } : {}),
    });
    const cfg = rowConfigOf.get(row.id);
    if (cfg !== undefined) rowConfigs[row.id] = cfg;
  }
  defs.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { defs, rowConfigs, warnings, notices };
}

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
// 定义拷贝源：数据根目录（profile/shell.yml 基座投影 ∨ row-catalog.json）赢，
// 回退仓库投影（迁移时点的出厂目录单源）
const shellRows = (() => {
  let rows = readCatalog(defaultCatalogFile(dataRoot)).rows.filter((r) => r.tree === 'shell');
  if (rows.length === 0) {
    rows = readCatalog(fileURLToPath(new URL('../apps/catalog/row-catalog.json', import.meta.url))).rows
      .filter((r) => r.tree === 'shell');
  }
  return rows;
})();
const skeleton = shellRows.filter((r) => r.zone === 'skeleton').map((r) => ({
  id: r.id, ...(r.path !== undefined ? { name: 'link:' + r.path } : {}), ...(r.requires !== undefined ? { requires: r.requires } : {}),
}));
const capability = shellRows.filter((r) => r.zone !== 'skeleton').map((r) => ({
  id: r.id, ...(r.path !== undefined ? { name: 'link:' + r.path } : {}), ...(r.requires !== undefined ? { requires: r.requires } : {}),
}));
// 出厂定义指纹单源（v3 src-fingerprint —— §2.3 定义副本是缓存）
const capFingerprints = Object.fromEntries(capability.map((d) => [d.id, menuDefinitionFingerprint(d)]));
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

/** 组合读旧形态（映射 patch 赢 → config.json；v2/v3/缺席 = null） */
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
  if (revert) {
    const acts = [];
    if (fs.existsSync(path.join(entry.dir, PROFILE_FILE))) { acts.push('删 ' + PROFILE_FILE); if (!dry) fs.rmSync(path.join(entry.dir, PROFILE_FILE)); }
    if (fs.existsSync(path.join(entry.dir, PATCH_FILE))) { acts.push('删 ' + PATCH_FILE); if (!dry) fs.rmSync(path.join(entry.dir, PATCH_FILE)); }
    return acts.length > 0 ? [label].concat(acts) : null;
  }
  const v3 = readAgentPatchV3At(entry.dir);
  if (v3 !== null) {
    if (!rebase && (v3.base === undefined || v3.base === stamp)) return null; // 幂等
    if (!dry) writeAgentPatchV3At(entry.dir, v3.defs, v3.fingerprints, stamp);
    return ['rebase（重算基线戳）', label];
  }
  const v2 = readAgentPatchV2(entry.dir);
  if (v2 !== null) {
    // v2 差量 → 菜单片段（脚本内桥：B−T 语义逐位等价换算）+ 对账自检
    //（迁移前后行集逐位比对——漂移即红，不落盘）
    const bridged = legacyToMenuDefs(skeleton, capability, [], { entries: v2 });
    const defs = bridged.defs.map((d) => {
      const cfg = bridged.rowConfigs[d.id];
      return cfg !== undefined ? { ...d, config: cfg } : d;
    });
    const fingerprints = Object.fromEntries(defs.map((d) => [d.id, capFingerprints[d.id]]).filter(([, v]) => v !== undefined));
    const expected = [...new Set([...skeleton.map((d) => d.id), ...defs.map((d) => d.id)])].sort();
    if (!dry) {
      writeAgentPatchV3At(entry.dir, defs, fingerprints, stamp);
      const written = readAgentPatchV3At(entry.dir);
      const actual = written !== null
        ? mergeMenu({ skeleton, patch: written.defs }).entries.map((d) => d.id).sort()
        : null;
      if (actual === null || JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error('对账失败（迁移前后行集不等价）：' + label);
      }
    }
    return ['迁移 v3（桥换算 + 对账通过 + 基线戳 ' + stamp + '）', label];
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
    // 旧形态 rows 语义经桥换算（缺省 = 旧基础集——逐位等价），levels 归
    // config；对账自检同 v2 分支
    const bridged = legacyToMenuDefs(skeleton, capability, [], { rows: cfg.rows });
    const defs = bridged.defs.map((d) => {
      const cfgOf = bridged.rowConfigs[d.id];
      return cfgOf !== undefined ? { ...d, config: cfgOf } : d;
    });
    mergeLevelsIntoEntries(defs, cfg.levels);
    const fingerprints = Object.fromEntries(defs.map((d) => [d.id, capFingerprints[d.id]]).filter(([, v]) => v !== undefined));
    const expected = [...new Set([...skeleton.map((d) => d.id), ...defs.map((d) => d.id)])].sort();
    writeAgentPatchV3At(entry.dir, defs, fingerprints, stamp);
    const written = readAgentPatchV3At(entry.dir);
    const actual = written !== null
      ? mergeMenu({ skeleton, patch: written.defs }).entries.map((d) => d.id).sort()
      : null;
    if (actual === null || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('对账失败（迁移前后行集不等价）：' + label);
    }
  }
  return ['迁移 v3（agent.json + 菜单片段 + 对账通过 + 基线戳 ' + stamp + '）', label + originAct];
}

let n = 0;
for (const entry of agentDirs(dataRoot)) {
  const acts = migrateOne(entry);
  if (acts !== null) { n++; console.log('  ' + acts.join(' — ')); }
}
console.log(((revert && '回退') || (rebase && 'rebase') || '迁移') + '完成：' + n + ' 个身份' + (dry ? '（dry-run 未落盘）' : ''));

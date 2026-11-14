#!/usr/bin/env node
// ============================================================
// scripts/migrate-agent-patch.mjs —— 身份迁移工具（cr-906 / cr-918 /
// cr-1004 批2 / cr-1022 批2 / cr-1036 批2 链驱动换轨）
//
// 换轨逻辑零代码：探测/换算/对账全部住 PATCH_CHAIN 注册边
//（ac-agents-core/patch-chain.ts）+ migrateAgentPatchAt 链驱动执行器；
// 本工具只做目录遍历 + 报告。一次性迁移脚本禁令（cr-1036）：新增换档
// = 注册新边，本文件不再长换算代码。
//
// 输入形态（链探测）：v2（ac-menu 标记）→ 跳过；v1（数组差量）/
// v0（旧映射 agent.patch.yml ∨ config.json）→ 链驱动逐边迁移到 v2。
// config.json 收编转 .migrated（批3——旧读者窗口退役）。
// --revert = 回退（删 agent.json 与 agent.patch.yml——config.json.migrated
// 不自动恢复，见报告）。（cr-1067：--rebase 已随基线戳退役删除。）
//
// 用法：node scripts/migrate-agent-patch.mjs <dataRoot> [--revert] [--dry]
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// TS 源直载（Node strip-only——与仓内 boot 链同形态，零构建产物依赖）
import {
  PATCH_FILE, PROFILE_FILE,
  migrateAgentPatchAt, detectPatchForm,
} from '../packages/ac-agents-core/src/index.ts';
import { readCatalog, defaultCatalogFile } from '../packages/ac-rowset-core/src/index.ts';

const args = process.argv.slice(2);
const dataRoot = args.find((a) => !a.startsWith('--'));
const revert = args.includes('--revert');
const dry = args.includes('--dry');
if (dataRoot === undefined) {
  console.error('用法：node scripts/migrate-agent-patch.mjs <dataRoot> [--revert] [--dry]');
  process.exit(2);
}

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

let n = 0;
for (const entry of agentDirs(dataRoot)) {
  const label = entry.parent !== null ? entry.parent + '/children/' + entry.id : entry.id;
  const ctx = { dir: entry.dir, skeleton, capability };
  if (revert) {
    const acts = [];
    if (fs.existsSync(path.join(entry.dir, PROFILE_FILE))) { acts.push('删 ' + PROFILE_FILE); if (!dry) fs.rmSync(path.join(entry.dir, PROFILE_FILE)); }
    if (fs.existsSync(path.join(entry.dir, PATCH_FILE))) { acts.push('删 ' + PATCH_FILE); if (!dry) fs.rmSync(path.join(entry.dir, PATCH_FILE)); }
    const migrated = path.join(entry.dir, 'config.json.migrated');
    if (fs.existsSync(migrated)) acts.push('注意：config.json.migrated 在场（回退不自动恢复——需手动改名回 config.json）');
    if (acts.length > 0) { n++; console.log('  ' + [label].concat(acts).join(' — ')); }
    continue;
  }
  // 链驱动迁移（v0/v1 → v2 + 对账自检）
  if (dry) {
    // dry-run：只探测不落盘（报告形态版本）
    const detected = detectPatchForm(ctx);
    if (detected !== null && detected.version < 2) {
      n++;
      console.log('  [dry] v' + detected.version + ' → v2（未落盘）— ' + label);
    }
    continue;
  }
  const outcome = migrateAgentPatchAt(ctx);
  if (outcome === null) continue; // 已最新/无身份
  n++;
  const edgeTrail = outcome.reports.map((r) => 'v' + r.from + '→v' + r.to).join(' ');
  const profileNote = outcome.wroteProfile ? ' + agent.json 档案 + 单元文件' : '';
  console.log('  迁移 v' + outcome.fromVersion + ' → v2（' + edgeTrail + profileNote + ' + 对账通过）— ' + label);
  for (const w of outcome.warnings) console.log('    ⚠ ' + w);
  for (const note of outcome.notices) console.log('    · ' + note);
}
console.log(((revert && '回退') || '迁移') + '完成：' + n + ' 个身份' + (dry ? '（dry-run 未落盘）' : ''));

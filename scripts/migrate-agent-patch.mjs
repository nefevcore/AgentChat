#!/usr/bin/env node
// ============================================================
// scripts/migrate-agent-patch.mjs —— 身份全量迁移（cr-906 / cr-901
// v2.1 批4 切片三：config.json（rows+tags+settings+system 三合体）→
// agent.patch.yml（装配+档位+origin）+ <unit>.json 插件配置。
//
// 语义：writeAgentConfig 双落承担迁移本体（patch 主写 + config.json
// 镜像 + settings 拆单元文件——旧读者不断链）；preset-origin.json 并入
// patch origin 块后转 .migrated（可逆）。system 不迁（退役面——平台
// 行分权组装；config.json 镜像仍含，旧读者窗口）。
//
// 可逆（--revert）：恢复 .migrated → preset-origin.json、删 agent.patch.yml、
// 删拆分出的 <unit>.json——回迁前形态逐字节还原（回滚点判据）。
// 递归面：agents/<id>/ 与 children/<cid>/ 全树。
//
// 用法：node scripts/migrate-agent-patch.mjs <dataRoot> [--revert] [--dry]
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

// TS 源直载（Node strip-only——与仓内 boot 链同形态，零构建产物依赖）
import { configToPatch, readAgentPatchAt, writeAgentPatchAt, writePluginConfigAt, PATCH_FILE } from '../packages/ac-agents-core/src/index.ts';


const args = process.argv.slice(2);
const dataRoot = args.find((a) => !a.startsWith('--'));
const revert = args.includes('--revert');
const dry = args.includes('--dry');
if (dataRoot === undefined) {
  console.error('用法：node scripts/migrate-agent-patch.mjs <dataRoot> [--revert] [--dry]');
  process.exit(2);
}

const MIGRATED = 'preset-origin.json.migrated';

function agentDirs(root) {
  const agents = path.join(root, 'agents');
  let ids;
  try { ids = fs.readdirSync(agents, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { ids = []; }
  const out = [];
  for (const id of ids) {
    out.push({ dir: path.join(agents, id), id, parent: null });
    const children = path.join(agents, id, 'children');
    let cids;
    try { cids = fs.readdirSync(children, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { cids = []; }
    for (const cid of cids) out.push({ dir: path.join(children, cid), id: cid, parent: id });
  }
  return out;
}

function migrateOne(entry) {
  const patchPath = path.join(entry.dir, PATCH_FILE);
  const configPath = path.join(entry.dir, 'config.json');
  const originPath = path.join(entry.dir, 'preset-origin.json');
  const migratedPath = path.join(entry.dir, MIGRATED);
  const label = entry.parent !== null ? entry.parent + '/children/' + entry.id : entry.id;
  if (revert) {
    const acts = [];
    if (fs.existsSync(patchPath)) { acts.push('删 ' + PATCH_FILE); if (!dry) fs.rmSync(patchPath); }
    if (fs.existsSync(migratedPath)) { acts.push('恢复 preset-origin.json'); if (!dry) fs.renameSync(migratedPath, originPath); }
    if (fs.existsSync(configPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        for (const unit of Object.keys(cfg.settings ?? {})) {
          const f = path.join(entry.dir, unit + '.json');
          if (fs.existsSync(f)) { acts.push('删 ' + unit + '.json'); if (!dry) fs.rmSync(f); }
        }
      } catch { /* 镜像损坏 = 留文件（无害：旧读路径不扫单元文件） */ }
    }
    return acts.length > 0 ? [label].concat(acts) : null;
  }
  if (!fs.existsSync(configPath)) return null; // 无身份（兜底目录/会话域）
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { return ['跳过（config 不可读）', label]; }
  if (typeof cfg.id !== 'string' || cfg.id !== entry.id) return ['跳过（id 不符）', label];
  const before = fs.existsSync(patchPath);
  const prev = before ? readAgentPatchAt(entry.dir) : null;
  const doc = configToPatch({ ...cfg, rows: cfg.rows ?? cfg.tools, tags: cfg.tags });
  const acts = [before ? '重写（幂等）' : '迁移', label];
  if (!dry) {
    // settings 拆单元文件（config.json 镜像原样保留——旧读者窗口）
    for (const [unit, value] of Object.entries(cfg.settings ?? {})) {
      writePluginConfigAt(entry.dir, unit, value);
    }
    delete doc.settings;
    writeAgentPatchAt(entry.dir, { ...doc, ...(prev?.origin !== undefined ? { origin: prev.origin } : {}) });
  }
  if (fs.existsSync(originPath)) {
    try {
      const origin = JSON.parse(fs.readFileSync(originPath, 'utf-8'));
      if (typeof origin.template === 'string' && typeof origin.hash === 'string') {
        if (!dry) {
          const patch = readAgentPatchAt(entry.dir);
          writeAgentPatchAt(entry.dir, { ...patch, origin });
          fs.renameSync(originPath, migratedPath);
        }
        acts.push('origin 并入 patch（.migrated 可逆）');
      }
    } catch { /* 坏 origin = 留旧文件（读路径 fail-soft） */ }
  }
  return acts;
}

function dataRootFor(entry) {
  return entry.parent !== null ? path.dirname(path.dirname(entry.dir)) + '/..' : dataRoot;
}

let n = 0;
for (const entry of agentDirs(dataRoot)) {
  const acts = migrateOne(entry);
  if (acts !== null) { n++; console.log('  ' + acts.join(' — ')); }
}
console.log((revert ? '回迁' : '迁移') + '完成：' + n + ' 个身份' + (dry ? '（dry-run 未落盘）' : ''));

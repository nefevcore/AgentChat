#!/usr/bin/env node
// cr-1083（access-retirement 批A #2）：Agent 配置 access/tier 字段退役迁移。
// 语义迁移前提已满足：4 个 full Agent（abap-dev/admin/news/tester）与 8 个
// sandbox Agent 的 permission-gate.json 均已在位（onAsk=allow——cr-1079 期间
// 铺设；sandbox 与不配置等价，无需迁移语义）。本脚本只清字段：
//   · access === 'full-access' → 删字段（语义已在 permission-gate onAsk=allow）
//   · access === 'sandbox-access' / 旧 tier 字段 → 删字段（等价无配置）
// 幂等：无字段 Agent 零改动。用法：node scripts/migrate-agent-access-retirement.mjs <dataRoot>

import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.argv[2];
if (!root) { console.error('用法：node scripts/migrate-agent-access-retirement.mjs <dataRoot>'); process.exit(1); }
const agentsDir = path.join(root, 'agents');
if (!fs.existsSync(agentsDir)) { console.error('agents 目录不存在: ' + agentsDir); process.exit(1); }

let touched = 0;
for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(agentsDir, entry.name, 'agent.json');
  if (!fs.existsSync(file)) continue;
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const wasFull = raw.access === 'full-access';
  const before = JSON.stringify({ access: raw.access, tier: raw.tier });
  let dirty = false;
  if ('access' in raw) { delete raw.access; dirty = true; }
  if ('tier' in raw) { delete raw.tier; dirty = true; }
  if (!dirty) continue;
  if (wasFull) {
    const gateFile = path.join(agentsDir, entry.name, 'permission-gate.json');
    if (!fs.existsSync(gateFile)) {
      // 防御：full Agent 无 gate 文件 = 语义迁移未就位——fail-loud 不静默降权
      console.error('FAIL: ' + entry.name + ' 是 full-access 但无 permission-gate.json——先补 onAsk=allow 再迁移');
      process.exit(1);
    }
  }
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
  touched += 1;
  console.log('cleared ' + entry.name + ' ' + before);
}
console.log('迁移完成：' + touched + ' 个 Agent 清理 access/tier 字段（幂等——重跑零改动）');
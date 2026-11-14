#!/usr/bin/env node
// cr-1083 合流清理（conv-scope 批3 #4 + access 批C #3）：一次性存量清理。
//   ① 无人桶 conv-settings 文件删除（humanPresentOf 单源判定：self /
//     agent~agent / g-<gid>~member——内容全是残值，effective 已挡，物删收口）；
//   ② 有人桶 access/elevation 存量键退役：删除 + elevation=full → approval=allow
//     迁移（「通过即 full」行为连续——批A 后等价）；全空文件删除。
// 幂等：重跑零改动。用法：node scripts/conv-scope-access-retirement-cleanup.mjs <dataRoot>

import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.argv[2];
if (!root) { console.error('用法：node scripts/conv-scope-access-retirement-cleanup.mjs <dataRoot>'); process.exit(1); }

/** humanPresentOf 同源判定（ac-agents 词法——脚本自持防依赖） */
function humanPresentOf(conversationId) {
  if (!conversationId) return false;
  const parts = conversationId.split('~');
  if (parts.length === 1) return true; // singles sid
  return parts.length === 2 && (parts[0] === 'user' || parts[1] === 'user');
}

const dir = path.join(root, 'meta', 'conv-settings');
const legacyDir = path.join(root, 'conv-settings');
if (!fs.existsSync(dir)) { console.log('meta/conv-settings 不存在——零清理'); process.exit(0); }

let noBucketDeleted = 0;
let accessRetired = 0;
let approvalMigrated = 0;
let emptiedDeleted = 0;

for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
  const id = entry.name.slice(0, -5);
  const file = path.join(dir, entry.name);
  if (!humanPresentOf(id)) {
    // ① 无人桶：整文件删除（残值无迁移价值）
    fs.rmSync(file, { force: true });
    fs.rmSync(path.join(legacyDir, entry.name), { force: true });
    noBucketDeleted += 1;
    console.log('no-bucket deleted: ' + id);
    continue;
  }
  // ② 有人桶：access/elevation 键退役
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { continue; }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
  const wasFull = raw.elevation === 'full-access' || raw.access === 'full-access';
  let dirty = false;
  if ('access' in raw) { delete raw.access; dirty = true; }
  if ('elevation' in raw) { delete raw.elevation; dirty = true; }
  if (!dirty) continue;
  accessRetired += 1;
  if (wasFull && raw.approval === undefined) {
    raw.approval = 'allow'; // 行为连续迁移：elevation=full ≡ approval=allow（通过即 full）
    approvalMigrated += 1;
  }
  if (Object.keys(raw).length === 0) {
    fs.rmSync(file, { force: true });
    emptiedDeleted += 1;
    console.log('emptied deleted: ' + id);
  } else {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, file);
    console.log('access retired: ' + id + (wasFull ? ' → approval=allow' : ''));
  }
}
console.log('清理完成：无人桶删除 ' + noBucketDeleted + ' 个；access/elevation 退役 ' + accessRetired
  + ' 个（approval=allow 迁移 ' + approvalMigrated + '，清空删文件 ' + emptiedDeleted + '）——幂等，重跑零改动');
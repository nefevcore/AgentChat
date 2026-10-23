// ============================================================
// make-node-identity.mjs —— node.exe 品牌副本生成（cr-620）
//
// 目的：任务管理器里 AgentChat 的 node 进程（宿主/壳）与其它 Node.js
// 进程可辨可杀——复制 node.exe 为 bin/AgentChat{Host,Shell}.exe 并用
// rcedit 改 FileDescription/ProductName（任务管理器「进程」页按描述分组
// 显示；「详细信息」页显示 exe 名）。产物是构建物：node 升级后重跑。
//
// 用法：node scripts/make-node-identity.mjs
// 消费：supervisor.mjs（宿主 worker）、orchestrate.ts / ac-shell-subagent
// （壳 spawn）、host-revive.ts（复活）——在场即用、缺席回落 process.execPath。
// ============================================================
import { copyFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin');
const ROLES = [
  { exe: 'AgentChatHost.exe', description: 'AgentChat Host（宿主：邮局/监护/编排/web）' },
  { exe: 'AgentChatShell.exe', description: 'AgentChat Shell（per-Agent 壳进程）' },
];

const exists = (p) => access(p, constants.F_OK).then(() => true, () => false);

await mkdir(BIN, { recursive: true });
const rcedit = (await import('rcedit')).rcedit;
for (const role of ROLES) {
  const target = path.join(BIN, role.exe);
  try {
    await copyFile(process.execPath, target);
  } catch (err) {
    // Windows 不允许覆盖在跑的 exe——旧品牌副本还在服役，跳过并提示
    if (await exists(target)) {
      console.warn('[skip] ' + role.exe + ' 正在运行无法覆盖——需要更新时先在任务管理器结束它：' + err.code);
    } else {
      throw err;
    }
  }
  await rcedit(target, {
    'version-string': {
      FileDescription: role.description,
      ProductName: 'AgentChat',
    },
  });
  console.log('[ok] ' + target);
}
console.log('完成：宿主/壳 spawn 点已自动换用品牌副本（缺席回落 node）——重启 pnpm dev:supervised 生效。');

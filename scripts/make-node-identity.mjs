// ============================================================
// make-node-identity.mjs —— node.exe 品牌副本生成（cr-620；cr-624 单映像收敛）
//
// 目的：任务管理器里 AgentChat 的 node 进程（supervisor/宿主/壳）与其它
// Node.js 进程可辨可杀。单映像 bin/AgentChat.exe——任务管理器按映像名
// 分组，三角色折进同一行「AgentChat (n)」（角色区分走命令行/日志）。
// rcedit 改 FileDescription/ProductName。产物是构建物：node 升级后重跑
//（目标在跑时跳过沿用旧副本——Windows 不允许覆盖在跑的 exe）。
//
// 用法：node scripts/make-node-identity.mjs
// 消费：supervisor.mjs（worker + 自重-exec）、orchestrate.ts /
// ac-shell-subagent（壳 spawn）、host-revive.ts（复活）——在场即用、
// 缺席回落 process.execPath。
// ============================================================
import { copyFile, mkdir, access, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin');
const TARGET = path.join(BIN, 'AgentChat.exe');
/** cr-620/623 的三角色旧形态（cr-624 收敛为单映像后清理） */
const LEGACY = ['AgentChatHost.exe', 'AgentChatShell.exe', 'AgentChatSupervisor.exe'];

const exists = (p) => access(p, constants.F_OK).then(() => true, () => false);

await mkdir(BIN, { recursive: true });
for (const old of LEGACY) {
  const p = path.join(BIN, old);
  try {
    await rm(p);
  } catch (err) {
    console.warn('[skip] ' + old + ' 正在运行无法删除（下次重跑再清）：' + err.code);
  }
}
const rcedit = (await import('rcedit')).rcedit;
let copied = true;
try {
  await copyFile(process.execPath, TARGET);
} catch (err) {
  if (await exists(TARGET)) {
    copied = false;
    console.warn('[skip] AgentChat.exe 正在运行无法覆盖（现有副本沿用）——需要更新时先在任务管理器结束它：' + err.code);
  } else {
    throw err;
  }
}
if (copied) {
  await rcedit(TARGET, {
    'version-string': {
      FileDescription: 'AgentChat',
      ProductName: 'AgentChat',
    },
  });
}
console.log('[ok] ' + TARGET);
console.log('完成：supervisor/宿主/壳 spawn 点已统一引用单映像（缺席回落 node）——重启 pnpm dev:supervised 生效。');

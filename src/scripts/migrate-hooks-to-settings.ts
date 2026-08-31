// ============================================================
// src/scripts/migrate-hooks-to-settings.ts —— 存量 Agent 档案
// 一次性迁移（M24 X1：AgentConfig.hooks → settings 键改名）
//
// 用法：npx tsx src/scripts/migrate-hooks-to-settings.ts [数据根] [--dry-run]
//   数据根缺省 = AGENTCHAT_DATA_ROOT ?? './data'。扫描 <root>/agents/*/
//   config.json：旧 `hooks` 键改名为 `settings`（两者同给时新键优先，
//   旧键丢弃——与 ac-agent-store getAgent 双读归一同语义）。
//
// 脚本纪律（既有迁移脚本纪律之并集——无单脚本全取四要素）：
//   · 幂等：无 hooks 键的档案不动；重跑零变更；
//   · marker：<root>/.migrated-hooks-settings（全文迁移完成后落盘；
//     重跑见 marker 即整体跳过——手工改档后可删 marker 重跑）；
//   · --dry-run：只报告不写盘；
//   · 迁移恒等门：migrateAgentConfig 纯函数导出，tests 锁定
//     （改名后 settingsOf 语义与迁移前 hooks 直读等价、双给时新键优先）。
// 既有脚本无备份逻辑（同款不引入）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 单档案迁移结果（纯函数，测试恒等门入口） */
export interface MigrateAgentConfigResult {
  /** 迁移后的档案对象（already = 原对象引用不动） */
  config: Record<string, unknown>;
  /** 是否发生改名（false = 幂等跳过：无旧键） */
  changed: boolean;
}

/**
 * 迁移单个 Agent config.json 对象（纯函数）：
 *   · 仅 `hooks` 在场 → 改名 `settings`；
 *   · `hooks` 与 `settings` 同给 → 新键（settings）优先，旧键丢弃；
 *   · 键序：settings 放到原 hooks 的位置（diff 最小化）。
 */
export function migrateAgentConfig(raw: Record<string, unknown>): MigrateAgentConfigResult {
  if (!('hooks' in raw)) return { config: raw, changed: false };
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'hooks') {
      if (!placed) {
        out.settings = raw.settings ?? value;
        placed = true;
      }
      continue;
    }
    if (key === 'settings') {
      if (!placed) {
        out.settings = value;
        placed = true;
      }
      continue;
    }
    out[key] = value;
  }
  return { config: out, changed: true };
}

/** marker 文件路径 */
export function markerFile(root: string): string {
  return path.join(root, '.migrated-hooks-settings');
}

// ---- CLI（直接执行时）----
if (process.argv[1] !== undefined && process.argv[1].endsWith('migrate-hooks-to-settings.ts')) {
  const dryRun = process.argv.includes('--dry-run');
  const root = path.resolve(
    process.argv.slice(2).filter((a) => !a.startsWith('--'))[0] ??
      process.env.AGENTCHAT_DATA_ROOT ??
      './data',
  );
  const agentsDir = path.join(root, 'agents');
  if (fs.existsSync(markerFile(root)) && !dryRun) {
    console.log(`marker 在场（${markerFile(root)}）——迁移已完成，整体跳过。手工改档后可删 marker 重跑。`);
    process.exit(0);
  }
  let ids: string[];
  try {
    ids = fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    console.error(`未找到 Agent 目录（${agentsDir}）`);
    process.exit(1);
  }
  let migrated = 0;
  let scanned = 0;
  for (const id of ids) {
    const file = path.join(agentsDir, id, 'config.json');
    if (!fs.existsSync(file)) continue;
    scanned++;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    } catch (err: unknown) {
      console.error(`跳过损坏档案 ${file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const result = migrateAgentConfig(raw);
    if (!result.changed) continue;
    migrated++;
    if (!dryRun) {
      const tmp = `${file}.${process.pid}.migrating`;
      fs.writeFileSync(tmp, `${JSON.stringify(result.config, null, 2)}\n`, 'utf-8');
      fs.renameSync(tmp, file);
    }
    console.log(`${dryRun ? '[dry-run] ' : ''}${file}：hooks → settings`);
  }
  if (!dryRun && migrated > 0) {
    fs.writeFileSync(markerFile(root), new Date().toISOString(), 'utf-8');
  }
  console.log(
    `完成：扫描 ${scanned} 个档案，${migrated} 个改名${dryRun ? '（dry-run 未写盘）' : migrated > 0 ? `（marker 已落盘：${markerFile(root)}）` : '（无需迁移——marker 不落盘，保持可重扫）'}`,
  );
}

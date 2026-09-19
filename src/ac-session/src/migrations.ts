// ============================================================
// ac-session/src/migrations.ts —— 会话数据版本迁移体（纯模块，零 cordis）
//
// boot.ts 经 ac-migration-core 执行器按序应用（锁后装载前）。
// skill-injection-and-storage-vocab §4/§7：
//   · v1 M-role-v2-subcall-split：role 词汇 event/error → context+source
//     + 主文件 subcall 行剥离 → subcalls.jsonl（同 pass 每文件读一次写一次）
//   · v2 M-partials-split：主文件 partial 步行 + 直调补行 → partials.jsonl
//    （三文件裁决——主文件纯定稿流，partials 是关闭行终值覆盖源档案）
// v1 已在 live 根应用过（2026-09-19）——partials 拆分按新版本号追加，不回改 v1。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Migration } from 'ac-migration-core';

/** 单会话目录迁移：按 opts 分类剥离主文件行 → 目标文件追加；role 改写内联 */
function migrateSessionDir(
  dir: string,
  opts: { roleV2: boolean; partialsSplit: boolean },
): { roleRewrites: number; subcallMoved: number; partMoved: number } {
  const mainFile = path.join(dir, 'messages.jsonl');
  if (!fs.existsSync(mainFile)) return { roleRewrites: 0, subcallMoved: 0, partMoved: 0 };
  const raw = fs.readFileSync(mainFile, 'utf-8');
  let roleRewrites = 0;
  let subcallMoved = 0;
  let partMoved = 0;
  const kept: string[] = [];
  const moved: string[] = [];
  const parted: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      kept.push(line);
      continue;
    }
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      // M-subcall（v1）：主文件 subcall 行剥离 → subcalls.jsonl
      if (r.subcall === true && r.type === 'tool-result') {
        subcallMoved++;
        moved.push(line);
        continue;
      }
      // M-partials-split（v2）：partial 步行 + 直调补行 → partials.jsonl
      // ——主文件零死重，补行是关闭行终值覆盖源，如实保留
      if (opts.partialsSplit && (r.partial === true || r.type === 'tool-result')) {
        partMoved++;
        parted.push(line);
        continue;
      }
      // M-role-v2（v1）：event/error → context + source（label 不补——UI 按缺省回落）
      if (opts.roleV2 && (r.role === 'event' || r.role === 'error')) {
        const source = typeof r.source === 'string' ? r.source : (r.role as string);
        roleRewrites++;
        kept.push(JSON.stringify({ ...r, role: 'context', source }));
        continue;
      }
      kept.push(line);
    } catch {
      kept.push(line); // 坏行原样保留
    }
  }
  if (roleRewrites === 0 && subcallMoved === 0 && partMoved === 0) {
    return { roleRewrites, subcallMoved, partMoved };
  }
  // 原子写主文件；目标文件追加（不存在则创建）
  const tmp = mainFile + '.tmp';
  fs.writeFileSync(tmp, kept.join('\n'), 'utf-8');
  fs.renameSync(tmp, mainFile);
  if (moved.length > 0) {
    fs.appendFileSync(path.join(dir, 'subcalls.jsonl'), moved.join('\n') + '\n', 'utf-8');
  }
  if (parted.length > 0) {
    fs.appendFileSync(path.join(dir, 'partials.jsonl'), parted.join('\n') + '\n', 'utf-8');
  }
  return { roleRewrites, subcallMoved, partMoved };
}

/** 目录树遍历（sessions/ 下全部 messages.jsonl） */
function walkSessions(dataRoot: string, opts: { roleV2: boolean; partialsSplit: boolean }): { roleRewrites: number; subcallMoved: number; partMoved: number } {
  const sessionsRoot = path.join(dataRoot, 'sessions');
  const total = { roleRewrites: 0, subcallMoved: 0, partMoved: 0 };
  if (!fs.existsSync(sessionsRoot)) return total;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(d, entry.name));
      } else if (entry.name === 'messages.jsonl') {
        const r = migrateSessionDir(path.dirname(path.join(d, entry.name)), opts);
        total.roleRewrites += r.roleRewrites;
        total.subcallMoved += r.subcallMoved;
        total.partMoved += r.partMoved;
      }
    }
  };
  walk(sessionsRoot);
  return total;
}

/** 会话数据迁移集（升序应用；见文件头注释） */
export const SESSION_MIGRATIONS: Migration[] = [
  {
    version: 1,
    id: 'role-v2-subcall-split',
    description: '存储词汇 v2（event/error → context+source）+ subcall 行剥离主文件',
    apply(dataRoot: string): void {
      const total = walkSessions(dataRoot, { roleV2: true, partialsSplit: false });
      console.log(`[migration] role-v2 改写 ${total.roleRewrites} 行；subcall 剥离 ${total.subcallMoved} 行`);
    },
  },
  {
    version: 2,
    id: 'partials-split',
    description: 'partial 步行 + 直调补行摘出主文件 → partials.jsonl（三文件：messages=定稿流 / partials=中间态+覆盖源 / subcalls=子调用档案）',
    apply(dataRoot: string): void {
      const total = walkSessions(dataRoot, { roleV2: false, partialsSplit: true });
      console.log(`[migration] partials 摘除 ${total.partMoved} 行`);
    },
  },
];

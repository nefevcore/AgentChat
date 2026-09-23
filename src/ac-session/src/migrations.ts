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

/** 单会话目录迁移：按 pass 分类剥离主文件行 → 目标文件追加；role 改写内联。
 *  pass = 迁移标识（每次迁移单选一种改写——walkSessions 逐迁移调用） */
function migrateSessionDir(
  dir: string,
  pass: 'role-v2-subcall-split' | 'partials-split',
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
      if (pass === 'partials-split' && (r.partial === true || r.type === 'tool-result')) {
        partMoved++;
        parted.push(line);
        continue;
      }
      // M-role-v2（v1）：event/error → context + source（label 不补——UI 按缺省回落）
      if (pass === 'role-v2-subcall-split' && (r.role === 'event' || r.role === 'error')) {
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
  // 追加目标文件（不存在则创建）——必须先于主文件改写：若先改写主文件
  // 再 append，append 前崩溃/抛错（盘满等）后重启，主文件已无被剥离行、
  // 三计数归零触发早退，行将永久丢失（版本锚在 apply 成功后才落）。
  // 幂等保障：append 前按行身份（JSON 的 tool_call_id/run+seq，损坏行按
  // 原文）剔除已有行——崩溃重跑不再产生重复行（injectSubcalls 投影与
  // journal 读侧对重复 subcall 行均不去重，重复 = 双卡/重影）。
  // 尾行防护：目标文件存在无换行尾行（上次崩溃窗口残留）时先补 \n，
  // 否则 append 会与之拼行双损（对齐运行期 repairTail 语义）。
  const lineIdentity = (raw: string): string => {
    try {
      const p = JSON.parse(raw) as { tool_call_id?: unknown; run?: unknown; seq?: unknown; type?: unknown; result?: unknown };
      if (typeof p.tool_call_id === 'string' && p.tool_call_id) return 'tc:' + p.tool_call_id + ':' + String(p.result === undefined ? '' : JSON.stringify(p.result));
      if (typeof p.run === 'string' && p.run && typeof p.seq === 'number') return `${String(p.type)}:${p.run}:${p.seq}`;
      return raw;
    } catch {
      return raw;
    }
  };
  const appendLines = (file: string, lines: string[]): void => {
    const p = path.join(dir, file);
    let prev = '';
    try {
      prev = fs.readFileSync(p, 'utf-8');
    } catch { /* 无文件 = 全新追加 */ }
    const have = new Set<string>();
    for (const raw of prev.split('\n')) {
      if (raw.trim()) have.add(lineIdentity(raw));
    }
    const fresh = lines.filter((l) => !have.has(lineIdentity(l)));
    if (fresh.length === 0) return;
    const prefix = prev.length > 0 && !prev.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(p, prefix + fresh.join('\n') + '\n', 'utf-8');
  };
  if (moved.length > 0) appendLines('subcalls.jsonl', moved);
  if (parted.length > 0) appendLines('partials.jsonl', parted);
  // 原子写主文件（在后）。
  // 迁移是形态改写而非新数据：rename 后恢复原 mtime——前端会话列表的
  // lastActivity 取 messages.jsonl 的 mtime（ac-singles preview ←
  // ac-session stats().updatedAt），不恢复则升级当次全量会话的时间戳
  // 被重置为迁移时刻，列表全部落「今天」桶（2026-12）。atime 一并还原。
  const prevStat = fs.statSync(mainFile);
  const tmp = mainFile + '.tmp';
  fs.writeFileSync(tmp, kept.join('\n'), 'utf-8');
  fs.renameSync(tmp, mainFile);
  fs.utimesSync(mainFile, prevStat.atime, prevStat.mtime);
  return { roleRewrites, subcallMoved, partMoved };
}

/** 目录树遍历（sessions/ 下全部 messages.jsonl）；pass 透传 migrateSessionDir */
function walkSessions(dataRoot: string, pass: 'role-v2-subcall-split' | 'partials-split'): { roleRewrites: number; subcallMoved: number; partMoved: number } {
  const sessionsRoot = path.join(dataRoot, 'sessions');
  const total = { roleRewrites: 0, subcallMoved: 0, partMoved: 0 };
  if (!fs.existsSync(sessionsRoot)) return total;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(d, entry.name));
      } else if (entry.name === 'messages.jsonl') {
        const r = migrateSessionDir(path.dirname(path.join(d, entry.name)), pass);
        total.roleRewrites += r.roleRewrites;
        total.subcallMoved += r.subcallMoved;
        total.partMoved += r.partMoved;
      }
    }
  };
  walk(sessionsRoot);
  return total;
}

/** subagents 域迁移（v3，2026-12 三文件化）：<subId>.jsonl 单文件 →
 *  <subId>/messages.jsonl 目录形态（服务读侧另有旧单文件回退兼容，迁移是
 *  形态归一非数据改写——行内容逐字节保留，rename 语义）。
 *  幂等：目录形态已存在 = 跳过；单文件不存在 = 无事可做。 */
function migrateSubagentsDir(dataRoot: string): { moved: number } {
  const subsRoot = path.join(dataRoot, 'subagents');
  let moved = 0;
  if (!fs.existsSync(subsRoot)) return { moved };
  for (const entry of fs.readdirSync(subsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const id = entry.name.slice(0, -'.jsonl'.length);
    // 非 subId 形态文件不动；点号段名（'..' 等病态路径词）同拦
    if (!/^[A-Za-z0-9_.-]+$/.test(id) || id === '.' || id === '..') continue;
    const src = path.join(subsRoot, entry.name);
    const dir = path.join(subsRoot, id);
    const migrated = path.join(dir, 'messages.jsonl');
    if (fs.existsSync(migrated)) {
      // messages.jsonl 在场 = 拷贝早已完成（copy→rename 原子），旧单文件是
      // rename 后 rm 前崩溃的残留——不删则 messagesPath 读侧恒优先旧文件，
      // dir 内定稿流被永久弃用（双份漂移）。删除收尾（幂等）。
      fs.rmSync(src, { force: true });
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, 'messages.jsonl.tmp');
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, migrated);
    fs.rmSync(src);
    moved++;
  }
  return { moved };
}

/** 会话数据迁移集（升序应用；见文件头注释） */
export const SESSION_MIGRATIONS: Migration[] = [
  {
    version: 1,
    id: 'role-v2-subcall-split',
    description: '存储词汇 v2（event/error → context+source）+ subcall 行剥离主文件',
    apply(dataRoot: string): void {
      const total = walkSessions(dataRoot, 'role-v2-subcall-split');
      console.log(`[migration] role-v2 改写 ${total.roleRewrites} 行；subcall 剥离 ${total.subcallMoved} 行`);
    },
  },
  {
    version: 2,
    id: 'partials-split',
    description: 'partial 步行 + 直调补行摘出主文件 → partials.jsonl（三文件：messages=定稿流 / partials=中间态+覆盖源 / subcalls=子调用档案）',
    apply(dataRoot: string): void {
      const total = walkSessions(dataRoot, 'partials-split');
      console.log(`[migration] partials 摘除 ${total.partMoved} 行`);
    },
  },
  {
    version: 3,
    id: 'subagents-dir',
    description: 'subagents 单文件会话目录化（<subId>.jsonl → <subId>/messages.jsonl，三文件形态对齐 sessions 域）',
    apply(dataRoot: string): void {
      const { moved } = migrateSubagentsDir(dataRoot);
      console.log(`[migration] subagents 目录化 ${moved} 个会话`);
    },
  },
  {
    version: 4,
    id: 'partial-rematerialize-purge',
    description: '清除主文件被物化的 partial 行（归档重写曾把读侧投影写回 messages.jsonl——与 partials.jsonl 原行双源同读致 UI 思考重复卡；重跑 partials-split 语义，幂等）',
    apply(dataRoot: string): void {
      const total = walkSessions(dataRoot, 'partials-split');
      console.log(`[migration] partial 物化残留清除 ${total.partMoved} 行`);
    },
  },
];

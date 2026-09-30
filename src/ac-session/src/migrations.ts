// ============================================================
// ac-session/src/migrations.ts —— 会话数据版本迁移体（纯模块，零 cordis）
//
// boot.ts 经 ac-migration-core 执行器按序应用（锁后装载前）。
// skill-injection-and-storage-vocab §4/§7：
//   · v1 M-role-v2-subcall-split：role 词汇 event/error → context+source
//     + 主文件 subcall 行剥离 → subcalls.jsonl（同 pass 每文件读一次写一次）
//   · v2 M-partials-split：主文件 partial 步行 + 直调补行 → partials.jsonl
//    （三文件裁决——主文件纯定稿流，partials 是关闭行终值覆盖源档案）
//   v5 M-legacy-journal-purge：partials.jsonl 内旧形态（无 type 字段的
//    partial 步行）按「run 已定稿」判定剔除——v2 拆分（运行时同步改写侧）
//    到 journal 泛化（清理面只认新形态 type 行）之间的夹缝窗口写入的行，
//    settlement/recoverJournal 的行身份解析（journalIdentity）一律 undefined
//    （宁重不丢 → 永久保留），读侧却仍按 run 活投出——死数据无限累积。
//   v6 M-stale-partial-purge（cr-44）：陈年（>7 天）未收束 partial 行物理清除
//    （messages 物化残留 + partials 旧形态孤儿）——09-25 双进程并发写事故
//    丢收束行后，孤儿行被读侧活投为「中断恢复源」喂幻觉（news 幻影回放）；
//    与读侧闸门（records() 陈年过滤）同口径，判定函数 isStalePartial 同源。
// v1 已在 live 根应用过（2026-09-19）——partials 拆分按新版本号追加，不回改 v1。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Migration } from 'ac-migration-core';

/** 陈年未收束 partial 行阈值（cr-44）——与 index.ts 读侧闸门同源（本文件导出、index 消费） */
export const STALE_PARTIAL_MS = 7 * 24 * 60 * 60 * 1000;

/** partial 行是否陈年（timestamp 缺席/不可解析 = 无法判龄 → 不滤，宁投勿丢） */
export function isStalePartial(r: { partial?: boolean; timestamp?: string }): boolean {
  if (r.partial !== true) return false;
  if (typeof r.timestamp !== 'string' || r.timestamp === '') return false;
  const ts = Date.parse(r.timestamp);
  return Number.isFinite(ts) && Date.now() - ts > STALE_PARTIAL_MS;
}

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
  // 被重置为迁移时刻，列表全部落「今天」桶（2026-09-21）。atime 一并还原。
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

/** subagents 域迁移（v3，2026-09-22 三文件化）：<subId>.jsonl 单文件 →
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

/** v5：单会话 partials.jsonl 旧形态清理——已定稿 run 的无 type 行剔除。
 *  判据与运行时 recoverJournal 的 settled 同口径：messages 中存在该 run 的
 *  非 partial 定稿行（段行/收束行/注入提升行）即视为已定稿；不同处在于
 *  recoverJournal 需锚 run-settled（泛化后写入），此处覆盖泛化前定稿的历史
 *  run（其收束行无锚）。未收束 run 的旧形态行保留——中断恢复源（读侧
 *  records() 仍按 run 活投出，非死数据）。新形态行（journal-step/-inject/
 *  tool-result）一律不动——归 settlement/recoverJournal 生命周期管辖。 */
function purgeLegacyJournal(dir: string): { purged: number; kept: number } {
  const partFile = path.join(dir, 'partials.jsonl');
  const mainFile = path.join(dir, 'messages.jsonl');
  if (!fs.existsSync(partFile)) return { purged: 0, kept: 0 };
  const raw = fs.readFileSync(partFile, 'utf-8');
  if (!raw.trim()) {
    fs.rmSync(partFile);
    return { purged: 0, kept: 0 };
  }
  // 定稿 run 集：messages 内非 partial、非 run-settled、携带 run 的行
  const settled = new Set<string>();
  if (fs.existsSync(mainFile)) {
    for (const line of fs.readFileSync(mainFile, 'utf-8').split('\n')) {
      if (!line.trim() || line.trimStart().startsWith('{"type":"run-settled"')) continue;
      try {
        const r = JSON.parse(line) as { run?: unknown; partial?: unknown };
        if (typeof r.run === 'string' && r.run && r.partial !== true) settled.add(r.run);
      } catch { /* 坏行忽略 */ }
    }
  }
  let purged = 0;
  let kept = 0;
  const keptLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let drop = false;
    try {
      const r = JSON.parse(line) as { type?: unknown; run?: unknown };
      // 旧形态（无 type）+ 已定稿 run → 死数据剔除；其余保留
      if (r.type === undefined && typeof r.run === 'string' && settled.has(r.run)) drop = true;
    } catch { /* 坏行保留 */ }
    if (drop) purged++;
    else { kept++; keptLines.push(line); }
  }
  if (purged === 0) return { purged, kept };
  if (kept === 0) fs.rmSync(partFile);
  else {
    const tmp = partFile + '.purge.tmp';
    fs.writeFileSync(tmp, keptLines.join('\n') + '\n', 'utf-8');
    fs.renameSync(tmp, partFile);
  }
  return { purged, kept };
}

/** v6：单会话陈年孤儿 partial 行清除——两文件同口径。孤儿判定与 v5/读侧
 *  absorbedRuns 同源：messages 内无该 run 的非 partial 行（收束行丢失即孤儿）。
 *  清除面 = partial:true 且 isStalePartial 且孤儿 run 的行；timestamp 缺席
 *  （无法判龄）或 run 内有任何新鲜行（同 run 混龄——部分行被收束行吸收
 *  语义覆盖）不清除。幂等；mtime 还原（同 v2 会话列表时间戳保护）。 */
function purgeStalePartials(dir: string): { main: number; part: number } {
  const mainFile = path.join(dir, 'messages.jsonl');
  const partFile = path.join(dir, 'partials.jsonl');
  // 收束 run 集（主文件非 partial 行的 run 键）
  const settled = new Set<string>();
  if (fs.existsSync(mainFile)) {
    for (const line of fs.readFileSync(mainFile, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { run?: unknown; partial?: unknown };
        if (typeof o.run === 'string' && o.run && o.partial !== true) settled.add(o.run);
      } catch { /* 坏行忽略 */ }
    }
  }
  const filterFile = (file: string): number => {
    if (!fs.existsSync(file)) return 0;
    const raw = fs.readFileSync(file, 'utf-8');
    const kept: string[] = [];
    let purged = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let drop = false;
      try {
        const o = JSON.parse(line) as { run?: unknown; partial?: unknown; timestamp?: unknown };
        drop = o.partial === true && typeof o.run === 'string' && !!o.run
          && !settled.has(o.run) && isStalePartial({ partial: o.partial, timestamp: typeof o.timestamp === 'string' ? o.timestamp : undefined });
      } catch { /* 坏行保留 */ }
      if (drop) purged++;
      else kept.push(line);
    }
    if (purged === 0) return 0;
    const prevStat = fs.statSync(file);
    const tmp = file + '.purge6.tmp';
    fs.writeFileSync(tmp, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf-8');
    fs.renameSync(tmp, file);
    fs.utimesSync(file, prevStat.atime, prevStat.mtime);
    return purged;
  };
  return { main: filterFile(mainFile), part: filterFile(partFile) };
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
  {
    version: 5,
    id: 'legacy-journal-purge',
    description: '清除 partials.jsonl 内已定稿 run 的旧形态（无 type 字段）partial 步行——v2 拆分与 journal 泛化夹缝窗口的死数据（清理面只认新形态，旧行永久保留且读侧仍投出）',
    apply(dataRoot: string): void {
      const sessionsRoot = path.join(dataRoot, 'sessions');
      let purged = 0;
      let kept = 0;
      let files = 0;
      if (!fs.existsSync(sessionsRoot)) return;
      const walk = (d: string): void => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(path.join(d, entry.name));
          else if (entry.name === 'partials.jsonl') {
            const r = purgeLegacyJournal(path.dirname(path.join(d, entry.name)));
            purged += r.purged;
            kept += r.kept;
            if (r.purged > 0 || r.kept > 0) files++;
          }
        }
      };
      walk(sessionsRoot);
      console.log(`[migration] 旧形态 journal 清理：剔除 ${purged} 行，保留 ${kept} 行（未定稿 run 中断恢复源），涉及 ${files} 个会话`);
    },
  },
  {
    version: 6,
    id: 'stale-partial-purge',
    description: '物理清除陈年（>7 天）未收束 partial 行（messages 物化残留 + partials 旧形态孤儿）——收束行丢失事故后孤儿行被读侧活投喂幻觉（cr-44 news 幻影回放根因）；与读侧闸门同口径',
    apply(dataRoot: string): void {
      const sessionsRoot = path.join(dataRoot, 'sessions');
      if (!fs.existsSync(sessionsRoot)) return;
      let purgedMain = 0;
      let purgedPart = 0;
      let files = 0;
      const walk = (d: string): void => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(path.join(d, entry.name));
          else if (entry.name === 'messages.jsonl' || entry.name === 'partials.jsonl') {
            const r = purgeStalePartials(path.dirname(path.join(d, entry.name)));
            purgedMain += r.main;
            purgedPart += r.part;
            if (r.main > 0 || r.part > 0) files++;
          }
        }
      };
      walk(sessionsRoot);
      console.log(`[migration] 陈年孤儿 partial 行清除：主文件 ${purgedMain} 行，partials ${purgedPart} 行，涉及 ${files} 个会话`);
    },
  },
];

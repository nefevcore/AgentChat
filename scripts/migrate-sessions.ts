// ============================================================
// scripts/migrate-sessions.ts —— 会话/记忆存储迁移（2026-08-08 新规范）
//
// 新规范：
//   1v1 会话：sessions/chat~<lo>~<hi>/messages.jsonl（lo/hi 排序）
//   群聊历史：sessions/group~<gid>/archive/<aid>/history_<YYYY>-<WW>.jsonl
//   记忆：    files/<aid>/memory/<counterpart>.memory.md（集中管理）
//
// 迁移源（旧格式）：
//   · canonical 嵌套：sessions/<lo>/<hi>/messages.jsonl (+archive/ +memory.md)
//   · 平铺 dialogId： sessions/<from>__<to>/messages.jsonl (+memory.md)
//   · 群聊旧：        groups/<gid>/messages.jsonl、sessions/<agent>/group__<gid>/
//
// 用法：
//   npx tsx scripts/migrate-sessions.ts            # dry-run 预览
//   npx tsx scripts/migrate-sessions.ts --apply    # 实际迁移（原目录保留，复制到新位置）
//   npx tsx scripts/migrate-sessions.ts --apply --clean  # 迁移后删除旧目录
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

const APPLY = process.argv.includes('--apply');
const CLEAN = process.argv.includes('--clean');
const WS = process.env.AGENTCHAT_WORKSPACE || 'workspace/default';
const SESSIONS = path.join(WS, 'sessions');
const GROUPS = path.join(WS, 'groups');
const FILES = path.join(WS, 'files');

let moved = 0;
let skipped = 0;

function log(msg: string): void { console.log(msg); }
function done(src: string, dest: string): void {
  moved++;
  const srcLabel = path.isAbsolute(src) ? path.relative(WS, src) : src;
  log(`  ✓ ${srcLabel} → ${path.relative(WS, dest)}`);
}
function note(msg: string): void { log(`  · ${msg}`); skipped++; }

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 复制文件（target 已存在则跳过；--apply 才真正写入） */
function copyFile(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dest)) { note(`目标已存在，跳过: ${path.relative(WS, dest)}`); return; }
  if (APPLY) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
  done(src, dest);
}

/** 复制目录内容（messages.jsonl / archive / memory.md 等） */
function copySessionContent(srcDir: string, destDir: string, srcLabel: string): void {
  if (!fs.existsSync(srcDir)) return;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'archive') {
        copyTree(s, path.join(destDir, 'archive'), srcLabel + '/archive');
      } else if (entry.name === 'newdir' || entry.name === '_legacy') {
        continue; // 历史残留/占位目录
      }
    } else if (entry.isFile()) {
      if (entry.name === 'memory.md') {
        // 记忆单独迁移（需 selfId；此处由调用方处理，见 migrateMemory）
        continue;
      }
      if (entry.name === '.memory_update_needed' || entry.name === '.memory_review_needed') {
        // 记忆审查/更新标记：由 migrateMemory 一并迁到 files/<selfId>/memory/
        continue;
      }
      copyFile(s, path.join(destDir, entry.name));
    }
  }
}

function copyTree(src: string, dest: string, srcLabel: string): void {
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dest)) { note(`目标已存在，跳过: ${path.relative(WS, dest)}`); return; }
  if (APPLY) {
    ensureDir(dest);
    fs.cpSync(src, dest, { recursive: true });
  }
  done(srcLabel, dest);
}

/** 记忆文件迁移：sessions/<...>/memory.md → files/<selfId>/memory/<counterpart>.memory.md */
function migrateMemory(memoryPath: string, selfId: string, counterpart: string): void {
  if (!fs.existsSync(memoryPath)) return;
  const dest = path.join(FILES, selfId, 'memory', `${counterpart}.memory.md`);
  copyFile(memoryPath, dest);
  // 迁移附带标记
  for (const mark of ['.memory_update_needed', '.memory_review_needed']) {
    const msrc = path.join(path.dirname(memoryPath), mark);
    if (fs.existsSync(msrc)) copyFile(msrc, path.join(FILES, selfId, 'memory', `${counterpart}${mark.replace('.memory', '.memory')}`));
  }
}

function chatKey(a: string, b: string): string {
  const [lo, hi] = [a, b].sort();
  return `chat~${lo}~${hi}`;
}

// ============================================================
// 1. 平铺 dialogId：sessions/<from>__<to>/ → sessions/chat~<lo>~<hi>/
// ============================================================
log(`\n== 1. 平铺 dialogId（__ → chat~）==`);
if (fs.existsSync(SESSIONS)) {
  for (const dir of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.includes('__')) continue;
    const [a, b] = dir.name.split('__');
    if (!a || !b) continue;
    const srcDir = path.join(SESSIONS, dir.name);
    const destDir = path.join(SESSIONS, chatKey(a, b));
    copySessionContent(srcDir, destDir, dir.name);
    // 平铺记忆：sessions/<from>__<to>/memory.md → files/<from>/memory/<to>.memory.md
    migrateMemory(path.join(srcDir, 'memory.md'), a, b);
    if (APPLY && CLEAN) fs.rmSync(srcDir, { recursive: true, force: true });
  }
}

// ============================================================
// 2. canonical 嵌套：sessions/<lo>/<hi>/ → sessions/chat~<lo>~<hi>/
// ============================================================
log(`\n== 2. canonical 嵌套（lo/hi → chat~）==`);
if (fs.existsSync(SESSIONS)) {
  for (const dir of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name.includes('__') || dir.name.includes('~')) continue;
    const d1 = path.join(SESSIONS, dir.name);
    for (const sub of fs.readdirSync(d1, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      // 历史占位/残留目录（newdir/_legacy）：不迁移，--clean 时直接删除
      if (sub.name === 'newdir' || sub.name === '_legacy') {
        if (APPLY && CLEAN) fs.rmSync(path.join(d1, sub.name), { recursive: true, force: true });
        continue;
      }
      const subDir = path.join(d1, sub.name);
      // 群聊旧：sessions/<agent>/group__<gid>/ → group~<gid>/archive/<agent>/
      if (sub.name.startsWith('group__')) {
        const gid = sub.name.slice('group__'.length);
        const destDir = path.join(SESSIONS, `group~${gid}`, 'archive', dir.name);
        copyTree(subDir, destDir, `${dir.name}/group__${gid}`);
        if (APPLY && CLEAN) fs.rmSync(subDir, { recursive: true, force: true });
        continue;
      }
      const destDir = path.join(SESSIONS, chatKey(dir.name, sub.name));
      copySessionContent(subDir, destDir, `${dir.name}/${sub.name}`);
      // canonical 记忆：归属按 lo 视角（sessions/a/b/memory.md → files/a/memory/b.memory.md）
      migrateMemory(path.join(subDir, 'memory.md'), dir.name, sub.name);
      if (APPLY && CLEAN) {
        fs.rmSync(subDir, { recursive: true, force: true });
        if (fs.readdirSync(d1).length === 0) fs.rmSync(d1, { recursive: true, force: true });
      }
    }
  }
}

// ============================================================
// 3. 群聊旧消息：groups/<gid>/messages.jsonl → group~<gid>/messages.jsonl（群聊本体）
// ============================================================
log(`\n== 3. 群聊旧消息（groups/<gid>/messages.jsonl → group~<gid>/messages.jsonl）==`);
if (fs.existsSync(GROUPS)) {
  for (const dir of fs.readdirSync(GROUPS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const msgFile = path.join(GROUPS, dir.name, 'messages.jsonl');
    if (!fs.existsSync(msgFile)) continue;
    const dest = path.join(SESSIONS, `group~${dir.name}`, 'messages.jsonl');
    copyFile(msgFile, dest);
    // --clean：旧群消息已复制到本体，删除旧文件（保留 group.json 等元数据）
    if (APPLY && CLEAN) fs.rmSync(msgFile, { force: true });
  }
}

// 兼容：此前已迁移到 archive/_legacy/ 的群消息 → 若本体缺失则提升为群聊本体
if (fs.existsSync(SESSIONS)) {
  for (const dir of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.startsWith('group~')) continue;
    const gid = dir.name.slice('group~'.length);
    const body = path.join(SESSIONS, dir.name, 'messages.jsonl');
    const legacy = path.join(SESSIONS, dir.name, 'archive', '_legacy', 'messages.jsonl');
    if (!fs.existsSync(body) && fs.existsSync(legacy)) {
      copyFile(legacy, body);
    }
    // --clean：_legacy 已提升/有本体副本，删除兼容目录
    if (APPLY && CLEAN && fs.existsSync(legacy)) {
      fs.rmSync(path.join(SESSIONS, dir.name, 'archive', '_legacy'), { recursive: true, force: true });
    }
  }
}

log(`\n迁移完成：${moved} 项处理${APPLY ? '（已写入）' : '（dry-run 预览，加 --apply 执行）'}，${skipped} 项跳过/已存在。`);

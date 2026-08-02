// ============================================================
// session-maint.js —— 会话数据维护工具箱（统一入口）
//
// 子命令：
//   scan    消息健康检查 + 修复（孤儿 tool / 悬空 assistant /
//           空 assistant / trigger 误标 tool）
//   aa      A→A 自对话消息历史清理（保留 memory.md）
//   compact 归档压缩（跨文件去重 + token 预算截断 + 备份 + 重建）
//   all     依次执行 scan → aa → compact
//
// 通用参数：
//   --fix       执行修改（默认只读预览）
//   --pair a/b  compact 限定会话对
//
// 用法示例：
//   node scripts/session-maint.js scan --fix
//   node scripts/session-maint.js aa --fix
//   node scripts/session-maint.js compact --pair agent_chat_dev/user --fix
//   node scripts/session-maint.js all --fix
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'workspace', 'default');
const SESSIONS = path.join(ROOT, 'sessions');
const SCAN_DIRS = ['sessions', 'groups'];

// ---- 参数解析 ----
const FIX = process.argv.includes('--fix');
const CMD = process.argv[2] || 'help';
const pairArg = (() => {
  const i = process.argv.indexOf('--pair');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1].split('/') : null;
})();

// ============================================================
// 公共工具
// ============================================================

function estimateTokens(text) {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) tokens += /[\u4e00-\u9fff]/.test(ch) ? 0.6 : 0.3;
  return Math.ceil(tokens);
}

/** 递归收集所有消息文件（messages.jsonl + 归档 history_*.jsonl） */
function collectMessageFiles(base) {
  const files = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'messages.jsonl' || /^history_\d+\.jsonl$/.test(e.name)) files.push(full);
    }
  })(base);
  return files;
}

function normId(id) {
  if (!id) return '';
  return id.replace(/^call_/, '');
}

/**
 * 判断消息"修复后的实际角色"，镜像 toPersistedRole 修复语义。
 *
 * 2026-08-02 重构后 role='trigger' 为一等权威角色（Agent 以 role='trigger'
 * 标记真实 trigger），因此默认信任 role='trigger' 即为真实 trigger。
 * 唯一例外是历史损坏特征：带 tool_call_id 的 trigger 实为被误标的 tool 结果。
 */
function effectiveRole(m) {
  if (m.role === 'trigger') {
    // 仅带 tool_call_id 是明确的"tool 结果被误标为 trigger"损坏特征 → 还原为 tool
    if (m.tool_call_id) return 'tool';
    return 'trigger';
  }
  return m.role;
}

/** 是否入站边界（中断 tool 配对回溯）：user / 人类消息 / 真实 trigger / error / system */
function isBoundary(m) {
  return m.role === 'user' || m.role === 'error' || m.role === 'system'
    || m.role === 'trigger'
    || m.agent_id === 'user';
}

// ============================================================
// 子命令：scan —— 消息健康检查 + 修复
// ============================================================

function analyze(msgs) {
  const orphanTools = new Set();
  const danglingAssistants = new Set();
  const emptyAssistants = new Set();

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];

    // 空 assistant：无 content / tool_calls / reasoning_content（含被误标为 trigger 的空回复）
    if (effectiveRole(m) === 'agent'
        && (m.content == null || m.content === '')
        && !(m.tool_calls && m.tool_calls.length)
        && !m.reasoning_content) {
      emptyAssistants.add(i);
      continue;
    }

    // 孤儿 tool：向前找最近的 agent tool_calls（跨入站边界则中断）
    if (effectiveRole(m) === 'tool') {
      const tcId = normId(m.tool_call_id || '');
      let found = false;
      for (let j = i - 1; j >= 0; j--) {
        const prev = msgs[j];
        if (effectiveRole(prev) === 'agent' && prev.tool_calls?.length) {
          for (const tc of prev.tool_calls) {
            if (normId(tc.id) === tcId) { found = true; break; }
          }
          if (found) break;
        }
        if (isBoundary(prev)) break;
      }
      if (!found) orphanTools.add(i);
    }

    // 悬空 assistant：tool_calls 有未获 tool 结果的
    if (effectiveRole(m) === 'agent' && m.tool_calls?.length) {
      const required = new Set(m.tool_calls.map(tc => normId(tc.id)));
      let foundCount = 0;
      for (let j = i + 1; j < msgs.length; j++) {
        if (isBoundary(msgs[j])) break;
        if (effectiveRole(msgs[j]) === 'tool' && required.has(normId(msgs[j].tool_call_id || ''))) {
          foundCount++;
          required.delete(normId(msgs[j].tool_call_id || ''));
        }
      }
      if (foundCount < m.tool_calls.length) danglingAssistants.add(i);
    }
  }
  return { orphanTools, danglingAssistants, emptyAssistants };
}

function cmdScan() {
  let totalOrphan = 0, totalDangling = 0, totalEmpty = 0, totalRepaired = 0, touched = 0;

  for (const dirName of SCAN_DIRS) {
    for (const file of collectMessageFiles(path.join(ROOT, dirName))) {
      const raw = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      if (!raw.length) continue;
      const msgs = raw.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const { orphanTools, danglingAssistants, emptyAssistants } = analyze(msgs);

      const removeSet = new Set([...orphanTools, ...emptyAssistants]);
      for (const idx of danglingAssistants) {
        removeSet.add(idx);
        const m = msgs[idx];
        const ids = new Set(m.tool_calls.map(tc => normId(tc.id)));
        for (let j = idx + 1; j < msgs.length; j++) {
          if (isBoundary(msgs[j]) || removeSet.has(j)) break;
          if (effectiveRole(msgs[j]) === 'tool' && ids.has(normId(msgs[j].tool_call_id || ''))) removeSet.add(j);
        }
      }

      // 误标 trigger（2026-08-02 重构后 role='trigger' 为权威角色，默认信任；
      // 仅修复明确损坏特征——带 tool_call_id 的 trigger 实为历史归档误标的
      // tool 结果，如 query_history 工具输出曾以 trigger 形式落盘）。
      const repairIdxs = [];
      for (let i = 0; i < msgs.length; i++) {
        if (!removeSet.has(i) && msgs[i].role === 'trigger' && msgs[i].tool_call_id) repairIdxs.push(i);
      }

      if (removeSet.size === 0 && repairIdxs.length === 0) continue;
      touched++;

      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const fmt = (s) => [...s].map(i => '#' + i).join(',');
      console.log(`${rel}`);
      if (orphanTools.size) console.log(`   孤儿 tool: ${fmt(orphanTools)}  (${orphanTools.size} 条)`);
      if (danglingAssistants.size) console.log(`   悬空 tool_calls assistant: ${fmt(danglingAssistants)}  (${danglingAssistants.size} 条)`);
      if (emptyAssistants.size) console.log(`   空 assistant: ${fmt(emptyAssistants)}  (${emptyAssistants.size} 条)`);
      if (repairIdxs.length) console.log(`   trigger 误标（→tool/agent）: ${fmt(repairIdxs)}  (${repairIdxs.length} 条)`);

      totalOrphan += orphanTools.size;
      totalDangling += danglingAssistants.size;
      totalEmpty += emptyAssistants.size;
      totalRepaired += repairIdxs.length;

      if (FIX) {
        const out = raw.map((line, i) => {
          if (removeSet.has(i)) return null;
          if (repairIdxs.includes(i)) {
            try {
              const m = JSON.parse(line);
              m.role = 'tool'; // 带 tool_call_id 的 trigger 误标 → 还原为 tool 结果
              return JSON.stringify(m);
            } catch { return line; }
          }
          return line;
        }).filter(Boolean);
        fs.writeFileSync(file, out.join('\n') + '\n', 'utf-8');
        console.log(`   → 已处理: ${raw.length} -> ${out.length} 行`);
      }
    }
  }

  console.log(`\n[scan] 孤儿 tool: ${totalOrphan} | 悬空 assistant: ${totalDangling} | 空 assistant: ${totalEmpty} | trigger 误标: ${totalRepaired} | 涉及文件: ${touched}`);
}

// ============================================================
// 子命令：aa —— A→A 自对话消息历史清理（保留 memory.md）
// ============================================================

function cmdAa() {
  let removedMsgs = 0, removedArchives = 0, removedMarkers = 0, touchedDirs = 0;
  const agents = fs.readdirSync(SESSIONS, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name);

  for (const a of agents) {
    const selfDir = path.join(SESSIONS, a, a);
    if (!fs.existsSync(selfDir)) continue;

    const summary = [];
    let touched = false;

    const msgPath = path.join(selfDir, 'messages.jsonl');
    if (fs.existsSync(msgPath)) {
      const n = fs.readFileSync(msgPath, 'utf-8').split('\n').filter(Boolean).length;
      summary.push(`messages.jsonl(${n} 行)`);
      if (FIX) { fs.unlinkSync(msgPath); removedMsgs += n; }
      touched = true;
    }

    const archiveDir = path.join(selfDir, 'archive');
    if (fs.existsSync(archiveDir)) {
      const files = fs.readdirSync(archiveDir).filter(f => f.endsWith('.jsonl'));
      summary.push(`archive(${files.length} 个)`);
      if (FIX) { fs.rmSync(archiveDir, { recursive: true, force: true }); removedArchives += files.length; }
      touched = true;
    }

    const markers = [];
    for (const e of fs.readdirSync(selfDir, { withFileTypes: true })) {
      if (e.isFile() && /^\.(archive|memory)/.test(e.name)) markers.push(e.name);
    }
    if (markers.length) {
      summary.push(`标记(${markers.join(',')})`);
      if (FIX) {
        for (const m of markers) fs.unlinkSync(path.join(selfDir, m));
        removedMarkers += markers.length;
      }
      touched = true;
    }

    if (touched) {
      touchedDirs++;
      console.log(`sessions/${a}/${a}: 删除 ${summary.join(' + ')}（保留 memory.md）`);
    }
  }

  console.log(`\n[aa] 涉及 ${touchedDirs} 个自对话目录` +
    (FIX ? ` | 删除活跃 ${removedMsgs} 行、归档 ${removedArchives} 个、标记 ${removedMarkers} 个` : '（预览，加 --fix 执行）'));
}

// ============================================================
// 子命令：compact —— 归档压缩（去重 + 截断 + 备份 + 重建）
// ============================================================

function compactTokenConfig() {
  let maxContextTokens = 1_000_000;
  let keepRecentRatio = 0.03;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
    const es = cfg['extension.agent_session'] || {};
    if (typeof es.maxContextTokens === 'number') maxContextTokens = es.maxContextTokens;
    if (typeof es.keepRecentRatio === 'number') keepRecentRatio = es.keepRecentRatio;
  } catch { /* 用默认值 */ }
  return Math.ceil(maxContextTokens * keepRecentRatio);
}

function compactPlan(pairDir, safeBudget) {
  const msgPath = path.join(pairDir, 'messages.jsonl');
  const archiveDir = path.join(pairDir, 'archive');
  if (!fs.existsSync(msgPath)) return null;

  const parse = (fp) => fs.readFileSync(fp, 'utf-8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const allMessages = [];
  const seenIds = new Set();
  let archiveFiles = [];

  if (fs.existsSync(archiveDir)) {
    archiveFiles = fs.readdirSync(archiveDir)
      .filter(f => /^history_\d+\.jsonl$/.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
    for (const f of archiveFiles) allMessages.push(...parse(path.join(archiveDir, f)));
  }
  allMessages.push(...parse(msgPath));
  if (allMessages.length === 0) return null;

  const deduped = [];
  for (const m of allMessages) {
    const id = m.message_id || JSON.stringify(m);
    if (!seenIds.has(id)) { seenIds.add(id); deduped.push(m); }
  }
  const dups = allMessages.length - deduped.length;

  let accumulated = 0, splitIdx = deduped.length;
  for (let i = deduped.length - 1; i >= 0; i--) {
    let t = estimateTokens(deduped[i].content || '');
    if (deduped[i].reasoning_content) t += estimateTokens(deduped[i].reasoning_content);
    if (accumulated + t > safeBudget * 1.5 && accumulated > 0) break;
    accumulated += t;
    splitIdx = i;
  }
  while (splitIdx > 0 && splitIdx < deduped.length) {
    const atSplit = deduped[splitIdx];
    if (atSplit.role === 'tool') {
      let found = false;
      for (let j = splitIdx - 1; j >= 0; j--) {
        const mj = deduped[j];
        if (mj.role === 'agent' && mj.tool_calls?.length) { splitIdx = j; found = true; break; }
        if ((mj.role === 'agent' && !mj.tool_calls?.length) || mj.agent_id === 'user') break;
      }
      if (!found) break;
    } else break;
  }
  splitIdx = Math.max(0, splitIdx);

  return { archiveFiles, before: allMessages.length, dups,
    recent: deduped.slice(splitIdx), archived: deduped.slice(0, splitIdx), backup: allMessages };
}

function compactApply(pairDir, plan) {
  const msgPath = path.join(pairDir, 'messages.jsonl');
  const archiveDir = path.join(pairDir, 'archive');

  const backupDir = path.join(pairDir, 'backup');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(backupDir, `cleanup_${ts}.jsonl`),
    plan.backup.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf-8');

  for (const f of plan.archiveFiles) fs.unlinkSync(path.join(archiveDir, f));
  if (plan.archived.length > 0) {
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, 'history_1.jsonl'),
      plan.archived.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
  }
  fs.writeFileSync(msgPath, plan.recent.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
}

function cmdCompact() {
  const safeBudget = compactTokenConfig();

  const pairs = [];
  if (pairArg) {
    const [a, b] = pairArg;
    const [lo, hi] = [a, b].sort();
    const dir = path.join(SESSIONS, lo, hi);
    if (fs.existsSync(dir)) pairs.push({ dir, name: `${lo}/${hi}` });
  } else {
    for (const agentDir of fs.readdirSync(SESSIONS, { withFileTypes: true }).filter(e => e.isDirectory())) {
      for (const cpDir of fs.readdirSync(path.join(SESSIONS, agentDir.name), { withFileTypes: true }).filter(e => e.isDirectory())) {
        const dir = path.join(SESSIONS, agentDir.name, cpDir.name);
        if (fs.existsSync(path.join(dir, 'archive'))) pairs.push({ dir, name: `${agentDir.name}/${cpDir.name}` });
      }
    }
  }

  let touched = 0, totalBefore = 0, totalAfter = 0, totalDups = 0;
  for (const { dir, name } of pairs) {
    const plan = compactPlan(dir, safeBudget);
    if (!plan) continue;
    const archiveCount = fs.readdirSync(path.join(dir, 'archive')).filter(f => /^history_\d+\.jsonl$/.test(f)).length;
    if (archiveCount <= 1 && plan.dups === 0) continue;

    touched++;
    const action = plan.archived.length
      ? `保留 ${plan.recent.length} 条 → messages.jsonl, 归档 ${plan.archived.length} 条 → history_1.jsonl`
      : `保留 ${plan.recent.length} 条（无早期消息归档）`;
    console.log(`[${name}] ${plan.before} 条, 去重 ${plan.dups}, ${action}`);
    if (FIX) compactApply(dir, plan);
    totalBefore += plan.before;
    totalAfter += plan.recent.length;
    totalDups += plan.dups;
  }

  console.log(`\n[compact] 涉及 ${touched} 个会话对 | 压缩前 ${totalBefore} 条, 压缩后 ${totalAfter} 条, 去重 ${totalDups} 条` +
    (FIX ? '' : '（预览，加 --fix 执行）'));
}

// ============================================================
// ============================================================
// 子命令：migrate —— 一次性数据迁移（角色归一化，幂等）
//
// 2026-08-02：运行时兼容逻辑（loadHistory 的 user/assistant→agent、
// trigger+tool_call_id→tool）下沉为一次性迁移，清理后从热路径移除。
// 覆盖 sessions + groups 的 messages.jsonl 与归档 history_*.jsonl。
// ============================================================

function cmdMigrate() {
  let normed = 0, repaired = 0, touched = 0;
  for (const dirName of SCAN_DIRS) {
    for (const file of collectMessageFiles(path.join(ROOT, dirName))) {
      const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      if (!lines.length) continue;
      let fileChanged = false;
      const out = lines.map((line) => {
        try {
          const m = JSON.parse(line);
          let changed = false;
          // 旧数据归一化：user/assistant → agent（agent_id 保留，视角由 provider 解析）
          if (m.role === 'user' || m.role === 'assistant') { m.role = 'agent'; changed = true; normed++; }
          // 历史损坏修复：trigger + tool_call_id → tool（保证配对完整）
          if (m.role === 'trigger' && m.tool_call_id) { m.role = 'tool'; changed = true; repaired++; }
          if (changed) fileChanged = true;
          return changed ? JSON.stringify(m) : line;
        } catch { return line; }
      });
      if (fileChanged) {
        touched++;
        if (FIX) fs.writeFileSync(file, out.join('\n') + '\n', 'utf-8');
        else console.log(`  ${path.relative(ROOT, file).replace(/\\/g, '/')}（--fix 后执行）`);
      }
    }
  }
  console.log(`\n[migrate] user/assistant→agent: ${normed} | trigger+tool_call_id→tool: ${repaired} | 涉及文件: ${touched}` +
    (FIX ? '' : '（预览，加 --fix 执行）'));
}

// ============================================================
// 子命令：all / help / dispatch
// ============================================================

function usage() {
  console.log(`会话数据维护工具箱 session-maint.js

用法：
  node scripts/session-maint.js <命令> [--fix] [--pair a/b]

命令：
  scan     消息健康检查 + 修复（孤儿 tool / 悬空 assistant / 空 assistant / trigger 误标 tool）
  aa       A→A 自对话消息历史清理（保留 memory.md）
  compact  归档压缩（去重 + token 预算截断 + 备份 + 重建）
  migrate  一次性数据迁移（旧 user/assistant→agent；trigger+tool_call_id→tool）
  all      依次执行 scan → aa → compact

参数：
  --fix       执行修改（默认只读预览）
  --pair a/b  compact 限定会话对

示例：
  node scripts/session-maint.js scan --fix
  node scripts/session-maint.js aa --fix
  node scripts/session-maint.js migrate --fix
  node scripts/session-maint.js compact --pair agent_chat_dev/user --fix
  node scripts/session-maint.js all --fix`);
}

switch (CMD) {
  case 'scan': cmdScan(); break;
  case 'aa': cmdAa(); break;
  case 'compact': cmdCompact(); break;
  case 'migrate': cmdMigrate(); break;
  case 'all':
    console.log('===== [1/3] scan =====');
    cmdScan();
    console.log('\n===== [2/3] aa =====');
    cmdAa();
    console.log('\n===== [3/3] compact =====');
    cmdCompact();
    break;
  default:
    usage();
    process.exit(CMD === 'help' ? 0 : 1);
}

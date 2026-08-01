// 扫描所有 messages.jsonl（sessions + groups），检测悬空消息
// 悬空类型：
//   1. orphan_tool      — role=tool，但其 tool_call_id 找不到前置匹配的 assistant.tool_calls
//   2. dangling_toolcalls — role=agent 带 tool_calls，但后续缺少对应的 role=tool 结果
// 用法：node scripts/scan-dangling.js [--fix]
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'workspace', 'default');
const SCAN_DIRS = ['sessions', 'groups'];
const FIX = process.argv.includes('--fix');

function collectMessageFiles(base) {
  const files = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'messages.jsonl') files.push(full);
    }
  })(base);
  return files;
}

function parse(msgs, file) {
  return msgs.map((l, i) => {
    try { const m = JSON.parse(l); m._idx = i; return m; }
    catch { console.log(`  [SKIP] ${file} 第 ${i} 行无法解析 JSON`); return null; }
  }).filter(Boolean);
}

function normId(id) {
  if (!id) return '';
  return id.replace(/^call_/, '');
}

/**
 * 镜像 history.ts loadHistory 语义：
 * role='trigger' 但带 tool_call_id → 实为被误标为 trigger 的 tool 结果，按 tool 处理。
 */
function effectiveRole(m) {
  return (m.role === 'trigger' && m.tool_call_id) ? 'tool' : m.role;
}

function analyze(msgs) {
  const orphanTools = new Set();
  const danglingAssistants = new Set();

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];

    // 孤儿 tool：向前找最近的 agent tool_calls（跨 user/error/system 则中断）
    if (effectiveRole(m) === 'tool') {
      const tcId = normId(m.tool_call_id || '');
      let found = false;
      for (let j = i - 1; j >= 0; j--) {
        const prev = msgs[j];
        if (prev.role === 'agent' && prev.tool_calls?.length) {
          for (const tc of prev.tool_calls) {
            if (normId(tc.id) === tcId) { found = true; break; }
          }
          if (found) break;
        }
        if (prev.role === 'user' || prev.role === 'error' || prev.role === 'system') break;
      }
      if (!found) orphanTools.add(i);
    }

    // 悬空 assistant：tool_calls 有未获 tool 结果的
    if (m.role === 'agent' && m.tool_calls?.length) {
      const required = new Set(m.tool_calls.map(tc => normId(tc.id)));
      let foundCount = 0;
      for (let j = i + 1; j < msgs.length; j++) {
        if (msgs[j].role === 'user' || msgs[j].role === 'error' || msgs[j].role === 'system') break;
        if (effectiveRole(msgs[j]) === 'tool' && required.has(normId(msgs[j].tool_call_id || ''))) {
          foundCount++;
          required.delete(normId(msgs[j].tool_call_id || ''));
        }
      }
      if (foundCount < m.tool_calls.length) danglingAssistants.add(i);
    }
  }
  return { orphanTools, danglingAssistants };
}

let totalOrphan = 0, totalDangling = 0, totalRepaired = 0, touched = 0;

for (const dirName of SCAN_DIRS) {
  const files = collectMessageFiles(path.join(ROOT, dirName));
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    if (!raw.length) continue;
    const msgs = parse(raw, file);
    const { orphanTools, danglingAssistants } = analyze(msgs);

    // 悬空 assistant 附带删除其后续孤儿 tool（与 clean-orphans.js 一致）
    const removeSet = new Set([...orphanTools]);
    for (const idx of danglingAssistants) {
      removeSet.add(idx);
      const m = msgs[idx];
      const ids = new Set(m.tool_calls.map(tc => normId(tc.id)));
      for (let j = idx + 1; j < msgs.length; j++) {
        if (msgs[j].agent_id === 'user' || removeSet.has(j)) break;
        if (effectiveRole(msgs[j]) === 'tool' && ids.has(normId(msgs[j].tool_call_id || ''))) removeSet.add(j);
      }
    }

    // 统计需要修复的"trigger 误标 tool"（归档重建时内容含 <trigger> 的 tool 结果被改写为 trigger）
    const repairIdxs = [];
    for (let i = 0; i < msgs.length; i++) {
      if (!removeSet.has(i) && msgs[i].role === 'trigger' && msgs[i].tool_call_id) repairIdxs.push(i);
    }

    if (removeSet.size === 0 && repairIdxs.length === 0) continue;
    touched++;

    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const orphanIdx = [...orphanTools].map(i => '#' + i).join(',');
    const danglingIdx = [...danglingAssistants].map(i => '#' + i).join(',');
    const repairIdx = repairIdxs.map(i => '#' + i).join(',');
    console.log(`${rel}`);
    if (orphanTools.size) console.log(`   孤儿 tool: ${orphanIdx}  (${orphanTools.size} 条)`);
    if (danglingAssistants.size) console.log(`   悬空 tool_calls assistant: ${danglingIdx}  (${danglingAssistants.size} 条)`);
    if (repairIdxs.length) console.log(`   trigger 误标 tool（待修复为 role=tool）: ${repairIdx}  (${repairIdxs.length} 条)`);

    totalOrphan += orphanTools.size;
    totalDangling += danglingAssistants.size;
    totalRepaired += repairIdxs.length;

    if (FIX) {
      const out = raw.map((line, i) => {
        if (removeSet.has(i)) return null; // 删除
        if (repairIdxs.includes(i)) {       // trigger+tool_call_id → tool（修复配对）
          try {
            const m = JSON.parse(line);
            m.role = 'tool';
            return JSON.stringify(m);
          } catch { return line; }
        }
        return line;
      }).filter(Boolean);
      fs.writeFileSync(file, out.join('\n') + '\n', 'utf-8');
      console.log(`   → 已处理: ${raw.length} -> ${out.length} 行（修复 ${repairIdxs.length} 条 trigger→tool，删除 ${removeSet.size} 条）`);
    }
  }
}

console.log(`\n===== 扫描完成 =====`);
console.log(`孤儿 tool: ${totalOrphan} | 悬空 assistant: ${totalDangling} | trigger→tool 待修复: ${totalRepaired} | 涉及文件: ${touched}`);
console.log(FIX ? '(已执行修复+清理 --fix)' : '(只读扫描，加 --fix 执行修复+清理)');

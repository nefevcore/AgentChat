const fs = require('fs');
const path = require('path');

const SESSIONS = 'C:/Users/xiaofeng/Documents/Dev/AgentChat/workspace/default/sessions';
const MAX_TOKENS = 1_000_000;
const KEEP_RATIO = 0.025;
const safeBudget = Math.ceil(MAX_TOKENS * KEEP_RATIO);

function estimateTokens(text) {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) tokens += /[\u4e00-\u9fff]/.test(ch) ? 0.6 : 0.3;
  return Math.ceil(tokens);
}

function cleanupPair(pairDir) {
  const msgPath = path.join(pairDir, 'messages.jsonl');
  const archiveDir = path.join(pairDir, 'archive');
  if (!fs.existsSync(msgPath)) return 0;

  // Collect all messages
  let allMessages = [];
  const seenIds = new Set();

  function parse(filePath) {
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    const msgs = [];
    for (const line of lines) { try { msgs.push(JSON.parse(line)); } catch {} }
    return msgs;
  }

  // Archive files
  let archiveFiles = [];
  if (fs.existsSync(archiveDir)) {
    archiveFiles = fs.readdirSync(archiveDir)
      .filter(f => /^history_\d+\.jsonl$/.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
    for (const f of archiveFiles) {
      allMessages.push(...parse(path.join(archiveDir, f)));
    }
  }

  // Active messages
  allMessages.push(...parse(msgPath));

  if (allMessages.length === 0) return 0;

  // Dedup
  let deduped = [];
  for (const m of allMessages) {
    const id = m.message_id || JSON.stringify(m);
    if (!seenIds.has(id)) { seenIds.add(id); deduped.push(m); }
  }

  const dups = allMessages.length - deduped.length;
  const oldArchiveCount = archiveFiles.length;

  // Truncate from tail
  let accumulated = 0, splitIdx = deduped.length;
  for (let i = deduped.length - 1; i >= 0; i--) {
    let msgTokens = estimateTokens(deduped[i].content || '');
    if (deduped[i].reasoning_content) msgTokens += estimateTokens(deduped[i].reasoning_content);
    if (accumulated + msgTokens > safeBudget * 1.5 && accumulated > 0) break;
    accumulated += msgTokens;
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

  const recent = deduped.slice(splitIdx);
  const archiveMsgs = deduped.slice(0, splitIdx);

  // Backup
  const backupDir = path.join(pairDir, 'backup');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `cleanup_${ts}.jsonl`);
  fs.writeFileSync(backupFile, allMessages.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf-8');

  // Remove old archives
  for (const f of archiveFiles) {
    fs.unlinkSync(path.join(archiveDir, f));
  }

  // Write new archive
  if (archiveMsgs.length > 0) {
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, 'history_1.jsonl'), archiveMsgs.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
  }

  // Write messages.jsonl
  fs.writeFileSync(msgPath, recent.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf-8');

  return { before: allMessages.length, dups, after: recent.length, archiveFiles: oldArchiveCount };
}

// Find all pairs with archive dirs
let cleaned = 0, totalBefore = 0, totalAfter = 0, totalDups = 0, totalArchives = 0;
const agentDirs = fs.readdirSync(SESSIONS, { withFileTypes: true }).filter(e => e.isDirectory());
for (const agentDir of agentDirs) {
  const counterpartDirs = fs.readdirSync(path.join(SESSIONS, agentDir.name), { withFileTypes: true }).filter(e => e.isDirectory());
  for (const cpDir of counterpartDirs) {
    const pairDir = path.join(SESSIONS, agentDir.name, cpDir.name);
    const archiveDir = path.join(pairDir, 'archive');
    if (!fs.existsSync(archiveDir)) continue;
    const archiveFiles = fs.readdirSync(archiveDir).filter(f => /^history_\d+\.jsonl$/.test(f));
    if (archiveFiles.length <= 1) continue; // skip already clean

    const r = cleanupPair(pairDir);
    if (r) {
      cleaned++;
      totalBefore += r.before;
      totalAfter += r.after;
      totalDups += r.dups;
      totalArchives += r.archiveFiles;
      console.log(`${agentDir.name}/${cpDir.name}: ${r.archiveFiles} archives, ${r.before} msgs (${r.dups} dups) → ${r.after} recent`);
    }
  }
}

console.log(`\n=== Done: ${cleaned} pairs ===`);
console.log(`Total: ${totalBefore} msgs (${totalDups} dups) → ${totalAfter} recent, ${totalArchives} old archives removed`);

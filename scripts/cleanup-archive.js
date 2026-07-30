const fs = require('fs');
const path = require('path');

// ── 配置 ──
const SESSIONS = 'C:/Users/xiaofeng/Documents/Dev/AgentChat/workspace/default/sessions';
const pair = 'agent_chat_dev/user'; // target pair

// 对 Canonical 路径：小写排序列 → 物理目录
const [lo, hi] = ['agent_chat_dev', 'user'].sort();
const pairDir = path.join(SESSIONS, lo, hi);
const msgPath = path.join(pairDir, 'messages.jsonl');
const archiveDir = path.join(pairDir, 'archive');

if (!fs.existsSync(msgPath)) { console.log('no messages.jsonl'); process.exit(0); }

// ── 1. 收集所有消息（按时间线：旧→新）──
console.log('Collecting messages...');

// 1a. 归档文件（history_1 → history_N，数字越大越旧）
let archiveFiles = [];
if (fs.existsSync(archiveDir)) {
  archiveFiles = fs.readdirSync(archiveDir)
    .filter(f => /^history_\d+\.jsonl$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/^history_(\d+)\.jsonl$/)[1], 10);
      const nb = parseInt(b.match(/^history_(\d+)\.jsonl$/)[1], 10);
      return na - nb; // 升序：1, 2, 3...
    });
}

let allMessages = [];
const seenIds = new Set();

function parseMessages(filePath, source) {
  const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
  let msgs = [];
  for (const line of lines) {
    try {
      const m = JSON.parse(line);
      msgs.push(m);
    } catch { /* skip */ }
  }
  return msgs;
}

// 归档：旧→新顺序（history_1 最旧）
for (const f of archiveFiles) {
  const fp = path.join(archiveDir, f);
  const msgs = parseMessages(fp, f);
  allMessages.push(...msgs);
}

// messages.jsonl 是最新的
const activeMsgs = parseMessages(msgPath, 'messages.jsonl');
allMessages.push(...activeMsgs);

console.log(`Total messages: ${allMessages.length}`);

// ── 2. 去重（跨归档重叠部分）──
let deduped = [];
for (const m of allMessages) {
  const id = m.message_id || JSON.stringify(m);
  if (seenIds.has(id)) {
    // skip duplicate (caused by overlapping archives)
  } else {
    seenIds.add(id);
    deduped.push(m);
  }
}

const dups = allMessages.length - deduped.length;
console.log(`After dedup: ${deduped.length} messages (removed ${dups} duplicates)`);

// ── 3. Token 估算（复用 agent-session 的逻辑）──
function estimateTokens(text) {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    tokens += /[\u4e00-\u9fff]/.test(ch) ? 0.6 : 0.3;
  }
  return Math.ceil(tokens);
}

// ── 4. 尾部截断──
const MAX_TOKENS = 1_000_000; // maxContextTokens
const KEEP_RATIO = 0.025;      // keepRecentRatio
const safeBudget = Math.ceil(MAX_TOKENS * KEEP_RATIO);

// 从尾部向前累积
let accumulated = 0;
let splitIdx = deduped.length;
for (let i = deduped.length - 1; i >= 0; i--) {
  let msgTokens = estimateTokens(deduped[i].content || '');
  if (deduped[i].reasoning_content) msgTokens += estimateTokens(deduped[i].reasoning_content);
  if (accumulated + msgTokens > safeBudget * 1.5 && accumulated > 0) break;
  accumulated += msgTokens;
  splitIdx = i;
}

// tool-call/response 安全边界
while (splitIdx > 0 && splitIdx < deduped.length) {
  const atSplit = deduped[splitIdx];
  if (atSplit.role === 'tool') {
    let foundAgent = false;
    for (let j = splitIdx - 1; j >= 0; j--) {
      const mj = deduped[j];
      if (mj.role === 'agent' && mj.tool_calls?.length) { splitIdx = j; foundAgent = true; break; }
      if ((mj.role === 'agent' && !mj.tool_calls?.length) || mj.agent_id === 'user') break;
    }
    if (!foundAgent) break;
  } else break;
}
splitIdx = Math.max(0, splitIdx);

const recent = deduped.slice(splitIdx);
const archiveMsgs = deduped.slice(0, splitIdx);

console.log(`Truncate: keep ${recent.length} recent, archive ${archiveMsgs.length} early messages`);
console.log(`Recent ~${accumulated} tokens (budget: ${safeBudget})`);

// ── 5. 备份旧数据 ──
const backupDir = path.join(pairDir, 'backup');
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(backupDir, `cleanup_${ts}.jsonl`);
const backup = allMessages.map(m => JSON.stringify(m)).join('\n') + '\n';
fs.writeFileSync(backupFile, backup, 'utf-8');
console.log(`Backup: ${backupFile} (${allMessages.length} messages)`);

// ── 6. 重建 ──
// 删除旧的归档文件
for (const f of archiveFiles) {
  fs.unlinkSync(path.join(archiveDir, f));
}
console.log(`Removed ${archiveFiles.length} old archive files`);

// 写入新的归档文件（合并所有旧消息）
if (archiveMsgs.length > 0) {
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
  const newArchive = path.join(archiveDir, 'history_1.jsonl');
  const content = archiveMsgs.map(m => JSON.stringify(m)).join('\n') + '\n';
  fs.writeFileSync(newArchive, content, 'utf-8');
  console.log(`New archive: history_1.jsonl (${archiveMsgs.length} messages)`);
}

// 写入新的 messages.jsonl
const newActive = recent.map(m => JSON.stringify(m)).join('\n') + '\n';
fs.writeFileSync(msgPath, newActive, 'utf-8');
console.log(`New messages.jsonl: ${recent.length} messages`);

// ── 7. 摘要 ──
console.log('\n=== Cleanup complete ===');
console.log(`Before: ${archiveFiles.length} archive files (${allMessages.length} total msgs incl ${dups} dups)`);
console.log(`After:  ${archiveMsgs.length > 0 ? '1' : '0'} archive file + messages.jsonl (${recent.length} msgs)`);
console.log(`Backup saved to: ${backupFile}`);

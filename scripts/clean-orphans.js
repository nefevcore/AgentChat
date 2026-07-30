const fs = require('fs');
const path = require('path');

const SESSIONS = 'C:/Users/xiaofeng/Documents/Dev/AgentChat/workspace/default/sessions';

function isOrphanTool(msgs, i) {
  const m = msgs[i];
  if (m.role !== 'tool') return false;
  const tcId = m.tool_call_id;
  for (let j = i - 1; j >= 0; j--) {
    const prev = msgs[j];
    if (prev.role === 'agent' && prev.tool_calls) {
      for (const tc of prev.tool_calls) {
        if (tc.id === tcId || 'call_' + tc.id === tcId || tc.id === tcId?.replace('call_', '')) return false;
      }
    }
    if (prev.agent_id === 'user' || prev.role === 'error' || prev.role === 'system') return true;
  }
  return true;
}

function isDanglingAssistant(msgs, i) {
  const m = msgs[i];
  if (m.role !== 'agent' || !m.tool_calls?.length) return false;
  for (const tc of m.tool_calls) {
    let found = false;
    for (let j = i + 1; j < msgs.length; j++) {
      if (msgs[j].role === 'tool' && msgs[j].tool_call_id === tc.id) { found = true; break; }
      if (msgs[j].agent_id === 'user') break;
    }
    if (!found) return true;
  }
  return false;
}

// Find all pairs
let totalRemoved = 0, totalPairs = 0;
const agentDirs = fs.readdirSync(SESSIONS, { withFileTypes: true }).filter(e => e.isDirectory());
for (const agentDir of agentDirs) {
  const counterparts = fs.readdirSync(path.join(SESSIONS, agentDir.name), { withFileTypes: true })
    .filter(e => e.isDirectory());
  for (const cpDir of counterparts) {
    const msgPath = path.join(SESSIONS, agentDir.name, cpDir.name, 'messages.jsonl');
    if (!fs.existsSync(msgPath)) continue;

    const lines = fs.readFileSync(msgPath, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) continue;

    const msgs = lines.map((l, i) => { try { const m = JSON.parse(l); m._idx = i; return m; } catch { return null; } }).filter(Boolean);
    
    const removeSet = new Set();
    for (let i = 0; i < msgs.length; i++) {
      if (isOrphanTool(msgs, i)) removeSet.add(msgs[i]._idx);
      if (isDanglingAssistant(msgs, i)) removeSet.add(msgs[i]._idx);
    }

    if (removeSet.size === 0) continue;

    // Dangling assistant: also remove any orphan tools between it and next user
    // (The tool messages that belong to the dangling assistant)
    for (const idx of [...removeSet].sort((a,b) => a-b)) {
      const m = msgs.find(x => x._idx === idx);
      if (m?.role === 'agent' && m.tool_calls?.length) {
        // Remove all tool messages between this assistant and the next user/end
        for (let j = idx + 1; j < msgs.length; j++) {
          if (msgs[j].agent_id === 'user' || removeSet.has(msgs[j]._idx)) break;
          if (msgs[j].role === 'tool' && m.tool_calls.some(tc => tc.id === msgs[j].tool_call_id)) {
            removeSet.add(msgs[j]._idx);
          }
        }
      }
    }

    // Write cleaned file
    const cleaned = lines.filter((_, i) => !removeSet.has(i));
    fs.writeFileSync(msgPath, cleaned.join('\n') + '\n', 'utf-8');

    totalPairs++;
    totalRemoved += removeSet.size;
    const pairName = agentDir.name + '/' + cpDir.name;
    console.log(pairName + ': removed ' + removeSet.size + ' orphan messages (' + lines.length + ' -> ' + cleaned.length + ')');
  }
}

console.log('\nDone: ' + totalPairs + ' pairs cleaned, ' + totalRemoved + ' orphans removed');

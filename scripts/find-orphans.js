const fs = require('fs');
const path = 'C:/Users/xiaofeng/Documents/Dev/AgentChat/workspace/default/sessions/agent_chat_dev/user/messages.jsonl';

const lines = fs.readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
const msgs = lines.map((l, i) => { try { const m = JSON.parse(l); m._idx = i; return m; } catch { return null; } }).filter(Boolean);

let orphans = [];

for (let i = 0; i < msgs.length; i++) {
  const m = msgs[i];
  if (m.role === 'tool') {
    const tcId = m.tool_call_id;
    let found = false;
    for (let j = i - 1; j >= 0; j--) {
      const prev = msgs[j];
      if (prev.role === 'agent' && prev.tool_calls) {
        for (const tc of prev.tool_calls) {
          if (tc.id === tcId || 'call_' + tc.id === tcId || tc.id === tcId?.replace('call_', '')) {
            found = true; break;
          }
        }
        if (found) break;
      }
      if (prev.agent_id === 'user' || prev.role === 'error' || prev.role === 'system') break;
    }
    if (!found) orphans.push({ type: 'orphan_tool', idx: i, msg: m });
  }
  if (m.role === 'agent' && m.tool_calls?.length) {
    let allFound = true;
    for (const tc of m.tool_calls) {
      let found = false;
      for (let j = i + 1; j < msgs.length; j++) {
        if (msgs[j].role === 'tool' && msgs[j].tool_call_id === tc.id) { found = true; break; }
        if (msgs[j].agent_id === 'user') break;
      }
      if (!found) allFound = false;
    }
    if (!allFound) orphans.push({ type: 'dangling_toolcalls', idx: i, msg: m });
  }
}

console.log('Total messages:', msgs.length);
console.log('Orphans found:', orphans.length);
orphans.forEach(o => {
  const c = (o.msg.content || '').substring(0, 80).replace(/\n/g, '\\n');
  console.log('  [#' + o.idx + '] ' + o.type + ': role=' + o.msg.role + ' content=' + c);
});

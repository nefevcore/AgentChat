import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3830/ws');
ws.on('open', () => {
  console.log('[ws] open');
  ws.send(JSON.stringify({
    type: 'chat.send',
    data: { to: 'test', content: '（修复验证）请直接回复「OK」即可。' },
  }));
});
ws.on('message', (d) => {
  try {
    const j = JSON.parse(String(d));
    if (j.type === 'chat.end') console.log('[ws] chat.end');
  } catch { /* ignore */ }
});
ws.on('error', (e) => console.error('[ws] error', e.message));
setTimeout(() => { try { ws.close(); } catch { /* ignore */ } process.exit(0); }, 25000);

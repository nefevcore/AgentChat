// ============================================================
// shell-receiver.helper.ts —— M4.4 级联验收的壳接收端（真子进程）。
// 形态 = 最小壳 ipc 半边：监听 socket → 收信封 → requestId 幂等 →
// 落账（received.jsonl）→ 回 ack。node --experimental-strip-types 直跑。
// 用法：node shell-receiver.helper.ts <sockPath> <agentDir>
// ============================================================
import * as net from 'node:net';
import * as fs from 'node:fs';
import { AdmissionGate, FrameDecoder, encodeFrame, type Envelope } from '../node_modules/ac-envelope-core/src/index.ts';

const [sockPath, agentDir] = process.argv.slice(2);
if (process.argv.length < 4) {
  process.stderr.write('用法：shell-receiver.helper.ts <sockPath> <agentDir>');
  process.exit(2);
}
const gate = new AdmissionGate();
const server = net.createServer((socket) => {
  const decoder = new FrameDecoder();
  socket.on('data', (chunk: Buffer) => {
    let frames: unknown[];
    try {
      frames = decoder.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      const env = frame as Envelope;
      if (typeof env === 'object' && env.kind === 'message') {
        const fresh = gate.admit(env.requestId);
        if (fresh) {
          const payload = env.payload as { text?: string } | null;
          fs.appendFileSync(agentDir + '/received.jsonl', JSON.stringify({
            requestId: env.requestId, fresh, sender: env.sender, text: payload?.text ?? '',
          }) + '\n');
        }
        socket.write(encodeFrame({ ack: env.requestId, fresh }));
      }
    }
  });
  socket.on('error', () => socket.destroy());
});
server.listen(sockPath, () => process.stdout.write('ready\n'));

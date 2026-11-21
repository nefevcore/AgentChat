// ============================================================
// orchestrator-takeover-events.test.ts —— 接管 ≠ 壳重启（cr-1182 修正）
//
// adoptLiveShells 的首拉是**接管活壳**（socket-only 句柄，壳进程一直在跑——
// 保壳保 run 的语义）。它不产生 shell-start 事件：告知 Agent「你的壳重启、
// 进程内状态已重置」是假信息，会诱使它重做在途工作。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createOrchestrator } from '../orchestrator.ts';
import { PostOffice, ReachabilityTable } from 'ac-post-office';
import { listenIpc, socketPathFor } from 'ac-envelope-core';
import { readSystemEventsSince } from 'ac-system-events';

const ROOT = path.join('sandbox', 'test-orch-takeover-' + process.pid);

afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('接管活壳不记 shell-start（cr-1182）', () => {
  it('adoptLiveShells 接管 → 无 shell-start 事件（壳没死，不是重启）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const reach = new ReachabilityTable();
    const liveHint = socketPathFor(path.resolve(ROOT), 'takeover-live');
    const liveServer = await listenIpc(liveHint, () => undefined);
    const liveDir = path.join(ROOT, 'agents', 'keepalive');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(path.join(liveDir, 'activation.lock'), JSON.stringify({
      pid: process.pid, bootId: 'b-live', acquiredAt: new Date().toISOString(),
      transportHint: liveHint,
    }), 'utf-8');
    const orch = createOrchestrator({
      dataRoot: ROOT, catalogFile: 'c.json', bootFile: 'b.ts', postOffice: po, reach,
      adopt: async () => { throw new Error('接管面不得 spawn'); },
    });
    try {
      expect(await orch.adoptLiveShells()).toBe(1);
      // 句柄入池（接管成功）
      expect(orch.handles().get('keepalive')).toBeDefined();
      // 但没有 shell-start——壳进程没死
      const events = readSystemEventsSince(ROOT, 0).filter((e) => e.kind === 'shell-start');
      expect(events).toHaveLength(0);
    } finally {
      await liveServer.close();
      orch.close();
    }
  });
});

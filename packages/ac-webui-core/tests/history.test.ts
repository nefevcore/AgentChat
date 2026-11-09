// ============================================================
// M7.1 历史读纯库单测：watch 双平台（增量读与列表扫描已随 cr-957 删除）
// ============================================================
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { watchLedger } from '../src/history.ts';
import { LedgerWriter, sessionDir } from 'ac-ledger';

const ROOT = path.join('sandbox', 'test-webui-' + process.pid);

function cleanup(): void {
  fs.rmSync(ROOT, { recursive: true, force: true });
}


describe('M7.1 watchLedger', () => {
  it('追加触发回调（debounce 后）+ close 停止', async () => {
    cleanup();
    const dir = sessionDir(ROOT, 'delta', 'u-watch');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), '');
    let fired = 0;
    const h = watchLedger(dir, () => fired++);
    await new Promise((r) => setTimeout(r, 100)); // watch 就位
    fs.appendFileSync(path.join(dir, 'messages.jsonl'), '{"role":"agent","content":"x","agent_id":"user"}\n');
    await new Promise((r) => setTimeout(r, 300));
    expect(fired).toBe(1);
    h.close();
    // close 后再追加不触发
    fs.appendFileSync(path.join(dir, 'messages.jsonl'), '{"role":"agent","content":"y","agent_id":"user"}\n');
    await new Promise((r) => setTimeout(r, 300));
    expect(fired).toBe(1);
  });
});

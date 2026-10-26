// ============================================================
// ac-plugin-core/tests/audit-rotate.test.ts —— M24 X5：audit.jsonl 轮转
//   · 写前大小检查：超 5 MiB → .1（→ .2，保留 2 份）
//   · readAudit 只读当前份（历史份不进 RPC 面）
//   · 未超上限零操作（幂等）
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendAudit,
  auditFile,
  readAudit,
  AUDIT_ROTATE_MAX_BYTES,
  rotateAuditIfLarge,
  type PluginAuditEntry,
} from '../src/audit.ts';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ac-audit-rot-'));
}

const entry = (n: number): PluginAuditEntry => ({
  ts: `2026-08-30T00:00:${String(n).padStart(2, '0')}.000Z`,
  event: 'load',
  name: `p${n}`,
  outcome: 'loaded',
});

describe('audit 轮转（M24 X5）', () => {
  it('超上限轮转：.1 → .2（保留 2 份），readAudit 只读当前份', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
    const file = auditFile(root);
    // 预置三份：当前（超限）+ .1 + .2
    fs.writeFileSync(file, 'X'.repeat(AUDIT_ROTATE_MAX_BYTES + 1), 'utf-8');
    fs.writeFileSync(`${file}.1`, 'OLD1', 'utf-8');
    fs.writeFileSync(`${file}.2`, 'OLD2', 'utf-8');

    expect(rotateAuditIfLarge(root)).toBe(true);
    expect(fs.existsSync(file)).toBe(false); // 当前份已改名走
    expect(fs.readFileSync(`${file}.1`, 'utf-8')).toBe('X'.repeat(AUDIT_ROTATE_MAX_BYTES + 1));
    expect(fs.readFileSync(`${file}.2`, 'utf-8')).toBe('OLD1'); // 旧 .2 丢弃

    // 新当前份重建；readAudit 只读当前份（历史份不混入）
    fs.writeFileSync(file, `${JSON.stringify(entry(1))}\n`, 'utf-8');
    const rows = readAudit(root);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('p1');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('appendAudit 写前轮转（串行队列内）+ 未超上限零操作', async () => {
    const root = tmpRoot();
    await appendAudit(root, entry(1));
    await appendAudit(root, entry(2));
    const file = auditFile(root);
    expect(fs.existsSync(`${file}.1`)).toBe(false); // 未超上限：不轮转
    expect(fs.readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(2);

    // 撑爆当前份 → 下一次 append 前轮转
    fs.appendFileSync(file, 'Y'.repeat(AUDIT_ROTATE_MAX_BYTES), 'utf-8');
    await appendAudit(root, entry(3));
    expect(fs.existsSync(`${file}.1`)).toBe(true); // 旧当前份 → .1
    expect(fs.readFileSync(`${file}.1`, 'utf-8')).toContain('"p2"');
    expect(fs.readFileSync(file, 'utf-8')).toContain('"p3"'); // 新当前份只有 p3
    fs.rmSync(root, { recursive: true, force: true });
  });
});

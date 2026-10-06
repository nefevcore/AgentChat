// ============================================================
// ac-harness-tools —— runKey 映射表单测（临时目录，零真 harness）
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readSessions, recordSession, sessionRunKeyOf } from '../src/sessions.ts';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sessions-'));
});

describe('runKey 映射表', () => {
  it('记录后可查：同会话同网关返回 runKey', () => {
    recordSession(dir, 'conv-1', { gateway: 'claude-code', runKey: 's-1', ts: 1 });
    expect(sessionRunKeyOf(dir, 'conv-1', 'claude-code')).toBe('s-1');
  });

  it('网关切换不续接（claude 凭据对 codex 不可用）', () => {
    recordSession(dir, 'conv-1', { gateway: 'claude-code', runKey: 's-1', ts: 1 });
    expect(sessionRunKeyOf(dir, 'conv-1', 'codex')).toBeUndefined();
  });

  it('无会话/无记录 → undefined；损坏文件 → 空表降级', () => {
    expect(sessionRunKeyOf(dir, undefined, 'claude-code')).toBeUndefined();
    expect(sessionRunKeyOf(dir, 'conv-x', 'claude-code')).toBeUndefined();
    fs.mkdirSync(path.join(dir, 'harness'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'harness', 'sessions.json'), '<<<损坏>>>', 'utf-8');
    expect(readSessions(dir)).toEqual({});
  });

  it('覆盖语义：同会话重写（上次成功凭据被新 run 顶替）', () => {
    recordSession(dir, 'conv-1', { gateway: 'claude-code', runKey: 's-1', ts: 1 });
    recordSession(dir, 'conv-1', { gateway: 'claude-code', runKey: 's-2', ts: 2 });
    expect(sessionRunKeyOf(dir, 'conv-1', 'claude-code')).toBe('s-2');
    expect(Object.keys(readSessions(dir))).toEqual(['conv-1']);
  });
});
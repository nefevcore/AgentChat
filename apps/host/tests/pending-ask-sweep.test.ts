// ============================================================
// pending-ask-sweep.test.ts —— cr-734/735 待答提问拉壳扫描：children 域
// pending ask_questions → 父清单（纯扫描；拉起归 boot 延迟串行链）。
// last-wins 判态防假阳性。数据根恒 sandbox 独立目录（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pendingAskParentIds } from '../boot.ts';

const ROOT = path.join('sandbox', 'test-pending-ask-' + process.pid);

beforeEach(() => { fs.mkdirSync(ROOT, { recursive: true }); });
afterEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

const writeAsk = (parent: string, child: string, lines: Array<Record<string, unknown>>): void => {
  const dir = path.join(ROOT, 'agents', parent, 'children', child);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'interactions.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
};

describe('pendingAskParentIds（cr-734/735）', () => {
  it('pending ask 命中 → 父清单恰一份（同父多子去重）', () => {
    writeAsk('papa', 'kid1', [{ id: 'i1', kind: 'ask_questions', state: 'pending', payload: {} }]);
    writeAsk('papa', 'kid2', [{ id: 'i2', kind: 'ask_questions', state: 'pending', payload: {} }]);
    expect(pendingAskParentIds(ROOT)).toEqual(['papa']);
  });

  it('last-wins：同 id 已 answered（追加行）不进清单；非 ask_questions 不进', () => {
    writeAsk('papa', 'kid1', [
      { id: 'i1', kind: 'ask_questions', state: 'pending', payload: {} },
      { id: 'i1', kind: 'ask_questions', state: 'answered', answer: { answers: ['A'] } },
    ]);
    writeAsk('mama', 'kid2', [{ id: 'j1', kind: 'approval', state: 'pending' }]);
    expect(pendingAskParentIds(ROOT)).toEqual([]);
  });

  it('无 children 域 / 无 interactions.jsonl：空清单', () => {
    fs.mkdirSync(path.join(ROOT, 'agents', 'solo'), { recursive: true });
    expect(pendingAskParentIds(ROOT)).toEqual([]);
  });
});

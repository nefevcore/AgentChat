// ============================================================
// source-view 授权词汇单测（cr-1166）：spec 判形 / sourceViewsOf 投影
// （grants ∪ denials / 非法 spec 忽略 / 路径组件拒绝）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSourceViewSpec, sourceViewsOf, hasSourceView, sourceViewDir } from '../src/source-view.ts';

const ROOT = path.join('sandbox', 'test-auth-sv-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function seedAuth(agentId: string, auth: unknown) {
  const dir = path.join(ROOT, 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth), 'utf-8');
}

describe('isSourceViewSpec', () => {
  it('合法 / 非法形态', () => {
    expect(isSourceViewSpec({ kind: 'source-view', source: 'fs', view: 'docs' })).toBe(true);
    expect(isSourceViewSpec({ kind: 'other', source: 'fs', view: 'docs' })).toBe(false);
    expect(isSourceViewSpec({ kind: 'source-view', source: '', view: 'docs' })).toBe(false);
    expect(isSourceViewSpec(undefined)).toBe(false);
  });
});

describe('sourceViewsOf', () => {
  it('inline grants 投影 + denials 生效 + 非法 spec 忽略 + 缺席空', () => {
    seedAuth('a1', {
      version: 1, agentId: 'a1',
      grants: [
        { inline: { kind: 'inline', spec: { kind: 'source-view', source: 'fs', view: 'docs' } } },
        { inline: { kind: 'inline', spec: { kind: 'source-view', source: 'wechat', view: 'news' } } },
        { inline: { kind: 'inline', spec: { kind: 'not-a-view', x: 1 } } },
      ],
      denials: [],
    });
    expect(sourceViewsOf(ROOT, 'a1')).toEqual([
      { source: 'fs', view: 'docs' },
      { source: 'wechat', view: 'news' },
    ]);
    // 吊销 fs/docs 后剩 wechat/news
    seedAuth('a1', {
      version: 1, agentId: 'a1',
      grants: [
        { inline: { kind: 'inline', spec: { kind: 'source-view', source: 'fs', view: 'docs' } } },
        { inline: { kind: 'inline', spec: { kind: 'source-view', source: 'wechat', view: 'news' } } },
      ],
      denials: [{ inline: { kind: 'inline', spec: { kind: 'source-view', source: 'fs', view: 'docs' } } }],
    });
    expect(sourceViewsOf(ROOT, 'a1')).toEqual([{ source: 'wechat', view: 'news' }]);
    expect(hasSourceView(ROOT, 'a1', 'wechat', 'news')).toBe(true);
    expect(hasSourceView(ROOT, 'a1', 'fs', 'docs')).toBe(false);
    // 无 auth.json = 无授权
    expect(sourceViewsOf(ROOT, 'nobody')).toEqual([]);
  });
});

describe('sourceViewDir', () => {
  it('路径组件拒绝', () => {
    expect(sourceViewDir('fs', 'docs')).toBe('fs/docs');
    expect(() => sourceViewDir('a/b', 'x')).toThrow();
    expect(() => sourceViewDir('fs', '..')).toThrow();
  });
});

// ============================================================
// preset-origin 单测（cr-812 copy-on-write）：指纹稳定性 + reconcile
// 四态（baseline 补记 / noop / follow 跟随 / notice 保留）。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PRESET_ID, templateFingerprint, originOf, readOrigin, writeOrigin, reconcilePresetOrigin,
} from '../src/preset-origin.ts';
import { materializeConfigOf } from '../src/preset-builtin.ts';
import type { AgentConfig } from 'ac-agents-core';

const tplConfig = { id: '__creator__', name: '创造模式', preset: true, rows: ['fs-tools', 'persona'] } as unknown as AgentConfig;
const tplDocs = [{ name: 'AGENTS.md', content: '# 指南 v1\n' }];
const tplV2Docs = [{ name: 'AGENTS.md', content: '# 指南 v2\n' }];

function mkDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'ac-preset-origin-')); }

describe('PRESET_ID 词形', () => {
  it('__key__ 命中；普通身份/子域不命中', () => {
    expect(PRESET_ID.exec('__creator__')?.[1]).toBe('creator');
    expect(PRESET_ID.exec('creator')).toBeNull();
    expect(PRESET_ID.exec('sub-abc~def')).toBeNull();
  });
});

describe('reconcilePresetOrigin 四态', () => {
  it('origin 缺席 → baseline：补记现状指纹（不回写内容）', () => {
    const live = materializeConfigOf(tplConfig, '__creator__');
    const r = reconcilePresetOrigin({ agentId: '__creator__', templateKey: 'creator', liveConfig: live, liveDocs: { 'AGENTS.md': '# 用户已改\n' }, origin: undefined, currentTemplate: { config: tplConfig, docs: tplDocs } });
    expect('baseline' in r).toBe(true);
    if ('baseline' in r) { expect(r.baseline.template).toBe('creator'); expect(r.baseline.docs?.['AGENTS.md']).toBeTruthy(); }
  });

  it('模板指纹未变 → noop', () => {
    const live = materializeConfigOf(tplConfig, '__creator__');
    const origin = originOf('creator', templateFingerprint({ config: tplConfig, docs: tplDocs }), live, tplDocs);
    const r = reconcilePresetOrigin({ agentId: '__creator__', templateKey: 'creator', liveConfig: live, liveDocs: { 'AGENTS.md': tplDocs[0].content }, origin, currentTemplate: { config: tplConfig, docs: tplDocs } });
    expect('noop' in r).toBe(true);
  });

  it('模板新版 + 未编辑 → follow：config 重物化 + 文档覆盖 + 新 origin', () => {
    const live = materializeConfigOf(tplConfig, '__creator__');
    const origin = originOf('creator', templateFingerprint({ config: tplConfig, docs: tplDocs }), live, tplDocs);
    const tplV2 = { ...tplConfig, rows: ['fs-tools', 'persona', 'run-code'] } as unknown as AgentConfig;
    const r = reconcilePresetOrigin({ agentId: '__creator__', templateKey: 'creator', liveConfig: live, liveDocs: { 'AGENTS.md': tplDocs[0].content }, origin, currentTemplate: { config: tplV2, docs: tplV2Docs } });
    expect('follow' in r).toBe(true);
    if ('follow' in r) {
      expect(r.follow.config.rows).toContain('run-code');
      expect(r.follow.overwriteDocs[0]?.content).toContain('v2');
      expect(r.follow.nextOrigin.hash).toBe(templateFingerprint({ config: tplV2, docs: tplV2Docs }));
    }
  });

  it('模板新版 + 已编辑 → notice：保留现状（用户数据优先）', () => {
    const live = materializeConfigOf(tplConfig, '__creator__');
    const origin = originOf('creator', templateFingerprint({ config: tplConfig, docs: tplDocs }), live, tplDocs);
    const edited = { ...live, name: '我的创造' };
    const r = reconcilePresetOrigin({ agentId: '__creator__', templateKey: 'creator', liveConfig: edited, liveDocs: { 'AGENTS.md': '# 我改过的指南\n' }, origin, currentTemplate: { config: tplConfig, docs: tplV2Docs } });
    expect('notice' in r).toBe(true);
  });

  it('readOrigin/writeOrigin 落盘往返（缺席 = undefined）', () => {
    const root = mkDir();
    try {
      expect(readOrigin(root, '__creator__')).toBeUndefined();
      const origin = originOf('creator', 'deadbeef', materializeConfigOf(tplConfig, '__creator__'), tplDocs);
      writeOrigin(root, '__creator__', origin);
      expect(readOrigin(root, '__creator__')).toEqual(origin);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

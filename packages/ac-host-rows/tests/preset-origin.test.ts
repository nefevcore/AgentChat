// ============================================================
// preset-origin 单测（cr-812 copy-on-write）：指纹稳定性 + reconcile
// 四态（baseline 补记 / noop / follow 跟随 / notice 保留）。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  templateFingerprint, originOf, readOrigin, writeOrigin, reconcilePresetOrigin,
} from '../src/preset-origin.ts';
import { materializeConfigOf } from '../src/preset-builtin.ts';
import { isPresetId, presetTemplateKeyOf } from 'ac-agents-core';
import type { AgentConfig } from 'ac-agents-core';

const tplConfig = { id: '__creator__', name: '创造模式', rows: ['fs-tools', 'persona'] } as unknown as AgentConfig;
const tplDocs = [{ name: 'AGENTS.md', content: '# 指南 v1\n' }];
const tplV2Docs = [{ name: 'AGENTS.md', content: '# 指南 v2\n' }];
const tplSkills = [{ dirName: 'plugin-dev', content: '# 技能 v1\n' }];
const tplV2Skills = [{ dirName: 'plugin-dev', content: '# 技能 v2\n' }];

function mkDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'ac-preset-origin-')); }

describe('预设词形（cr-880 判定单源 ac-agents-core）', () => {
  it('__key__ 命中（含下划线历史键）；普通身份/子域不命中', () => {
    expect(isPresetId('__creator__')).toBe(true);
    expect(isPresetId('__dsh_minimal__')).toBe(true); // cr-812 漏网之鱼词形（下划线）
    expect(isPresetId('creator')).toBe(false);
    expect(isPresetId('sub-abc~def')).toBe(false);
  });

  it('presetTemplateKeyOf：_ 归一 -（模板目录查找口）', () => {
    expect(presetTemplateKeyOf('__dsh_minimal__')).toBe('dsh-minimal');
    expect(presetTemplateKeyOf('__creator__')).toBe('creator');
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

  it('cr-879 skills 判定：模板新增技能 → 跟随落地；未编辑 → 跟随；已编辑 → notice', () => {
    const live = materializeConfigOf(tplConfig, '__creator__');
    // origin 不含 skills（cr-812 时代基线）+ 模板新增技能 → 活体缺席 → follow 落地
    const origin = originOf('creator', templateFingerprint({ config: tplConfig, docs: tplDocs, skills: [] }), live, tplDocs);
    const r1 = reconcilePresetOrigin({ agentId: '__creator__', templateKey: 'creator', liveConfig: live, liveDocs: { 'AGENTS.md': tplDocs[0].content }, liveSkills: {}, origin, currentTemplate: { config: tplConfig, docs: tplDocs, skills: tplSkills } });
    expect('follow' in r1).toBe(true);
    if ('follow' in r1) {
      expect(r1.follow.overwriteSkills).toEqual(tplSkills);
      expect(r1.follow.nextOrigin.skills?.['plugin-dev']).toBeTruthy();
    }
    // 未编辑（活体 == origin 指纹）→ follow 覆盖
    const origin2 = originOf('creator', templateFingerprint({ config: tplConfig, docs: tplDocs, skills: tplSkills }), live, tplDocs, tplSkills);
    const r2 = reconcilePresetOrigin({ agentId: '__creator__', templateKey: 'creator', liveConfig: live, liveDocs: { 'AGENTS.md': tplDocs[0].content }, liveSkills: { 'plugin-dev': tplSkills[0].content }, origin: origin2, currentTemplate: { config: tplConfig, docs: tplDocs, skills: tplV2Skills } });
    expect('follow' in r2).toBe(true);
    if ('follow' in r2) expect(r2.follow.overwriteSkills[0]?.content).toContain('v2');
    // 已编辑 → notice（用户数据优先）
    const r3 = reconcilePresetOrigin({ agentId: '__creator__', templateKey: 'creator', liveConfig: live, liveDocs: { 'AGENTS.md': tplDocs[0].content }, liveSkills: { 'plugin-dev': '# 我改过的技能\n' }, origin: origin2, currentTemplate: { config: tplConfig, docs: tplDocs, skills: tplV2Skills } });
    expect('notice' in r3).toBe(true);
    if ('notice' in r3) expect(r3.notice).toContain('plugin-dev');
  });

  it('cr-879 origin 缺席 → baseline 纳入活体技能指纹', () => {
    const live = materializeConfigOf(tplConfig, '__creator__');
    const r = reconcilePresetOrigin({ agentId: '__creator__', templateKey: 'creator', liveConfig: live, liveDocs: {}, liveSkills: { 'plugin-dev': '# 已在场\n' }, origin: undefined, currentTemplate: { config: tplConfig, docs: tplDocs, skills: tplSkills } });
    expect('baseline' in r).toBe(true);
    if ('baseline' in r) expect(r.baseline.skills?.['plugin-dev']).toBeTruthy();
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

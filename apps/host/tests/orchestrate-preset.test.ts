// ============================================================
// orchestrate-preset.test.ts —— 预设身份模板物化回归锁（cr-615）：
// adoptShell 兜底写对 __<template_key>__ 身份物化出厂模板（cr-880：preset
// 字段退役，词形判类属；tools 全量），其余身份维持裸 {id}——此前裸兜底让 __standard__ 落到
// 基础壳行集（90 工具词）而非模板行全集。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { adoptShell, type SpawnFn } from '../orchestrate.ts';
import { readAgentConfig } from 'ac-agents-core';
import { ReachabilityTable } from 'ac-post-office';

const fakeSpawn: SpawnFn = () => ({
  pid: 4300,
  stdout: (async function* () {
    yield 'boot.lock.acquired\tb-1';
    yield 'boot.rows.ready\tb-1\t18';
    yield 'boot.ready\tb-1\tpipe-x';
  })(),
  write: () => { /* 测试替身无进程 */ },
  on: (event: string, cb: (code: number | null, signal: string | null) => void) => { void event; void cb; },
  kill: () => { /* 测试替身无进程 */ },
});

describe('adoptShell 预设身份模板物化（cr-615）', () => {
  it('__standard__ 首启兜底写 = 模板 config（preset 剥除 + tools 全量）', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-orchestrate-preset-'));
    await adoptShell({
      agentId: '__standard__',
      dataRoot,
      catalogFile: 'C',
      bootFile: 'B',
      reach: new ReachabilityTable(),
      spawnFn: fakeSpawn,
      timeoutMs: 5_000,
    });
    const cfg = readAgentConfig(dataRoot, '__standard__') as { id: string; tags?: string[]; rows: string[]; description?: string };
    expect(cfg.id).toBe('__standard__');
    expect('preset' in cfg).toBe(false); // cr-880：字段退役——预设类属由 id 词形承载
    expect(cfg.rows).toContain('browser');
    expect(cfg.rows).toContain('goal'); // 模板 15 行（cr-790：协作面/历史回放移出标准预设）
    expect(cfg.rows).not.toContain('memory');
    // 能力 tags 随模板物化（cr-617：缺 tags = SDK 投影/能力面坍缩到 base 族）
    expect(cfg.tags).toContain('fs');
    expect(cfg.tags).toContain('observe'); // browser 双标签（web+observe——cr-790）
    expect(cfg.description).toBeTruthy();
  });

  it('__creator__ 首启物化 = 人设指路 AGENTS.md + 技能落地 files/<id>/skills（cr-810/879）', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-orchestrate-preset-'));
    await adoptShell({
      agentId: '__creator__',
      dataRoot,
      catalogFile: 'C',
      bootFile: 'B',
      reach: new ReachabilityTable(),
      spawnFn: fakeSpawn,
      timeoutMs: 5_000,
    });
    const cfg = readAgentConfig(dataRoot, '__creator__') as { system?: string; rows: string[]; settings?: Record<string, unknown> };
    expect(cfg.system).toBeUndefined();
    expect(cfg.rows).toContain('persona'); // persona 行入集——settings.persona 才有消费方
    expect(cfg.rows).toContain('skill'); // skill 行入集——own 技能目录才有消费方
    expect(cfg.settings?.['persona']).toEqual({ file: 'AGENTS.md' });
    // 人设收缩为指路残句（cr-879：知识本体迁技能面）
    const doc = fs.readFileSync(path.join(dataRoot, 'agents/__creator__/AGENTS.md'), 'utf-8');
    expect(doc).toContain('load_skill');
    expect(doc.length).toBeLessThan(400);
    // 技能本体随物化落地 Agent 专属技能目录
    const skill = fs.readFileSync(path.join(dataRoot, 'files/__creator__/skills/plugin-dev/SKILL.md'), 'utf-8');
    expect(skill).toContain('name: plugin-dev');
    expect(skill).toContain('迭代铁律');
  });

  it('非预设身份首启兜底写 = 裸 {id}（cr-561 语义不动）', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-orchestrate-preset-'));
    await adoptShell({
      agentId: 'alpha',
      dataRoot,
      catalogFile: 'C',
      bootFile: 'B',
      reach: new ReachabilityTable(),
      spawnFn: fakeSpawn,
      timeoutMs: 5_000,
    });
    const cfg = readAgentConfig(dataRoot, 'alpha') as unknown as Record<string, unknown>;
    expect(cfg).toEqual({ id: 'alpha' });
  });
});

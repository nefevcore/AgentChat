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
import { fileURLToPath } from 'node:url';

// 仓库行目录投影（cr-1022 批2 v3 物化链需能力目录：定义拷贝面 = 数据根
// row-catalog.json——宿主 boot 物化后恒在场；测试数据根预置同款投影）
const REPO_CATALOG = fileURLToPath(new URL('../../catalog/row-catalog.json', import.meta.url));
const CATALOG_TEXT = fs.readFileSync(REPO_CATALOG, 'utf-8');
const SHELL_IDS = (JSON.parse(CATALOG_TEXT) as { rows: Array<{ tree: string; id: string }> })
  .rows.filter((r) => r.tree === 'shell').map((r) => r.id);

function seedDataRoot(): string {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-orchestrate-preset-'));
  fs.writeFileSync(path.join(dataRoot, 'row-catalog.json'), CATALOG_TEXT, 'utf-8');
  return dataRoot;
}

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
    const dataRoot = seedDataRoot();
    await adoptShell({
      agentId: '__standard__',
      dataRoot,
      catalogFile: 'C',
      bootFile: 'B',
      reach: new ReachabilityTable(),
      spawnFn: fakeSpawn,
      timeoutMs: 5_000,
    });
    const cfg = readAgentConfig(dataRoot, '__standard__') as { id: string; rows: string[] | { include?: string[] }; levels?: Record<string, string>; description?: string };
    expect(cfg.id).toBe('__standard__');
    expect('preset' in cfg).toBe(false); // cr-880：字段退役——预设类属由 id 词形承载
    // cr-1004 批2：rows 投影为差量 {include}（白名单 = 加法面）
    const rows = Array.isArray(cfg.rows) ? cfg.rows : cfg.rows.include ?? [];
    expect(rows).toContain('browser');
    expect(rows).toContain('goal'); // 模板 15 行（cr-790：协作面/历史回放移出标准预设）
    expect(rows).not.toContain('memory');
    // browser 层级随模板物化（cr-953：能力 tags 退役——levels.browser 单源）
    expect(cfg.levels?.browser).toBe('observe');
    expect(cfg.description).toBeTruthy();
  });

  it('__creator__ 首启物化 = 人设指路 AGENTS.md + 技能落地 files/<id>/skills（cr-810/879）', async () => {
    const dataRoot = seedDataRoot();
    await adoptShell({
      agentId: '__creator__',
      dataRoot,
      catalogFile: 'C',
      bootFile: 'B',
      reach: new ReachabilityTable(),
      spawnFn: fakeSpawn,
      timeoutMs: 5_000,
    });
    const cfg = readAgentConfig(dataRoot, '__creator__') as { system?: string; rows: string[] | { include?: string[] }; settings?: Record<string, unknown> };
    expect(cfg.system).toBeUndefined();
    const rows = Array.isArray(cfg.rows) ? cfg.rows : cfg.rows.include ?? [];
    expect(rows).toContain('persona'); // persona 行入集——settings.persona 才有消费方
    expect(rows).toContain('skill'); // skill 行入集——own 技能目录才有消费方
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

  it('非预设身份首启兜底写 = 裸档案（cr-561 语义：无模板字段；cr-1022 批2 v3 组合读口径：rows 面 = 骨架正清单）', async () => {
    const dataRoot = seedDataRoot();
    await adoptShell({
      agentId: 'alpha',
      dataRoot,
      catalogFile: 'C',
      bootFile: 'B',
      reach: new ReachabilityTable(),
      spawnFn: fakeSpawn,
      timeoutMs: 5_000,
    });
    const cfg = readAgentConfig(dataRoot, 'alpha') as unknown as { id: string; rows?: { include: string[] } };
    expect(cfg.id).toBe('alpha');
    expect(Object.keys(cfg).filter((k) => k !== 'id' && k !== 'rows')).toEqual([]); // 无模板字段
    // v3 组合读：裸身份 rows 面 = 骨架 ∪ 全部能力行（rowsToMenuDefs 写侧
    // 单源：rows 缺省 = 行集全集——批3 起旧差量语义只存在于迁移工具）
    expect(new Set(cfg.rows?.include ?? [])).toEqual(new Set(SHELL_IDS));
  });
});

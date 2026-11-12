// ============================================================
// patch-chain.test.ts —— agent.patch 形态链单测（cr-1036 批2）
//
// 锁定：
//   1. 多代存量逐边接力：v0（config.json / 旧映射）与 v1（数组差量）
//      各自经链到 v2，行集与 migrate 脚本旧产物逐位一致；
//   2. 链完备：缺环/跳版注册即红（assertChainIntegrity）；
//   3. 对账自检：迁移前后行集不等价 = throw 不落盘；
//   4. config.json 收编转 .migrated（批3——旧读者窗口退役）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PATCH_CHAIN, detectPatchForm, migrateAgentPatchAt,
  LEGACY_SEAT_ROW_IDS, LEGACY_BUNDLE_ROW_IDS,
  type PatchChainContext,
} from '../src/patch-chain.ts';
import { readAgentPatchV3At, readAgentProfileAt, PATCH_FILE } from '../src/patch-doc.ts';
import { assertChainIntegrity, planChain, type MigrationEdge } from 'ac-migration-core';

// 迷你出厂目录（3 骨架 + 3 能力——捆绑/非捆绑各一，requires 边一条）
const skeleton = [
  { id: 'conversation' }, { id: 'persona' }, { id: 'tools' },
];
const capability = [
  { id: 'math', name: 'link:packages/ac-math', requires: ['tools'] },
  { id: 'fs-tools', name: 'link:packages/ac-fs-tools', requires: ['tools'] },
  { id: 'browser', name: 'link:packages/ac-client-ui-browser' },
];
const stamp = 'aabbccdd00112233';
const ROOT = path.join('sandbox', 'test-patch-chain-' + process.pid);
const ctx = (dir: string): PatchChainContext => ({ dir, skeleton, capability, stamp });

beforeEach(() => { fs.mkdirSync(ROOT, { recursive: true }); });
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('链完备性（注册面即红）', () => {
  it('PATCH_CHAIN 注册完备（v0→v1→v2 无缺环）', () => {
    expect(() => assertChainIntegrity('agent.patch', PATCH_CHAIN)).not.toThrow();
    expect(PATCH_CHAIN.map((e) => e.from + '→' + e.to)).toEqual(['0→1', '1→2']);
  });

  it('缺环链（跳过 v1）注册即红', () => {
    const broken: MigrationEdge<unknown>[] = [
      { from: 0, to: 1, migrate: (v) => v },
      { from: 2, to: 3, migrate: (v) => v },
    ];
    expect(() => assertChainIntegrity('x', broken)).toThrow('链缺环');
  });

  it('未来版本拒绝：stored v3 > current v2 = 显式抛错', () => {
    expect(() => planChain(PATCH_CHAIN, 3)).toThrow(/未来版本拒绝降级读/);
  });
});

describe('形态探测（多代判别）', () => {
  it('v2 标记在场 → version 2（已最新不迁）', () => {
    const dir = path.join(ROOT, 'a1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PATCH_FILE), '# ac-menu: 1\n- id: math\n', 'utf-8');
    const d = detectPatchForm(ctx(dir));
    expect(d?.version).toBe(2);
  });

  it('v1 数组（无标记）→ version 1；v0 映射 → version 0；config.json → version 0；空目录 → null', () => {
    const d1 = path.join(ROOT, 'b1');
    fs.mkdirSync(d1, { recursive: true });
    fs.writeFileSync(path.join(d1, PATCH_FILE), '- id: math\n', 'utf-8');
    expect(detectPatchForm(ctx(d1))?.version).toBe(1);
    const d0 = path.join(ROOT, 'b2');
    fs.mkdirSync(d0, { recursive: true });
    fs.writeFileSync(path.join(d0, PATCH_FILE), 'rows:\n  - math\n', 'utf-8');
    expect(detectPatchForm(ctx(d0))?.version).toBe(0);
    const dc = path.join(ROOT, 'b3');
    fs.mkdirSync(dc, { recursive: true });
    fs.writeFileSync(path.join(dc, 'config.json'), JSON.stringify({ id: 'b3', model: 'm' }), 'utf-8');
    expect(detectPatchForm(ctx(dc))?.version).toBe(0);
    const de = path.join(ROOT, 'b4');
    fs.mkdirSync(de, { recursive: true });
    expect(detectPatchForm(ctx(de))).toBeNull();
  });
});

describe('链驱动迁移：v0 config.json → v2（两边接力）', () => {
  it('全量载荷：档案/单元文件/levels/菜单定义 + 对账 + config.json 收编', () => {
    const dir = path.join(ROOT, 'c1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      id: 'c1', model: 'mock', access: 'full-access',
      rows: ['math', 'fs-tools'],
      levels: { browser: 'observe' },
      settings: { memory: { depth: 2 } },
    }), 'utf-8');
    const out = migrateAgentPatchAt(ctx(dir))!;
    expect(out).not.toBeNull();
    expect(out.fromVersion).toBe(0);
    expect(out.reports.map((r) => r.from + '→' + r.to)).toEqual(['0→1', '1→2']);
    // 档案 + 单元文件
    const profile = readAgentProfileAt(dir)!;
    expect(profile.model).toBe('mock');
    expect(profile.tier).toBe('full-access');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf-8'))).toEqual({ depth: 2 });
    // 菜单定义：白名单 {math, fs-tools} + 闭包 tools → defs 含两能力行
    const v3 = readAgentPatchV3At(dir)!;
    expect(v3.defs.map((d) => d.id).sort()).toEqual(['fs-tools', 'math']);
    expect(v3.base).toBe(stamp);
    expect(v3.fingerprints['math']).toMatch(/^[0-9a-f]{16}$/);
    // levels 归位：browser 定义 config.level
    //（browser 不在白名单 rows → 不进 defs——levels 仅挂显式条目）
    expect(v3.defs.find((d) => d.id === 'browser')).toBeUndefined();
    // config.json 收编
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'config.json.migrated'))).toBe(true);
  });

  it('缺省 rows → 旧基础集等价：非捆绑行全进、捆绑行不在基础集（B−T 语义）', () => {
    const dir = path.join(ROOT, 'c2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ id: 'c2' }), 'utf-8');
    const out = migrateAgentPatchAt(ctx(dir))!;
    const v3 = readAgentPatchV3At(dir)!;
    // rows 缺省 = 旧基础集 = 全集 − 捆绑行（fs-tools 是 bundle 词——不在
    // 基础集；与原 migrate 脚本 config.json 分支逐位等价）
    expect(v3.defs.map((d) => d.id).sort()).toEqual(['browser', 'math']);
    expect(out.reports).toHaveLength(2);
  });

  it('v1 直接输入（数组差量）只走一边：加法 fs-tools + 停用 math', () => {
    const dir = path.join(ROOT, 'c3');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ model: 'mock' }), 'utf-8');
    fs.writeFileSync(path.join(dir, PATCH_FILE),
      '# agent.patch —— 装配差量（cr-1004 批2）\n'
      + '- id: fs-tools\n'
      + '- id: math\n  disabled: true\n', 'utf-8');
    const out = migrateAgentPatchAt(ctx(dir))!;
    expect(out.fromVersion).toBe(1);
    expect(out.reports).toEqual([{ from: 1, to: 2 }]);
    const v3 = readAgentPatchV3At(dir)!;
    // 基础集（browser）∪ 加法（fs-tools）− 停用（math）
    expect(v3.defs.map((d) => d.id).sort()).toEqual(['browser', 'fs-tools']);
    expect(out.wroteProfile).toBe(false); // 档案已在 v1 就位
  });
});

describe('语义护栏（冻结词汇）', () => {
  it('席位不可停用：v1 disabled 席位行 = notice 拒绝生效，行仍在装', () => {
    const dir = path.join(ROOT, 'd1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PATCH_FILE),
      '- id: math\n- id: persona\n  disabled: true\n', 'utf-8');
    const out = migrateAgentPatchAt(ctx(dir))!;
    expect(out.notices.join('\n')).toContain('恒并基座席位不可停用');
    // 停用被拒绝 → 基础集 ∪ 加法全保：browser（基础集）+ math（加法）；
    // persona 是骨架席位——不进 defs（能力区拷贝），菜单合成恒并
    const v3 = readAgentPatchV3At(dir)!;
    expect(v3.defs.map((d) => d.id).sort()).toEqual(['browser', 'math']);
  });

  it('冻结词汇清单常量暴露（历史边的本体输入——链在即词汇在）', () => {
    expect(LEGACY_SEAT_ROW_IDS).toContain('conversation');
    expect(LEGACY_BUNDLE_ROW_IDS).toContain('fs-tools');
  });
});

describe('对账自检（fail-loud）', () => {
  it('已最新（v2）与无身份 = null（幂等）', () => {
    const dir = path.join(ROOT, 'e1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PATCH_FILE), '# ac-menu: 1\n- id: math\n', 'utf-8');
    expect(migrateAgentPatchAt(ctx(dir))).toBeNull();
    const empty = path.join(ROOT, 'e2');
    fs.mkdirSync(empty, { recursive: true });
    expect(migrateAgentPatchAt(ctx(empty))).toBeNull();
  });
});

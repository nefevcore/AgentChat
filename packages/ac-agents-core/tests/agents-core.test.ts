// ============================================================
// ac-agents-core 单测（M2.1 验收）：词汇纯函数语义 + 树直读 + children
// 数据根纪律：恒 sandbox/ 独立目录
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  accessOf, toolModeOf, displayNameOf, resolveToolNames, settingsOf, deepMerge,
  isPresetId, presetTemplateKeyOf,
  type AgentConfig,
} from '../src/config.ts';
import {
  readAgentConfig, writeAgentConfig, listAgentIds,
  readChildConfig, listChildIds, materializedChildIds, agentDir,
} from '../src/tree.ts';
import { readAgentPatchV3At } from '../src/patch-doc.ts';

describe('词汇纯函数（语义平移自 ac-agents）', () => {
  const base: AgentConfig = { id: 'a' };

  it('accessOf：结构化 access 字段 / 缺省 base / 未注册 base（fail-closed）', () => {
    expect(accessOf(undefined)).toBe('base-access');
    expect(accessOf({ ...base })).toBe('base-access');
    expect(accessOf({ ...base, access: 'sandbox-access' })).toBe('sandbox-access');
    expect(accessOf({ ...base, access: 'full-access' })).toBe('full-access');
  });

  it('toolModeOf：结构化 toolMode 字段 / 缺省 base', () => {
    expect(toolModeOf(undefined)).toBe('tc-base');
    expect(toolModeOf({ ...base, toolMode: 'tc-programmatic' })).toBe('tc-programmatic');
    expect(toolModeOf({ ...base, toolMode: 'tc-none' })).toBe('tc-none');
  });

  it('normalizeLegacyTags：存量 tags 词归一（档位/模式结构化、admin/browser 入 levels、能力词丢弃）', async () => {
    const { normalizeLegacyTags } = await import('../src/config.ts');
    expect(normalizeLegacyTags({ id: 'a', tags: ['full-access', 'tc-programmatic'] } as never))
      .toEqual({ id: 'a', access: 'full-access', toolMode: 'tc-programmatic' });
    expect(normalizeLegacyTags({ id: 'a', tags: ['admin', 'observe'] } as never))
      .toEqual({ id: 'a', levels: { collab: 'admin', browser: 'observe' } });
    expect(normalizeLegacyTags({ id: 'a', tags: ['fs', 'shell', 'web', 'delegation', 'infra'] } as never))
      .toEqual({ id: 'a' }); // 能力词丢弃——无消费面
    expect(normalizeLegacyTags({ id: 'a' })).toEqual({ id: 'a' }); // 无 tags 原样
  });

  it('displayNameOf：回退链 name ?? description；空白视同缺省', () => {
    expect(displayNameOf(undefined)).toBeUndefined();
    expect(displayNameOf({ ...base, name: '  ' })).toBeUndefined();
    expect(displayNameOf({ ...base, description: '简介' })).toBe('简介');
    expect(displayNameOf({ ...base, name: '显示名', description: '简介' })).toBe('显示名');
  });

  it('resolveToolNames：undefined=全集信号 / 数组原样 / include-exclude 合成', () => {
    expect(resolveToolNames(undefined)).toBeUndefined();
    expect(resolveToolNames(['fs_read', 'ac-hello'])).toEqual(['fs_read', 'ac-hello']);
    expect(resolveToolNames({ include: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(resolveToolNames({ exclude: ['x'] })).toBeUndefined(); // 全集减法由调用方持全集
    expect(resolveToolNames({ include: ['a', 'b', 'c'], exclude: ['b'] })).toEqual(['a', 'c']);
  });

  it('settingsOf：本层覆盖全局层，深层对象递归合并，数组覆盖', () => {
    const g = { memory: { depth: 3, tags: ['a'] }, timer: { on: true } };
    const a = { memory: { depth: 5, extra: 1 }, timer: undefined };
    expect(settingsOf(g, a, 'memory')).toEqual({ depth: 5, tags: ['a'], extra: 1 });
    expect(settingsOf(g, undefined, 'timer')).toEqual({ on: true });
    expect(settingsOf(undefined, a, 'memory')).toEqual({ depth: 5, extra: 1 });
    expect(settingsOf({ x: { l: [1, 2] } }, { x: { l: [3] } }, 'x')).toEqual({ l: [3] });
  });
});

describe('agents/<id>/ 树直读', () => {
  const ROOT = path.join('sandbox', 'test-agents-' + process.pid);
  // 目录 fixture（cr-1022 批2：writeAgentConfig 写 v3 需 shell 能力目录——定义拷贝面）
  const CATALOG = { rows: [
    { id: 'ledger', tree: 'shell', zone: 'skeleton' },
    { id: 'fs', tree: 'shell' },
    { id: 'math', tree: 'shell' },
  ] };
  beforeEach(() => {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'row-catalog.json'), JSON.stringify(CATALOG), 'utf-8');
  });
  afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it('写读往返：v3 菜单片段 + agent.json 档案还原（cr-1022 批2；id 一致性校验）', () => {
    const cfg: AgentConfig = { id: 'alpha', model: 'gpt-x', access: 'sandbox-access', settings: { memory: { depth: 2 } } };
    writeAgentConfig(ROOT, cfg);
    // 落盘形态：agent.patch.yml = v3 行定义数组（ac-menu 头 + 基线戳）；档案在 agent.json
    const patchText = fs.readFileSync(path.join(agentDir(ROOT, 'alpha'), 'agent.patch.yml'), 'utf-8');
    expect(patchText).toMatch(/# ac-menu: 1/);
    expect(patchText).toMatch(/# ac-base: /);
    const v3 = readAgentPatchV3At(agentDir(ROOT, 'alpha'))!;
    expect(v3.defs.map((d) => d.id)).toEqual(['fs', 'math']); // rows 缺省 = 全部能力行
    for (const def of v3.defs) expect(v3.fingerprints[def.id]).toMatch(/^[0-9a-f]{16}$/);
    // 读面投影：rows = 骨架 ∪ 定义清单（正清单直读）
    expect(readAgentConfig(ROOT, 'alpha')).toEqual({
      ...cfg, rows: { include: ['ledger', 'fs', 'math'] },
    });
  });

  it('v2 差量读窗口已退役（cr-1022 批3）：手写 v2 不再组合读——指路迁移', () => {
    fs.mkdirSync(agentDir(ROOT, 'delta'), { recursive: true });
    fs.writeFileSync(path.join(agentDir(ROOT, 'delta'), 'agent.patch.yml'),
      '# agent.patch —— 装配差量（cr-1004 批2）' + String.fromCharCode(10)
      + '# ac-base: abc123def4567890' + String.fromCharCode(10)
      + '- id: fs' + String.fromCharCode(10)
      + '- id: math' + String.fromCharCode(10)
      + '  disabled: true' + String.fromCharCode(10), 'utf-8');
    fs.writeFileSync(path.join(agentDir(ROOT, 'delta'), 'agent.json'), JSON.stringify({ model: 'gpt-x' }), 'utf-8');
    // v2 差量读窗口已退役（批3）：不组合读——身份缺席语义，指路 migrate
    expect(readAgentConfig(ROOT, 'delta')).toBeNull();
  });

  it('存量 config.json（读窗退役——cr-1036 批3）：旧形态在场 = 身份缺席语义（残留死文件），不再旧读', () => {
    fs.mkdirSync(agentDir(ROOT, 'legacy'), { recursive: true });
    fs.writeFileSync(path.join(agentDir(ROOT, 'legacy'), 'config.json'),
      JSON.stringify({ id: 'legacy', model: 'm', tags: ['full-access', 'fs', 'admin'] }), 'utf-8');
    expect(readAgentConfig(ROOT, 'legacy')).toBeNull();
  });

  it('id 不符 / 缺席 → null（未注册语义）；v3 在场即赢（config.json.migrated 副本不拖累）', () => {
    const cfg: AgentConfig = { id: 'beta' };
    // v3 在场即赢——组合读恒带 rows（rows 缺省写全部能力行：正清单）
    writeAgentConfig(ROOT, cfg);
    fs.writeFileSync(path.join(agentDir(ROOT, 'beta'), 'config.json.migrated'), JSON.stringify({ ...cfg, id: 'mismatch' }), 'utf-8');
    expect(readAgentConfig(ROOT, 'beta')).toEqual({ ...cfg, rows: { include: ['ledger', 'fs', 'math'] } });
    expect(readAgentConfig(ROOT, 'ghost')).toBeNull();
    expect(readAgentConfig(ROOT, 'ghost2')).toBeNull();
  });

  it('listAgentIds：目录序且只列目录', () => {
    writeAgentConfig(ROOT, { id: 'zeta' });
    writeAgentConfig(ROOT, { id: 'alpha' });
    fs.writeFileSync(path.join(ROOT, 'agents', 'loose.json'), '{}');
    expect(listAgentIds(ROOT)).toEqual(['alpha', 'zeta']);
  });

  it('fail-loud：路径穿越 agentId 拒绝', () => {
    expect(() => agentDir(ROOT, 'a/b')).toThrow();
    expect(() => agentDir(ROOT, '..')).toThrow();
  });
});

describe('children 嵌套解析（R-5 物化即快照）', () => {
  const ROOT = path.join('sandbox', 'test-agents-child-' + process.pid);
  beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
  afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it('子身份 config.json 读窗退役（cr-1036 批3）：残留死文件 = 缺席语义', () => {
    const child: AgentConfig = { id: 'sub-1', model: 'gpt-y' };
    const cdir = path.join(agentDir(ROOT, 'parent'), 'children', 'sub-1');
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, 'config.json'), JSON.stringify(child), 'utf-8');
    expect(readChildConfig(ROOT, 'parent', 'sub-1')).toBeNull();
  });

  it('listChildIds：只列物化目录', () => {
    const cdir = path.join(agentDir(ROOT, 'p2'), 'children', 'c1');
    fs.mkdirSync(cdir, { recursive: true });
    expect(listChildIds(ROOT, 'p2')).toEqual(['c1']);
    expect(listChildIds(ROOT, 'ghost')).toEqual([]);
  });

  it('materializedChildIds：children 树逆查（顶层兜底目录不算独立身份）', () => {
    for (const cid of ['c1', 'c2']) {
      const cdir = path.join(agentDir(ROOT, 'p3'), 'children', cid);
      fs.mkdirSync(cdir, { recursive: true });
      fs.writeFileSync(path.join(cdir, 'config.json'), JSON.stringify({ id: cid }), 'utf-8');
    }
    // 子身份的顶层兜底目录（运行期 supervise 预置 config 只含 id）+ 真身份
    writeAgentConfig(ROOT, { id: 'c1' });
    writeAgentConfig(ROOT, { id: 'plain' });
    expect([...materializedChildIds(ROOT)].sort()).toEqual(['c1', 'c2']);
  });
});

describe('预设词形判定（cr-880 单源）', () => {
  it('isPresetId：连字符/下划线键命中；普通 id/子身份/会话域不命中', () => {
    expect(isPresetId('__standard__')).toBe(true);
    expect(isPresetId('__dsh_minimal__')).toBe(true); // 历史 id 冻结下划线（cr-812 漏网之鱼的断根）
    expect(isPresetId('__abap_dev__')).toBe(true);
    expect(isPresetId('standard')).toBe(false);
    expect(isPresetId('sub-abc')).toBe(false);
    expect(isPresetId('a~b')).toBe(false);
    expect(isPresetId('')).toBe(false);
    expect(isPresetId('__x')).toBe(false); // 尾界不闭合不命中
  });

  it('presetTemplateKeyOf：_ → - 归一化（模板目录查找口）', () => {
    expect(presetTemplateKeyOf('__dsh_minimal__')).toBe('dsh-minimal');
    expect(presetTemplateKeyOf('__abap_dev__')).toBe('abap-dev');
    expect(presetTemplateKeyOf('__standard__')).toBe('standard');
    expect(presetTemplateKeyOf('standard')).toBeUndefined();
    expect(presetTemplateKeyOf('sub-x')).toBeUndefined();
  });
});

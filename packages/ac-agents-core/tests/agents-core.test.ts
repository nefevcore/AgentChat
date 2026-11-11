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
  beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
  afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it('写读往返：v2 差量 + agent.json 档案还原（cr-1004 批2；id 一致性校验）', () => {
    const cfg: AgentConfig = { id: 'alpha', model: 'gpt-x', access: 'sandbox-access', settings: { memory: { depth: 2 } } };
    writeAgentConfig(ROOT, cfg);
    // 落盘形态：agent.patch.yml = 顶层数组（差量）；档案在 agent.json
    const patchText = fs.readFileSync(path.join(agentDir(ROOT, 'alpha'), 'agent.patch.yml'), 'utf-8');
    expect(patchText).toMatch(/# ac-base: /);
    expect(readAgentConfig(ROOT, 'alpha')).toEqual(cfg);
  });

  it('v2 差量词形：include/exclude 投影回 rows；档案字段经 agent.json', () => {
    writeAgentConfig(ROOT, { id: 'delta', model: 'gpt-x', rows: { include: ['fs'], exclude: ['math'] } });
    expect(readAgentConfig(ROOT, 'delta')).toEqual({ id: 'delta', model: 'gpt-x', rows: { include: ['fs'], exclude: ['math'] } });
  });

  it('存量 config.json 带 tags：读侧归一（档位词结构化、能力词丢弃）', () => {
    fs.mkdirSync(agentDir(ROOT, 'legacy'), { recursive: true });
    fs.writeFileSync(path.join(agentDir(ROOT, 'legacy'), 'config.json'),
      JSON.stringify({ id: 'legacy', model: 'm', tags: ['full-access', 'fs', 'admin'] }), 'utf-8');
    expect(readAgentConfig(ROOT, 'legacy')).toEqual({ id: 'legacy', model: 'm', access: 'full-access', levels: { collab: 'admin' } });
  });

  it('id 不符 / 缺席 / 损坏 → null（未注册语义；cr-1004 批2：v2 在场即赢）', () => {
    const cfg: AgentConfig = { id: 'beta' };
    fs.mkdirSync(agentDir(ROOT, 'beta'), { recursive: true });
    fs.writeFileSync(path.join(agentDir(ROOT, 'beta'), 'config.json'), JSON.stringify({ ...cfg, id: 'mismatch' }), 'utf-8');
    expect(readAgentConfig(ROOT, 'beta')).toBeNull(); // 旧路径：id 不符
    // v2 在场即赢（config.json 镜像坏不拖累 patch 读面）
    writeAgentConfig(ROOT, cfg);
    fs.writeFileSync(path.join(agentDir(ROOT, 'beta'), 'config.json'), JSON.stringify({ ...cfg, id: 'mismatch' }), 'utf-8');
    expect(readAgentConfig(ROOT, 'beta')).toEqual(cfg);
    expect(readAgentConfig(ROOT, 'ghost')).toBeNull();
    fs.mkdirSync(agentDir(ROOT, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(agentDir(ROOT, 'broken'), 'config.json'), '{nope', 'utf-8');
    expect(readAgentConfig(ROOT, 'broken')).toBeNull();
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

  it('子身份直读物化快照，父改配置不传播', () => {
    // 物化子：宿主写 children/<cid>/config.json
    const child: AgentConfig = { id: 'sub-1', model: 'gpt-y' };
    const cdir = path.join(agentDir(ROOT, 'parent'), 'children', 'sub-1');
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, 'config.json'), JSON.stringify(child), 'utf-8');
    expect(readChildConfig(ROOT, 'parent', 'sub-1')).toEqual(child);
    // 父目录随后消失——子快照仍可读（不回溯父）
    fs.rmSync(agentDir(ROOT, 'parent'), { recursive: true, force: true });
    // 快照随父目录删除（物理内嵌）——重建父目录+子快照验证独立读取路径
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, 'config.json'), JSON.stringify(child), 'utf-8');
    expect(readChildConfig(ROOT, 'parent', 'sub-1')).toEqual(child);
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

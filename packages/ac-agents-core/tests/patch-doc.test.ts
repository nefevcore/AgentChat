// ============================================================
// patch-doc.test.ts —— agent.patch.yml 双读/双落单测（cr-906 批4 切片一）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readAgentConfig, writeAgentConfig, agentDir } from '../src/tree.ts';
import { readAgentPatch, patchToConfig, configToPatch, writeAgentPatch, readAgentPatchV3At, readAgentProfileAt, PATCH_FILE, readPluginConfig, writePluginConfig, readPluginConfigs, pluginConfigFile } from '../src/patch-doc.ts';
import type { AgentConfig } from '../src/config.ts';

const ROOT = path.join('sandbox', 'test-agent-patch-' + process.pid);
const ID = 'helper';
const cfg: AgentConfig = {
  id: ID, model: 'deepseek-chat', provider: 'deepseek',
  rows: { include: ['fs', 'web-tools'], exclude: ['sap-adt'] },
  access: 'full-access', toolMode: 'tc-programmatic',
  llmParams: { temperature: 0.5 }, maxSteps: 40,
  name: 'Helper', description: '演示',
  settings: { 'run-code': { mode: 'observe' } },
};
// 目录 fixture（cr-1022 批2：writeAgentConfig 写 v3——定义拷贝需 shell 能力目录）
const CATALOG = { rows: [
  { id: 'fs', tree: 'shell' },
  { id: 'web-tools', tree: 'shell' },
  { id: 'sap-adt', tree: 'shell' },
  { id: 'math', tree: 'shell' },
  { id: 'browser', tree: 'shell' },
  { id: 'collab-tools', tree: 'shell' },
] };
/** v3 组合读期望（rows 差量换正清单：include = 定义清单，exclude 语义消亡；
 * access 随 cr-1082 轴退役——tier 不再落盘，读回缺席） */
const cfgV3: AgentConfig = (() => { const { access: _a, ...rest } = cfg; return { ...rest, rows: { include: ['fs', 'web-tools'] } }; })();
beforeEach(() => {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'row-catalog.json'), JSON.stringify(CATALOG), 'utf-8');
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('agent.patch.yml v3 菜单片段 + agent.json（cr-1022 批2）', () => {
  it('写拆落：行定义数组〔ac-menu 头+src-fingerprint——cr-1067 基线戳退役〕+ 档案 agent.json；读面投影回 AgentConfig', () => {
    writeAgentConfig(ROOT, cfg);
    const dir = agentDir(ROOT, ID);
    const v3 = readAgentPatchV3At(dir);
    expect(v3).not.toBeNull();
    expect(v3!.defs.map((d) => d.id)).toEqual(['fs', 'web-tools']); // exclude 词形消亡——不进即不装
    for (const def of v3!.defs) expect(v3!.fingerprints[def.id]).toMatch(/^[0-9a-f]{16}$/);
    const profile = readAgentProfileAt(dir)!;
    expect(profile.tier).toBeUndefined(); // cr-1082：tier 随 access 轴退役（写侧不产）
    expect(profile['tool-mode']).toBe('tc-programmatic');
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false); // 镜像退役
    const reread = readAgentConfig(ROOT, ID);
    expect(reread).toEqual(cfgV3); // v3 组合读投影等价（正清单直读）
  });

  it('旧存量（仅 config.json）读窗退役（cr-1036 批3）：残留死文件 = 缺席语义', () => {
    fs.mkdirSync(agentDir(ROOT, ID), { recursive: true });
    fs.writeFileSync(path.join(agentDir(ROOT, ID), 'config.json'), JSON.stringify(cfg), 'utf-8');
    expect(readAgentConfig(ROOT, ID)).toBeNull();
  });

  it('镜像退役后删 patch = 身份缺席（回滚窗口已关闭——存量 config.json 根仍走旧读路径）', () => {
    writeAgentConfig(ROOT, cfg);
    fs.rmSync(path.join(agentDir(ROOT, ID), PATCH_FILE));
    expect(readAgentConfig(ROOT, ID)).toBeNull();
  });

  it('档位映射（cr-1082 起单侧）：toolMode ↔ tool-mode；tier 不再写、读侧剥除；settings 随行；system 不迁', () => {
    const doc = configToPatch({ ...cfg, system: 'legacy prompt' });
    expect(doc.tier).toBeUndefined(); // cr-1082：access 轴退役
    expect(doc['tool-mode']).toBe('tc-programmatic');
    expect(doc.settings).toEqual({ 'run-code': { mode: 'observe' } });
    expect((doc as Record<string, unknown>).system).toBeUndefined();
    expect((doc as Record<string, unknown>).tags).toBeUndefined(); // tags 不再写
    const back = patchToConfig(ID, doc);
    expect(back.access).toBeUndefined(); // tier 投影剥除
    expect(back.toolMode).toBe('tc-programmatic');
    expect(back.settings).toEqual(cfg.settings);
  });

  it('存量 patch doc.tags 余词：读侧归一（admin/browser 入 levels、能力词丢弃、tier 剥除）', () => {
    const back = patchToConfig(ID, { tier: 'full-access', tags: ['admin', 'fs', 'observe'] });
    expect(back.access).toBeUndefined(); // cr-1082：存量 tier 读侧剥除
    expect(back.levels).toEqual({ collab: 'admin', browser: 'observe' });
    expect((back as { tags?: unknown }).tags).toBeUndefined();
  });

  it('origin 随档案（agent.json 块——写透传既有 origin；cr-1004 批2 从 patch 块迁出）', () => {
    writeAgentPatch(ROOT, ID, { ...configToPatch(cfg), origin: { template: 'standard', hash: 'abc123' } });
    writeAgentConfig(ROOT, cfg); // 再写——origin 迁入 agent.json 不丢
    expect(readAgentProfileAt(agentDir(ROOT, ID))?.origin).toEqual({ template: 'standard', hash: 'abc123' });
  });

  it('v2 形态下旧映射读面让位（readAgentPatch → null——迁移窗口兼容）', () => {
    writeAgentConfig(ROOT, cfg);
    expect(readAgentPatch(ROOT, ID)).toBeNull();
  });

  it('坏档案（agent.json 非映射）→ throw fail-loud（v3 在场才进档案读面）', () => {
    writeAgentConfig(ROOT, cfg);
    fs.writeFileSync(path.join(agentDir(ROOT, ID), 'agent.json'), '[1,2]' + String.fromCharCode(10));
    expect(() => readAgentConfig(ROOT, ID)).toThrow('顶层必须是映射');
  });
});

describe('插件配置拆分（cr-906 批4 切片二）', () => {
  it('写拆分：settings → <unit>.json 文件；定义/档案不随行；读合成等价', () => {
    writeAgentConfig(ROOT, cfg);
    const dir = agentDir(ROOT, ID);
    expect(fs.existsSync(path.join(dir, 'run-code.json'))).toBe(true);
    expect(readAgentProfileAt(dir)?.levels).toBeUndefined(); // 档案不随行 settings
    expect(readPluginConfig(ROOT, ID, 'run-code')).toEqual({ mode: 'observe' });
    expect(readAgentConfig(ROOT, ID)).toEqual(cfgV3);
  });

  it('旧映射 patch（读窗退役——cr-1036 批3）：v3 被覆盖 = 缺席语义；readPluginConfigs 独立不受影响', () => {
    writeAgentConfig(ROOT, cfg);
    // 旧映射形态覆盖 v3（无 ac-menu 头）——读面视同缺席（残留死文件）
    fs.writeFileSync(path.join(agentDir(ROOT, ID), 'agent.patch.yml'),
      'tier: full-access' + String.fromCharCode(10) + 'settings:' + String.fromCharCode(10) + '  run-code:' + String.fromCharCode(10) + '    mode: admin' + String.fromCharCode(10));
    fs.rmSync(path.join(agentDir(ROOT, ID), 'agent.json'));
    expect(readAgentConfig(ROOT, ID)).toBeNull();
    expect(readPluginConfigs(ROOT, ID)).toEqual({ 'run-code': { mode: 'observe' } });
  });

  it('保留字/非法单元名拒绝；单文件读写往返', () => {
    expect(() => pluginConfigFile(ROOT, ID, 'config')).toThrow('保留字');
    expect(() => pluginConfigFile(ROOT, ID, 'a/b')).toThrow('词法非法');
    writePluginConfig(ROOT, ID, 'mcp', { servers: [1] });
    expect(readPluginConfig(ROOT, ID, 'mcp')).toEqual({ servers: [1] });
    expect(fs.existsSync(path.join(agentDir(ROOT, ID), 'config.json'))).toBe(false);
  });
});

describe('levels 档位（cr-1004 批2b / cr-1022 批2：归位菜单定义 config——不进即不装）', () => {
  it('写侧：levels → def.config.level（browser/collab 行锚定——行不在菜单则跳过；dev-tools 键退役）；读侧投影回 levels', () => {
    // rows 未点名 browser/collab-tools：levels 合并只对在场 def 生效（跳过，不静默长行）
    const withLevels: AgentConfig = {
      ...cfg,
      levels: { browser: 'inject', collab: 'admin', 'dev-tools': true },
    };
    writeAgentConfig(ROOT, withLevels);
    const dir = agentDir(ROOT, ID);
    const v3Miss = readAgentPatchV3At(dir)!;
    expect(v3Miss.defs.map((d) => d.id)).toEqual(['fs', 'web-tools']); // 不因档位长行
    expect(readAgentConfig(ROOT, ID)!.levels).toBeUndefined(); // 无锚定行 = 档位不落
    // rows 点名 browser/collab-tools：config.level 随定义落盘
    writeAgentConfig(ROOT, {
      ...withLevels,
      rows: { include: ['fs', 'web-tools', 'browser', 'collab-tools'] },
    });
    const v3 = readAgentPatchV3At(dir)!;
    expect(v3.defs).toContainEqual({ id: 'browser', config: { level: 'inject' } });
    expect(v3.defs).toContainEqual({ id: 'collab-tools', config: { level: 'admin' } });
    expect(v3.defs.some((d) => d.id === 'dev-tools')).toBe(false); // 退役键不落
    expect(readAgentProfileAt(dir)?.levels).toBeUndefined(); // 档案不再携带
    const back = readAgentConfig(ROOT, ID)!;
    expect(back.levels).toEqual({ browser: 'inject', collab: 'admin' });
  });
});

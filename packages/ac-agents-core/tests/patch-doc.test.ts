// ============================================================
// patch-doc.test.ts —— agent.patch.yml 双读/双落单测（cr-906 批4 切片一）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readAgentConfig, writeAgentConfig, agentDir } from '../src/tree.ts';
import { readAgentPatch, patchToConfig, configToPatch, writeAgentPatch, readAgentPatchV2At, readAgentProfileAt, PATCH_FILE, readPluginConfig, writePluginConfig, readPluginConfigs, pluginConfigFile } from '../src/patch-doc.ts';
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
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('agent.patch.yml v2 + agent.json（cr-1004 批2）', () => {
  it('写拆落：差量〔数组+基线戳〕+ 档案 agent.json；读面投影回 AgentConfig（结构化档位）', () => {
    writeAgentConfig(ROOT, cfg);
    const dir = agentDir(ROOT, ID);
    const v2 = readAgentPatchV2At(dir);
    expect(v2).not.toBeNull();
    expect(v2!.base).toMatch(/^[0-9a-f]{16}$/);
    expect(v2!.entries).toContainEqual({ id: 'fs' });
    expect(v2!.entries).toContainEqual({ id: 'sap-adt', disabled: true });
    const profile = readAgentProfileAt(dir)!;
    expect(profile.tier).toBe('full-access');
    expect(profile['tool-mode']).toBe('tc-programmatic');
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false); // 镜像退役
    const reread = readAgentConfig(ROOT, ID);
    expect(reread).toEqual(cfg); // v2 组合读投影等价
  });

  it('旧存量（仅 config.json）读路径不变——窗口兼容', () => {
    fs.mkdirSync(agentDir(ROOT, ID), { recursive: true });
    fs.writeFileSync(path.join(agentDir(ROOT, ID), 'config.json'), JSON.stringify(cfg), 'utf-8');
    expect(readAgentConfig(ROOT, ID)).toEqual(cfg);
  });

  it('镜像退役后删 patch = 身份缺席（回滚窗口已关闭——存量 config.json 根仍走旧读路径）', () => {
    writeAgentConfig(ROOT, cfg);
    fs.rmSync(path.join(agentDir(ROOT, ID), PATCH_FILE));
    expect(readAgentConfig(ROOT, ID)).toBeNull();
  });

  it('档位映射：结构化 access/toolMode ↔ tier/tool-mode；settings 随行；system 不迁', () => {
    const doc = configToPatch({ ...cfg, system: 'legacy prompt' });
    expect(doc.tier).toBe('full-access');
    expect(doc['tool-mode']).toBe('tc-programmatic');
    expect(doc.settings).toEqual({ 'run-code': { mode: 'observe' } });
    expect((doc as Record<string, unknown>).system).toBeUndefined();
    expect((doc as Record<string, unknown>).tags).toBeUndefined(); // tags 不再写
    const back = patchToConfig(ID, doc);
    expect(back.access).toBe('full-access');
    expect(back.toolMode).toBe('tc-programmatic');
    expect(back.settings).toEqual(cfg.settings);
  });

  it('存量 patch doc.tags 余词：读侧归一（admin/browser 入 levels、能力词丢弃）', () => {
    const back = patchToConfig(ID, { tier: 'full-access', tags: ['admin', 'fs', 'observe'] });
    expect(back.access).toBe('full-access');
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

  it('坏档案（agent.json 非映射）→ throw fail-loud；v2 差量坏形读 null', () => {
    fs.mkdirSync(agentDir(ROOT, ID), { recursive: true });
    fs.writeFileSync(path.join(agentDir(ROOT, ID), 'agent.json'), '[1,2]' + String.fromCharCode(10));
    fs.writeFileSync(path.join(agentDir(ROOT, ID), PATCH_FILE), '- a' + String.fromCharCode(10));
    expect(readAgentPatchV2At(agentDir(ROOT, ID))?.entries).toEqual([]); // 坏条目滤除（fail-soft 面）
    expect(() => readAgentConfig(ROOT, ID)).toThrow('顶层必须是映射');
  });
});

describe('插件配置拆分（cr-906 批4 切片二）', () => {
  it('写拆分：settings → <unit>.json 文件；差量/档案不随行；读合成等价', () => {
    writeAgentConfig(ROOT, cfg);
    const dir = agentDir(ROOT, ID);
    expect(fs.existsSync(path.join(dir, 'run-code.json'))).toBe(true);
    expect(readAgentProfileAt(dir)?.levels).toBeUndefined(); // 档案不随行 settings
    expect(readPluginConfig(ROOT, ID, 'run-code')).toEqual({ mode: 'observe' });
    expect(readAgentConfig(ROOT, ID)).toEqual(cfg);
  });

  it('单元文件赢过旧映射 patch 内联 settings（窗口存量兜底）；readPluginConfigs 扫全量', () => {
    writeAgentConfig(ROOT, cfg);
    // 旧映射形态内联 settings（存量窗口）——单元文件赢
    fs.writeFileSync(path.join(agentDir(ROOT, ID), 'agent.patch.yml'),
      'tier: full-access' + String.fromCharCode(10) + 'settings:' + String.fromCharCode(10) + '  run-code:' + String.fromCharCode(10) + '    mode: admin' + String.fromCharCode(10) + '  mcp:' + String.fromCharCode(10) + '    servers: []' + String.fromCharCode(10));
    fs.rmSync(path.join(agentDir(ROOT, ID), 'agent.json'));
    const merged = readAgentConfig(ROOT, ID);
    expect(merged?.settings?.['run-code']).toEqual({ mode: 'observe' });
    expect(merged?.settings?.mcp).toEqual({ servers: [] });
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

describe('levels 档位（cr-1004 批2b：归位装配条目 config——存储随差量条目走）', () => {
  it('写侧：levels → 条目 config.level（browser/collab 行锚定；dev-tools 键退役）；读侧投影回 levels', () => {
    const withLevels: AgentConfig = {
      ...cfg,
      levels: { browser: 'inject', collab: 'admin', 'dev-tools': true },
    };
    writeAgentConfig(ROOT, withLevels);
    const dir = agentDir(ROOT, ID);
    const v2 = readAgentPatchV2At(dir)!;
    expect(v2.entries).toContainEqual({ id: 'browser', config: { level: 'inject' } });
    expect(v2.entries).toContainEqual({ id: 'collab-tools', config: { level: 'admin' } });
    expect(v2.entries.some((e) => e.id === 'dev-tools')).toBe(false); // 退役键不落
    expect(readAgentProfileAt(dir)?.levels).toBeUndefined(); // 档案不再携带
    const back = readAgentConfig(ROOT, ID)!;
    expect(back.levels).toEqual({ browser: 'inject', collab: 'admin' });
  });
});

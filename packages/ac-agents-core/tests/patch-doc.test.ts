// ============================================================
// patch-doc.test.ts —— agent.patch.yml 双读/双落单测（cr-906 批4 切片一）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readAgentConfig, writeAgentConfig, agentDir } from '../src/tree.ts';
import { readAgentPatch, patchToConfig, configToPatch, writeAgentPatch, PATCH_FILE, readPluginConfig, writePluginConfig, readPluginConfigs, pluginConfigFile } from '../src/patch-doc.ts';
import type { AgentConfig } from '../src/config.ts';

const ROOT = path.join('sandbox', 'test-agent-patch-' + process.pid);
const ID = 'helper';
const cfg: AgentConfig = {
  id: ID, model: 'deepseek-chat', provider: 'deepseek',
  rows: { include: ['fs', 'web-tools'], exclude: ['sap-adt'] },
  tags: ['full-access', 'tc-programmatic'],
  llmParams: { temperature: 0.5 }, maxSteps: 40,
  name: 'Helper', description: '演示',
  settings: { 'run-code': { mode: 'observe' } },
};
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('agent.patch.yml 双读/双落（cr-906 批4）', () => {
  it('写双落：patch + config.json 镜像；patch 读面投影回 AgentConfig（tags 重建）', () => {
    writeAgentConfig(ROOT, cfg);
    const dir = agentDir(ROOT, ID);
    expect(fs.existsSync(path.join(dir, PATCH_FILE))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true); // 旧读者镜像
    const reread = readAgentConfig(ROOT, ID);
    expect(reread).toEqual(cfg); // patch 赢 + 投影等价（system 除外——退役面）
  });

  it('旧存量（仅 config.json）读路径不变——窗口兼容', () => {
    fs.mkdirSync(agentDir(ROOT, ID), { recursive: true });
    fs.writeFileSync(path.join(agentDir(ROOT, ID), 'config.json'), JSON.stringify(cfg), 'utf-8');
    expect(readAgentConfig(ROOT, ID)).toEqual(cfg);
  });

  it('回滚可逆：删 patch 即回 config.json 旧形态', () => {
    writeAgentConfig(ROOT, cfg);
    fs.rmSync(path.join(agentDir(ROOT, ID), PATCH_FILE));
    expect(readAgentConfig(ROOT, ID)).toEqual(cfg); // config.json 镜像承担回滚
  });

  it('档位词映射：tags 档位轴 ↔ tier/tool-mode；settings 随行；system 不迁', () => {
    const doc = configToPatch({ ...cfg, system: 'legacy prompt' });
    expect(doc.tier).toBe('full-access');
    expect(doc['tool-mode']).toBe('tc-programmatic');
    expect(doc.settings).toEqual({ 'run-code': { mode: 'observe' } });
    expect((doc as Record<string, unknown>).system).toBeUndefined();
    const back = patchToConfig(ID, doc);
    expect(tier(back)).toBe('full-access');
    expect(back.settings).toEqual(cfg.settings);
    function tier(c: AgentConfig): string { return c.tags?.[0] ?? 'base-access'; }
  });

  it('origin 块保留（写透传既有 origin——preset 对账面切片三接入）', () => {
    writeAgentPatch(ROOT, ID, { ...configToPatch(cfg), origin: { template: 'standard', hash: 'abc123' } });
    writeAgentConfig(ROOT, cfg); // 再写——origin 不丢
    expect(readAgentPatch(ROOT, ID)?.origin).toEqual({ template: 'standard', hash: 'abc123' });
  });

  it('坏 patch（顶层数组）→ throw fail-loud', () => {
    fs.mkdirSync(agentDir(ROOT, ID), { recursive: true });
    fs.writeFileSync(path.join(agentDir(ROOT, ID), PATCH_FILE), '- a' + String.fromCharCode(10));
    expect(() => readAgentConfig(ROOT, ID)).toThrow('顶层必须是映射');
  });
});

describe('插件配置拆分（cr-906 批4 切片二）', () => {
  it('写拆分：settings → <unit>.json 文件；patch 不随行；读合成等价', () => {
    writeAgentConfig(ROOT, cfg);
    const dir = agentDir(ROOT, ID);
    expect(fs.existsSync(path.join(dir, 'run-code.json'))).toBe(true);
    const patch = readAgentPatch(ROOT, ID);
    expect(patch?.settings).toBeUndefined();
    expect(readPluginConfig(ROOT, ID, 'run-code')).toEqual({ mode: 'observe' });
    expect(readAgentConfig(ROOT, ID)).toEqual(cfg);
  });

  it('单元文件赢过 patch 内联 settings（窗口存量兜底）；readPluginConfigs 扫全量', () => {
    writeAgentConfig(ROOT, cfg);
    writeAgentPatch(ROOT, ID, { ...configToPatch(cfg), settings: { 'run-code': { mode: 'admin' }, mcp: { servers: [] } } });
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

describe('levels 档位（cr-906 批4 切片四 / X1 回滚）', () => {
  it('config↔patch 往返保形；settings 同键档位并存时 levels 赢在读面由运行时合成', () => {
    const withLevels: AgentConfig = {
      ...cfg,
      levels: { browser: 'inject', collab: 'admin', 'dev-tools': true },
    };
    writeAgentConfig(ROOT, withLevels);
    const doc = readAgentPatch(ROOT, ID);
    expect(doc?.levels).toEqual({ browser: 'inject', collab: 'admin', 'dev-tools': true });
    expect(readAgentConfig(ROOT, ID)).toEqual(withLevels);
  });
});

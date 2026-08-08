// ============================================================
// src/services/agent-service 单元测试 —— Agent 管理服务（L4）
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agents/registry';
import { AgentService } from '../src/services/agent-service';
import { setGlobalConfig } from '../src/services/runtime';
import type { AgentConfig } from '../src/agents/config';

const cfgA: AgentConfig = {
  agent_id: 'a', name: 'A', tags: ['agent'],
  llm: { provider: 'deepseek', model: 'x' },
  description: 'desc',
} as AgentConfig;

beforeEach(() => {
  setGlobalConfig({
    $comment: 'note',
    llmProviders: {},
    searchProviders: {},
    workspaceDir: 'workspace/default',
    agentsDir: 'workspace/default/agents',
    maxHops: 3,
    namespaces: { 'agent.memory': { budget: 5 } },
  });
});
afterEach(() => { setGlobalConfig({}); });

describe('AgentService', () => {
  it('listBasic / list 从 registry 读取（含虚拟）', () => {
    const reg = new AgentRegistry();
    reg.register(cfgA);
    reg.register({ agent_id: 'user', name: '用户', virtual: true } as AgentConfig);

    const svc = new AgentService({ registry: reg });
    expect(svc.listBasic()).toEqual([
      { id: 'a', name: 'A', virtual: false },
      { id: 'user', name: '用户', virtual: true },
    ]);

    const infos = svc.list();
    expect(infos[0]).toMatchObject({
      agent_id: 'a', name: 'A', virtual: false, tags: ['agent'],
      llm: { provider: 'deepseek', model: 'x' },
    });
    expect(infos[1].virtual).toBe(true);
  });

  it('buildGlobalBase 排除 $ 与 namespaces、展平 namespaces', () => {
    const svc = new AgentService({ registry: new AgentRegistry() });
    const base = svc.buildGlobalBase();
    expect(base.$comment).toBeUndefined();
    expect(base.namespaces).toBeUndefined();
    expect(base['agent.memory']).toEqual({ budget: 5 });
    expect(base.workspaceDir).toBe('workspace/default');
  });

  it('getEffectiveConfig：合并全局基础 + 差异，删除全局专属键', () => {
    const svc = new AgentService({ registry: new AgentRegistry() });
    const eff = svc.getEffectiveConfig('a', {
      name: 'A',
      llm: { provider: 'deepseek' },
      maxHops: 9,
    } as Record<string, unknown>);
    expect(eff.agent_id).toBe('a');
    expect(eff.name).toBe('A');
    expect(eff.maxHops).toBeUndefined();      // 全局专属键删除
    expect(eff.workspaceDir).toBeUndefined(); // 全局专属键删除
    expect((eff.llm as Record<string, unknown>).provider).toBe('deepseek');
  });

  it('saveAgentConfig：剥离密钥到凭据存储、写差异配置', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-agent-'));
    process.env.AGENTCHAT_CREDENTIALS_FILE = path.join(tmp, 'creds.json');
    try {
      fs.mkdirSync(path.join(tmp, 'agentA'), { recursive: true });
      const svc = new AgentService({ registry: new AgentRegistry() });
      svc.saveAgentConfig('agentA', path.join(tmp, 'agentA'), {
        name: 'AgentA',
        llm: { provider: 'deepseek', api_key: 'sk-test' },
      });

      const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'agentA', 'config.json'), 'utf-8'));
      expect(saved.llm.api_key).toBeUndefined(); // 密钥已剥离
      expect(saved.llm.provider).toBe('deepseek');
      expect(saved.agent_id).toBe('agentA');
      // 密钥已进凭据存储
      const creds = JSON.parse(fs.readFileSync(path.join(tmp, 'creds.json'), 'utf-8'));
      expect(Object.keys(creds).some((k) => k.includes('AGENTA_DEEPSEEK'))).toBe(true);
    } finally {
      delete process.env.AGENTCHAT_CREDENTIALS_FILE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('writeMDFile：写文件 / 空内容删除', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-md-'));
    try {
      const svc = new AgentService({ registry: new AgentRegistry() });
      svc.writeMDFile(tmp, 'AGENT.md', '# 角色');
      expect(fs.readFileSync(path.join(tmp, 'AGENT.md'), 'utf-8')).toBe('# 角色');
      svc.writeMDFile(tmp, 'AGENT.md', '   ');
      expect(fs.existsSync(path.join(tmp, 'AGENT.md'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('hotReloadAgent：未注册 no-op；注册后重读磁盘配置刷新', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-reload-'));
    try {
      const reg = new AgentRegistry();
      reg.register({ ...cfgA, name: '旧名' });
      const svc = new AgentService({ registry: reg });
      // 未注册
      svc.hotReloadAgent('ghost', tmp);
      expect(reg.has('ghost')).toBe(false);

      // 写磁盘差异配置并热重载
      fs.mkdirSync(path.join(tmp, 'a'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'a', 'config.json'), JSON.stringify({ agent_id: 'a', name: '新名' }), 'utf-8');
      svc.hotReloadAgent('a', path.join(tmp, 'a'));
      expect(reg.get('a')?.name).toBe('新名');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('createAgentRuntime：缺 llm 抛错；有 llm 注册', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-create-'));
    try {
      const reg = new AgentRegistry();
      const svc = new AgentService({ registry: reg });
      const dir = path.join(tmp, 'a');
      fs.mkdirSync(dir, { recursive: true });

      // 无 llm 且全局无默认 → 抛错
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ agent_id: 'a', name: 'A' }), 'utf-8');
      expect(() => svc.createAgentRuntime(dir)).toThrow(/缺少 llm 配置/);

      // 带 llm → 注册
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        agent_id: 'a', name: 'A', llm: { provider: 'deepseek', model: 'x' },
      }), 'utf-8');
      svc.createAgentRuntime(dir);
      expect(reg.get('a')?.name).toBe('A');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('getAgentSystemPrompt / getAgentToolDefs：虚拟 Agent 抛错', async () => {
    const reg = new AgentRegistry();
    reg.register({ agent_id: 'user', name: '用户', virtual: true } as AgentConfig);
    const svc = new AgentService({ registry: reg });
    await expect(svc.getAgentSystemPrompt('user')).rejects.toThrow(/未找到/);
    expect(() => svc.getAgentToolDefs('user')).toThrow(/未找到/);
  });

  it('getAgentTimers 未注入定时服务返回空；saveAgentTimers 降级不抛', () => {
    const reg = new AgentRegistry();
    reg.register(cfgA);
    const svc = new AgentService({ registry: reg });
    expect(svc.getAgentTimers('a')).toEqual([]);
    expect(() => svc.saveAgentTimers('a', [])).not.toThrow();
  });

  it('unregister 从注册表移除', () => {
    const reg = new AgentRegistry();
    reg.register(cfgA);
    const svc = new AgentService({ registry: reg });
    svc.unregister('a');
    expect(reg.has('a')).toBe(false);
  });
});

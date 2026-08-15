// ============================================================
// src/services/config-service 单元测试 —— 配置门面（L4）
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService, configService } from '../src/config-service';
import { getGlobalConfig, setGlobalConfig } from '../src/runtime';
import { getCredential } from '@agentchat/agents';

let tmp: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  prevWs = process.env.AGENTCHAT_WORKSPACE;
  process.env.AGENTCHAT_WORKSPACE = tmp;                 // workspaceRoot() → tmp
  process.env.AGENTCHAT_CREDENTIALS_FILE = path.join(tmp, 'creds.json');
  setGlobalConfig({});
});
afterEach(() => {
  if (prevWs === undefined) delete process.env.AGENTCHAT_WORKSPACE;
  else process.env.AGENTCHAT_WORKSPACE = prevWs;
  delete process.env.AGENTCHAT_CREDENTIALS_FILE;
  setGlobalConfig({});
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ConfigService', () => {
  it('getGlobalConfig 返回 runtime 持有', () => {
    setGlobalConfig({ workspaceDir: 'ws', llmProviders: {} });
    expect(configService.getGlobalConfig().workspaceDir).toBe('ws');
  });

  it('reloadGlobalConfig 重读 <workspaceRoot()>/config.json', () => {
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ workspaceDir: 'ws2', llm: { provider: 'deepseek' } }), 'utf-8');
    const cfg = configService.reloadGlobalConfig();
    // workspaceDir 相对值 → 与 loadGlobalConfig 一致解析为绝对路径（相对 cwd 派生）
    expect(cfg).toMatchObject({ workspaceDir: path.resolve(process.cwd(), 'ws2') });
    expect(getGlobalConfig().llm).toMatchObject({ provider: 'deepseek' });
  });

  it('reloadGlobalConfig 合并默认值（viewerId 不丢，避免 chat~admin~undefined）', () => {
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ llmProviders: { a: {} } }), 'utf-8');
    const cfg = configService.reloadGlobalConfig();
    expect(cfg?.viewerId).toBe('user');
    expect(cfg?.maxHops).toBe(5);
    expect(cfg?.agentsDir).toBe(path.join(tmp, 'agents'));
  });

  it('reloadGlobalConfig 原地更新对象引用（AgentLoader 捕获的引用同步生效）', () => {
    const held: Record<string, any> = { old: true };
    setGlobalConfig(held);
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ new: true }), 'utf-8');
    configService.reloadGlobalConfig();
    expect(getGlobalConfig()).toBe(held);
    expect(held.new).toBe(true);
    expect('old' in held).toBe(false);
  });

  it('reloadGlobalConfig 文件不存在返回 null 且保持原配置', () => {
    setGlobalConfig({ keep: true });
    expect(configService.reloadGlobalConfig()).toBeNull();
    expect(getGlobalConfig().keep).toBe(true);
  });

  it('setCredential / getCredential 全局凭据往返', () => {
    configService.setCredential('deepseek', 'sk-global');
    expect(configService.getCredential('deepseek')).toBe('sk-global');
    // 落到凭据文件（加密存储）
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'creds.json'), 'utf-8'));
    expect(Object.keys(raw).some((k) => k.includes('DEEPSEEK'))).toBe(true);
  });

  it('setAgentCredential 写 Agent 级凭据', () => {
    configService.setAgentCredential('agentA', 'deepseek', 'sk-agent');
    expect(getCredential('agentA', 'deepseek')).toBe('sk-agent');
    expect(configService.getCredential('deepseek')).toBeUndefined(); // 全局未设
  });

  it('类可独立实例化（单例兼容）', () => {
    const svc = new ConfigService();
    setGlobalConfig({ a: 1 });
    expect(svc.getGlobalConfig().a).toBe(1);
  });
});

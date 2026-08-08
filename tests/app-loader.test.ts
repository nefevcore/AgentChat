// ============================================================
// src/app/loader 单元测试 —— 统一装配（L5）
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGlobalConfig, resolveLLMPool, resolveSearchPool, AgentLoader } from '../src/app/loader';

let tmp: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-loader-'));
  prevWs = process.env.AGENTCHAT_WORKSPACE;
  process.env.AGENTCHAT_WORKSPACE = tmp;
  process.env.AGENTCHAT_CREDENTIALS_FILE = path.join(tmp, 'creds.json');
});
afterEach(() => {
  if (prevWs === undefined) delete process.env.AGENTCHAT_WORKSPACE;
  else process.env.AGENTCHAT_WORKSPACE = prevWs;
  delete process.env.AGENTCHAT_CREDENTIALS_FILE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('loadGlobalConfig', () => {
  it('默认值 + 派生路径（agents/sessions/groups）', () => {
    const cfg = loadGlobalConfig();
    expect(cfg.workspaceDir).toBe(tmp);
    expect(cfg.agentsDir).toBe(path.join(tmp, 'agents'));
    expect(cfg.sessionsDir).toBe(path.join(tmp, 'sessions'));
    expect(cfg.groupsDir).toBe(path.join(tmp, 'groups'));
    expect(cfg.maxHops).toBe(5);
    expect(cfg.timezone).toBe('Asia/Shanghai');
    expect(cfg.viewerId).toBe('user');
  });

  it('读取 config.json + 命名空间（含 "." 键）解析', () => {
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
      maxHops: 3,
      'tool.bash': { defaultTimeout: 30000 },
      llmProviders: { 'deepseek-v4-flash': { provider: 'deepseek', model: 'x', default: true } },
    }), 'utf-8');
    const cfg = loadGlobalConfig();
    expect(cfg.maxHops).toBe(3);
    expect(cfg.namespaces['tool.bash']).toEqual({ defaultTimeout: 30000 });
    expect(cfg.llmProviders['deepseek-v4-flash'].model).toBe('x');
  });

  it('wsOverride 参数优先于环境变量', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'app-loader-other-'));
    const cfg = loadGlobalConfig(other);
    expect(cfg.workspaceDir).toBe(other);
    fs.rmSync(other, { recursive: true, force: true });
  });
});

describe('resolveLLMPool', () => {
  const gc = {
    llmProviders: {
      deepseek: { provider: 'deepseek', model: 'deepseek-v4-flash', default: true },
      openai: { provider: 'openai', model: 'gpt-4o' },
    },
  };

  it('纯字符串 = 池引用', () => {
    const r = resolveLLMPool('deepseek', gc);
    expect(r?.provider).toBe('deepseek');
    expect(r?.$ref).toBe('deepseek');
  });

  it('undefined → 池默认条目（default:true）', () => {
    const r = resolveLLMPool(undefined, gc);
    expect(r?.$ref).toBe('deepseek');
  });

  it('$ref + 字段覆盖', () => {
    const r = resolveLLMPool({ $ref: 'deepseek', temperature: 0.5 } as any, gc);
    expect(r?.temperature).toBe(0.5);
    expect(r?.$ref).toBe('deepseek');
  });

  it('model 匹配池条目自动解析为引用', () => {
    const r = resolveLLMPool({ model: 'deepseek' } as any, gc);
    expect(r?.$ref).toBe('deepseek');
  });

  it('内嵌配置（有 provider）原样返回', () => {
    const r = resolveLLMPool({ provider: 'openai', model: 'gpt-4o' }, gc);
    expect(r?.model).toBe('gpt-4o');
    expect(r?.$ref).toBeUndefined();
  });

  it('池条目不存在：纯字符串 undefined；$ref 回退内嵌配置', () => {
    expect(resolveLLMPool('nope', gc)).toBeUndefined();
    // $ref 池缺失 → 保留 $ref 回退内嵌（照搬旧语义）
    const r = resolveLLMPool({ $ref: 'nope', model: 'fallback' } as any, gc);
    expect(r?.$ref).toBe('nope');
    expect(r?.model).toBe('fallback');
  });

  it('环境变量引用解析 ${VAR}', () => {
    process.env.TEST_LLM_KEY = 'sk-env';
    const r = resolveLLMPool({ provider: 'openai', api_key: '${TEST_LLM_KEY}' }, gc);
    expect(r?.api_key).toBe('sk-env');
  });
});

describe('resolveSearchPool', () => {
  const gc = {
    searchProviders: {
      tavily: { provider: 'tavily', default: true },
      brave: { provider: 'brave' },
    },
  };

  it('无配置 → 池默认条目', () => {
    const r = resolveSearchPool(undefined, gc);
    expect(r?.$ref).toBe('tavily');
  });

  it('$ref 引用', () => {
    const r = resolveSearchPool({ $ref: 'brave' } as any, gc);
    expect(r?.provider).toBe('brave');
  });

  it('内嵌简写（无 provider/apiKey）自动合并默认池', () => {
    const r = resolveSearchPool({ defaultResults: 10 } as any, gc);
    expect(r?.$ref).toBe('tavily');
    expect(r?.defaultResults).toBe(10);
  });

  it('有 provider 的内嵌配置原样返回', () => {
    const r = resolveSearchPool({ provider: 'tavily', tavilyApiKey: 'k' } as any, gc);
    expect(r?.$ref).toBeUndefined();
  });
});

describe('AgentLoader', () => {
  it('loadAll 读取 agents 目录 + 池引用解析 + 全局基础合并', () => {
    const gc = loadGlobalConfig();
    gc.llmProviders = { deepseek: { provider: 'deepseek', model: 'x', default: true } };

    fs.mkdirSync(path.join(tmp, 'agents', 'a'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'agents', 'a', 'config.json'), JSON.stringify({
      agent_id: 'a', name: 'A',
      plugins: [{ name: 'builtin', tools: ['read'] }],
      llm: 'deepseek', // 池引用
    }), 'utf-8');
    fs.mkdirSync(path.join(tmp, 'agents', 'user'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'agents', 'user', 'config.json'), JSON.stringify({
      agent_id: 'user', name: '用户', virtual: true,
    }), 'utf-8');

    const loader = new AgentLoader(gc);
    const loaded = loader.loadAll();
    expect(loaded.length).toBe(2);

    const a = loaded.find((l) => l.config.agent_id === 'a');
    expect(a?.config.name).toBe('A');
    expect(a?.config.llm).toMatchObject({ provider: 'deepseek', $ref: 'deepseek' });
    expect((a?.config.llm as any).api_key).toBe(''); // 无凭据 → 空串

    const user = loaded.find((l) => l.config.agent_id === 'user');
    expect(user?.config.virtual).toBe(true);
  });

  it('Agent 差异覆盖全局基础 + 命名空间合并', () => {
    const gc = loadGlobalConfig();
    gc.maxHops = 5;
    gc.namespaces['agent.memory'] = { budget: 1000 };

    fs.mkdirSync(path.join(tmp, 'agents', 'a'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'agents', 'a', 'config.json'), JSON.stringify({
      agent_id: 'a', name: 'A', maxHops: 9, 'agent.memory': { budget: 500 },
    }), 'utf-8');

    const [l] = new AgentLoader(gc).loadAll();
    expect(l.config.maxHops).toBe(9);
    expect((l.config as any)['agent.memory']).toEqual({ budget: 500 });
  });

  it('loadOne 无 config.json 抛错', () => {
    const loader = new AgentLoader(loadGlobalConfig());
    expect(() => loader.loadOne(path.join(tmp, 'nope'))).toThrow(/无 config.json/);
  });

  it('loadAll 跳过无 config.json 的目录', () => {
    fs.mkdirSync(path.join(tmp, 'agents', 'empty'), { recursive: true });
    const loader = new AgentLoader(loadGlobalConfig());
    expect(loader.loadAll()).toEqual([]);
  });

  it('全局无 LLM 池且 Agent 无 llm → config.llm 缺省', () => {
    fs.mkdirSync(path.join(tmp, 'agents', 'a'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'agents', 'a', 'config.json'), JSON.stringify({
      agent_id: 'a', name: 'A',
    }), 'utf-8');
    const [l] = new AgentLoader(loadGlobalConfig()).loadAll();
    expect(l.config.llm).toBeUndefined();
  });
});

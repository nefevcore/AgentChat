// ============================================================
// tests/port-b.test.ts —— Port B 模块锁测试（阶段二第一梯）
//
// 锁的是换端口后的新契约：src/api/{wire,usage,system} 以 preview
// 词汇直连（rpc 方法名 + 原生形状），映射与降级语义钉死在此。
// 适配器退役（收口）时本测试原样存活——它不依赖 adapter。
// ============================================================

import { describe, it, expect } from 'vitest';
import { toUsageSummary, filterUsageRange, fetchUsageTokens, type PUsageResult } from '../src/api/usage.ts';
import { fetchVersion, fetchChangelog, runVersionUpdate, backupNow } from '../src/api/system.ts';
import * as settings from '../src/settings/api.ts';
import { fetchAgents, createAgent, fetchAgentModels, fetchLlmProviders, fetchPools, fetchSessionTokens, toAgentList, fetchAgentPresets } from '../src/api/roster.ts';
import { fetchGroups, createGroup, updateGroup, deleteGroup, fetchGroupHistory, setGroupMemoryOwner } from '../src/api/groups.ts';
import { fetchSingles, createSingle, updateSingle, archiveSingle, deleteSingle } from '../src/api/singles.ts';
import { fetchRuns, interruptRun, fetchPairHistory, toRunsSnapshot, convKeyToId } from '../src/api/runs.ts';
import { chatPresence } from '../src/api/chat-ops';

const USAGE: PUsageResult = {
  byAgent: { helper: { prompt: 10, completion: 5, total: 15, runs: 2, steps: 3, cacheHit: 4 } },
  byModel: { 'glm-5.3': { prompt: 10, completion: 5, total: 15, runs: 2 } },
  byDay: [
    { date: '2026-08-20', prompt: 4, completion: 2, total: 6, runs: 1 },
    { date: '2026-08-23', prompt: 10, completion: 5, total: 15, runs: 2, lastContextPrompt: 8 },
  ],
  byDayModel: [
    { date: '2026-08-20', model: 'glm-5.3', prompt: 4, completion: 2, total: 6, runs: 1 },
    { date: '2026-08-23', model: 'glm-5.3', prompt: 7, completion: 3, total: 10, runs: 1 },
    { date: '2026-08-23', model: 'deepseek-v4-flash', prompt: 3, completion: 2, total: 5, runs: 1 },
  ],
  byConversation: { helper: { prompt: 10, completion: 5, total: 15, runs: 2 }, 'g~x': { prompt: 99, completion: 0, total: 99, runs: 9 } },
  totals: { prompt: 10, completion: 5, total: 15, runs: 2, steps: 3, cacheHit: 4, lastContextPrompt: 8 },
};

describe('Port B：api/usage（usage/tokens 直连）', () => {
  it('形状映射：overall/by_agent/by_day/by_pair（byPair 优先；无 byPair 旧后端推导且未知名不入弦）', () => {
    const s = toUsageSummary(USAGE);
    expect(s.overall).toMatchObject({ total_prompt_tokens: 10, total_completion_tokens: 5, total_react_steps: 3, total_cache_hit: 4, total_records: 2, last_step_prompt_tokens: 8 });
    expect(s.by_agent[0]).toMatchObject({ agent: 'helper', total_tokens: 15, record_count: 2 });
    expect(s.by_day).toHaveLength(2);
    expect(s.by_day[1]).toMatchObject({ date: '2026-08-23', last_step_prompt_tokens: 8 });
    // 旧后端（无 byPair）：byConversation 推导——helper 是名册 agent → user 弦；
    // g~x（对键）与 'sid-9'（未知名/群）跳过防错挂
    const agentIds = new Set(['helper', 'user']);
    const legacy = toUsageSummary({ ...USAGE, byConversation: { ...USAGE.byConversation, 'sid-9': { prompt: 1, completion: 1, total: 2, runs: 1 } } }, agentIds);
    expect(legacy.by_pair).toEqual([{ a: 'user', b: 'helper', total_tokens: 15, record_count: 2 }]);
    // 新后端 byPair：端点对原样消费（含 agent⇄agent）
    const withPair = toUsageSummary({
      ...USAGE,
      byPair: [
        { a: 'user', b: 'helper', prompt: 10, completion: 5, total: 15, runs: 2 },
        { a: 'alpha', b: 'beta', prompt: 7, completion: 3, total: 10, runs: 1 },
      ],
    });
    expect(withPair.by_pair).toEqual([
      { a: 'user', b: 'helper', total_tokens: 15, record_count: 2 },
      { a: 'alpha', b: 'beta', total_tokens: 10, record_count: 1 },
    ]);
    // byDayModel → by_day_llm（「按模型」堆叠图数据源；旧后端缺失 → 空数组非 undefined）
    expect(s.by_day_llm).toEqual([
      { date: '2026-08-20', llm: 'glm-5.3', total_prompt_tokens: 4, total_completion_tokens: 2, total_tokens: 6 },
      { date: '2026-08-23', llm: 'glm-5.3', total_prompt_tokens: 7, total_completion_tokens: 3, total_tokens: 10 },
      { date: '2026-08-23', llm: 'deepseek-v4-flash', total_prompt_tokens: 3, total_completion_tokens: 2, total_tokens: 5 },
    ]);
    expect(toUsageSummary({ ...USAGE, byDayModel: undefined }).by_day_llm).toEqual([]);
    expect(s.range).toEqual({ from: '2026-08-20', to: '2026-08-23' });
  });

  it('日期范围过滤：by_day 行过滤 + overall 重算', () => {
    const base = toUsageSummary(USAGE);
    const filtered = filterUsageRange(base, { from: '2026-08-21', to: '2026-08-31' });
    expect(filtered.by_day.map((d) => d.date)).toEqual(['2026-08-23']);
    expect(filtered.by_day_llm?.map((d) => `${d.date}|${d.llm}`).sort()).toEqual(['2026-08-23|deepseek-v4-flash', '2026-08-23|glm-5.3']);
    expect(filtered.overall.total_prompt_tokens).toBe(10);
    expect(filtered.overall.total_records).toBe(2);
    const unfiltered = filterUsageRange(base, {});
    expect(unfiltered).toBe(base);
  });

  it('fetchUsageTokens：usage/tokens + agents/list 聚合（名册供旧后端 fallback 判别；失败容忍）', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const summary = await fetchUsageTokens({ days: 30 }, {
      async call(method, params) {
        calls.push({ method, params });
        if (method === 'agents/list') return { agents: [{ id: 'helper' }] };
        return USAGE;
      },
    });
    expect(calls.map((c) => c.method).sort()).toEqual(['agents/list', 'usage/tokens']);
    expect(summary.by_day).toHaveLength(2); // days=30 覆盖全部测试日期
    expect(summary.by_agent[0]).toMatchObject({ agent: 'helper' });
    // agents/list reject → 容忍（summary 照常，仅 fallback 判别降级）
    const summary2 = await fetchUsageTokens({}, {
      async call(method) {
        if (method === 'agents/list') throw new Error('boom');
        return USAGE;
      },
    });
    expect(summary2.by_agent[0]).toMatchObject({ agent: 'helper' });
  });
});

describe('Port B：api/system（version/backup 直连 + 显式降级）', () => {
  it('fetchVersion：system/version → {current}（latest/hasUpdate 显式缺省）', async () => {
    const r = await fetchVersion(false, { async call() { return { current: '1.2.3', name: 'agentchat' }; } });
    expect(r).toEqual({ current: '1.2.3' });
    expect(r.hasUpdate).toBeUndefined();
  });

  it('backupNow：backup/run → Sidebar 契约形状', async () => {
    const r = await backupNow({ async call() { return { backup: { file: 'b.zip', size: 123, backups: [{}, {}, {}, {}] } }; } });
    expect(r).toEqual({ status: 'ok', file: 'b.zip', size: 123, keep: 4 });
  });

  it('降级面：changelog 空文案 / 更新 unavailable（不垫假数据）', async () => {
    expect((await fetchChangelog()).content).toContain('preview');
    expect(await runVersionUpdate()).toMatchObject({ status: 'unavailable' });
  });
});

describe('Port B：settings/api（设置域直连，第二梯）', () => {
  function recorder(results: Record<string, unknown>) {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    return {
      calls,
      rpc: {
        async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
          calls.push({ method, params });
          if (!(method in results)) throw new Error(`unexpected rpc ${method}`);
          return results[method] as T;
        },
      },
    };
  }

  it('getPools：config/get 白名单域合成 PoolData', async () => {
    const { rpc, calls } = recorder({ 'config/get': { config: { llmProviders: { glm: { model: 'glm-5.3' } }, searchProviders: { tavily: {} } } } });
    const r = await settings.getPools(rpc);
    expect(calls.map((c) => c.method)).toEqual(['config/get']);
    expect(r).toEqual({ llmProviders: { glm: { model: 'glm-5.3' } }, searchProviders: { tavily: {} } });
  });

  it('getAgentConfig：get-config + SYSTEM/AGENT.md 并取 → AgentConfigViews（池名回显 $ref；allowedPaths 不物化——插件配置页单源）', async () => {
    const { rpc, calls } = recorder({
      'agents/get-config': { config: { id: 'helper', description: '小助手', provider: 'glm', model: 'glm-5.3', llmParams: { temperature: 0.7 }, settings: { security: { enabled: true, allowedPaths: ['/tmp/x', '../shared'] } } } },
      'agents/read-doc': { content: '# S' },
      'config/get': { config: { llmProviders: { glm: { defaultModel: 'glm-5.3' } }, searchProviders: {} } },
    });
    const r = await settings.getAgentConfig('helper', rpc);
    expect(calls.map((c) => c.method).sort()).toEqual(['agents/get-config', 'agents/read-doc', 'agents/read-doc', 'config/get']);
    expect(r.agent_id).toBe('helper');
    // P5：$ref 回显按 provider 名（池条目名 = provider 名）；连接字段不出视图
    expect(r.raw).toMatchObject({ name: '小助手', llm: { provider: 'glm', model: 'glm-5.3', temperature: 0.7, $ref: 'glm' } });
    expect(r.raw.llm).not.toHaveProperty('api_key');
    expect(r.sysContent).toBe('# S');
    // 原「安全」页签已移除：allowedPaths 不再物化进视图（读写走插件配置页 assembly 契约）
    expect(r.raw.allowedPaths).toBeUndefined();
    // 池无同名条目 → 不设 $ref
    const miss = await settings.getAgentConfig('helper', recorder({
      'agents/get-config': { config: { id: 'helper', provider: 'openai', model: 'gpt-x' } },
      'agents/read-doc': {},
      'config/get': { config: { llmProviders: { glm: { defaultModel: 'glm-5.3' } } } },
    }).rpc);
    expect(miss.raw.llm.$ref).toBeUndefined();
    // config/get 失败容忍（不设 $ref，不阻断配置读取）
    const degraded = await settings.getAgentConfig('helper', {
      async call<T>(method: string): Promise<T> {
        if (method === 'agents/get-config') return { config: { id: 'helper', provider: 'glm', model: 'glm-5.3' } } as T;
        if (method === 'config/get') throw new Error('config/get 不可用');
        return {} as T;
      },
    });
    expect(degraded.raw.llm.$ref).toBeUndefined();
  });

  it('saveAgentConfig：patch 映射 + 文档双写（空串=删）+ llmParams 白名单全集（连接凭据已退役；无 allowedPaths 映射）', async () => {
    const { rpc, calls } = recorder({
      'agents/update-config': { config: {}, changed: [] },
      'agents/save-doc': { saved: true },
    });
    await settings.saveAgentConfig('helper', {
      config: {
        agent_id: 'helper',
        name: '新名',
        llm: { provider: 'glm', model: 'glm-5.3', temperature: 0.3, top_p: 0.9, stop: 'END', response_format: 'json_object', max_tokens: 4096, reasoning_effort: 'high', thinking: true },
      },
      sysContent: '# 系统',
      agentContent: '',
    }, rpc);
    const byMethod = (m: string) => calls.filter((c) => c.method === m);
    // P4/D3：无 set-credential 调用（连接凭据锁死 provider 定义）
    expect(byMethod('agents/set-credential')).toEqual([]);
    expect(byMethod('agents/update-config')[0].params!.patch).toMatchObject({
      name: '新名', provider: 'glm', model: 'glm-5.3',
      llmParams: { temperature: 0.3, top_p: 0.9, stop: 'END', response_format: 'json_object', max_tokens: 4096, reasoning_effort: 'high', thinking: true },
    });
    expect(byMethod('agents/save-doc')[0].params).toMatchObject({ name: 'SYSTEM.md', content: '# 系统' });
    expect(byMethod('agents/save-doc')[1].params).toMatchObject({ name: 'AGENT.md', content: '' });
    // 配置里混入 allowedPaths（历史视图残留）也不上送——settings.security 单源走 assembly 契约
    const bare = recorder({
      'agents/update-config': { config: {}, changed: [] },
      'agents/save-doc': { saved: true },
    });
    await settings.saveAgentConfig('helper', { config: { name: 'n', llm: { model: 'm' }, allowedPaths: ['/tmp/x'] } }, bare.rpc);
    const barePatch = bare.calls.find((c) => c.method === 'agents/update-config')!.params!.patch as Record<string, unknown>;
    expect(barePatch.settings).toBeUndefined();
    // model '' = 「默认」（按全局默认模型处理）→ 显式 null 清除（服务端
    // deepMerge 以 null 覆盖落存，投递侧回落默认池连接）
    const def = recorder({
      'agents/update-config': { config: {}, changed: [] },
      'agents/save-doc': { saved: true },
    });
    await settings.saveAgentConfig('helper', { config: { llm: { model: '' } } }, def.rpc);
    const defPatch = def.calls.find((c) => c.method === 'agents/update-config')!.params!.patch as Record<string, unknown>;
    expect(defPatch.model).toBeNull();
  });

  it('getAssembly/saveAssembly：preview 形状直连（无适配层）；保存 = 单次 update + 回读（无 read-modify-write）', async () => {
    const assembly = {
      agentId: 'helper',
      settings: { enabled: ['persona'], configs: { persona: { enabled: false }, memory: { maxTokens: 800 } } },
      tools: { include: ['hello'], exclude: [], enabled: ['hello'], catalog: [{ name: 'hello', description: 'd', parameters: {} }] },
    };
    const { rpc, calls } = recorder({
      'agents/assembly': { assembly },
      'agents/assembly/update': { config: {}, changed: [] },
    });
    const r = await settings.getAssembly('helper', rpc);
    // 直连形状：settings = 具名配置（configs 原样），tools 意图/生效集/目录
    expect(r.assembly.agentId).toBe('helper');
    expect(r.assembly.settings.configs).toEqual({ persona: { enabled: false }, memory: { maxTokens: 800 } });
    expect(r.assembly.tools).toMatchObject({ include: ['hello'], enabled: ['hello'] });
    expect(r.assembly.tools.catalog[0]).toMatchObject({ name: 'hello', description: 'd' });
    // 空装配容忍（settings/tools 缺省 → 归一化空集，不抛错）
    const empty = await settings.getAssembly('bare', recorder({
      'agents/assembly': { assembly: { agentId: 'bare' } },
    }).rpc);
    expect(empty.assembly.settings).toEqual({ enabled: [], configs: {} });
    expect(empty.assembly.tools.catalog).toEqual([]);
    // 保存：settings per-name 浅合并补丁原样透传（合并语义在服务端——M22 D5）
    const saved = await settings.saveAssembly('helper', {
      tools: { include: ['hello'] },
      settings: { persona: { enabled: true }, memory: null },
    }, rpc);
    expect(saved.assembly.settings.configs.memory).toBeDefined(); // 回读 = recorder 回显
    expect(calls.map((c) => c.method)).toEqual(['agents/assembly', 'agents/assembly/update', 'agents/assembly']);
    const update = calls.find(c => c.method === 'agents/assembly/update')!.params as { agentId: string; patch: Record<string, unknown> };
    expect(update.patch).toEqual({
      tools: { include: ['hello'] },
      settings: { persona: { enabled: true }, memory: null },
    });
  });

  it('getCatalog/getLibrary/getPermissions：五源合成（manifest 映射 + 按名去重 + 扩展目录/dev 扫描/装载状态透传）', async () => {
    const { rpc } = recorder({
      'plugin/rows': {
        rows: [
          { name: 'ac-fs-tools', fibers: 2, active: true, origin: 'package', description: '文件读写工具行：read/write/edit——沙箱基线随行', version: '0.1.0' },
          { name: 'ac-webui', fibers: 1, active: true, origin: 'package', description: 'Web UI 扩展宿主服务行' },
          // 进程内部行（loader/内联回调）——plugins 合成过滤；rows 原样透传
          { name: 'syncHeartbeat', fibers: 1, active: true, origin: 'internal' },
        ],
      },
      'plugin/loaded': {
        loaded: [
          { name: 'p1', sessionOnly: false, manifest: { name: 'p1', version: '1.0', description: '动态装载行', permissions: ['fs', 'network'] }, allowedPermissions: ['fs'] },
          { name: 'sess', sessionOnly: true, dir: '/d/sess', agentId: 'helper' },
        ],
        failed: [{ name: 'broken', error: '插件入口不存在: /x/broken/index.ts' }],
      },
      'plugin/installed': { installed: [{ manifest: { name: 'p1', version: '1.0', description: '已安装行' }, permissions: ['fs'], owner: 'host', dir: 'p1', installedAt: '2026-01-01' }, { manifest: { name: 'broken', version: '2.0' }, dir: 'broken' }] },
      'tools/list': { tools: [{ name: 'hello', description: 'd', requiredTags: [] }] },
      'plugin/extension-catalog': {
        extensions: [
          { name: 'persona', row: 'ac-persona', label: '人设注入', description: 'AGENT.md / persona 文本角色块前置注入', targets: ['loop/before-run'], fields: ['text', 'file'] },
          { name: 'security', row: 'ac-security', label: '安全检查·脱敏', description: '门禁 + 脱敏', targets: ['tool/before-execute', 'tool/transform-result'], fields: ['capabilities', 'workdir', 'allowedPaths', 'denyPaths'] },
          { name: 'web-tools', row: 'ac-web-tools', label: '网络工具行', description: '工具行', targets: [], automatic: true },
        ],
      },
      'plugin/staging-list': { staging: [] },
      'plugin/dev-scan': { root: 'C:/data', dev: [{ name: 'my-tool', version: '0.2.0', owner: 'helper', dir: 'C:/data/plugins/helper/my-tool' }] },
      'plugin/permissions': { permissions: ['fs', 'ui'], defaultGrants: ['fs'], executionExplicitRequired: ['shell'], reviewExplicitRequired: [] },
    });
    const cat = await settings.getCatalog(rpc);
    const byName = new Map(cat.plugins.map((p) => [p.name, p]));
    // 装配行 → builtin 条目（描述来自行包 package.json）
    expect(byName.get('ac-fs-tools')).toMatchObject({ name: 'ac-fs-tools', source: 'builtin', description: expect.stringContaining('文件读写'), version: '0.1.0' });
    // internal 行不进 plugins 合成；rows 原样透传（插件库「装配行」页签）
    expect(byName.has('syncHeartbeat')).toBe(false);
    expect(cat.rows).toHaveLength(3);
    expect(cat.rows[2]).toMatchObject({ name: 'syncHeartbeat', origin: 'internal' });
    // 同名 loaded + installed → 合并为一条 source 'installed'（installed 信息优先，granted 保留）
    expect(cat.plugins.filter((p) => p.name === 'p1')).toHaveLength(1);
    expect(byName.get('p1')).toMatchObject({ source: 'installed', version: '1.0', description: '已安装行', grantedPermissions: ['fs'], owner: 'host' });
    // 会话级装载 → session 源
    expect(byName.get('sess')).toMatchObject({ source: 'session' });
    // 装载状态透传（安装卡片三态徽章——M22 D6）
    expect(cat.loaded).toEqual(['p1', 'sess']);
    expect(cat.failed).toEqual([{ name: 'broken', error: expect.stringContaining('入口不存在') }]);
    // 扩展目录（后端词汇表——M22 D4）
    expect(cat.extensions).toHaveLength(3);
    expect(cat.extensions.find(e => e.name === 'security')?.targets).toEqual(['tool/before-execute', 'tool/transform-result']);
    expect(cat.extensions.find(e => e.name === 'web-tools')).toMatchObject({ automatic: true, targets: [] });
    expect(cat.tools[0]).toMatchObject({ name: 'hello', description: 'd' });
    // 库：installed + staging + dev 扫描 + 数据根（M22 D7）
    const lib = await settings.getLibrary(rpc);
    expect(lib.installed[0]).toMatchObject({ name: 'p1', source: 'installed', version: '1.0', owner: 'host', description: '已安装行' });
    expect(lib.root).toBe('C:/data');
    expect(lib.dev).toEqual([{ name: 'my-tool', version: '0.2.0', owner: 'helper', dir: 'C:/data/plugins/helper/my-tool' }]);
    const perm = await settings.getPermissions(rpc);
    expect(perm).toEqual({ vocabulary: ['fs', 'ui'], defaultGranted: ['fs'], explicitRequired: ['shell'] });
    // 旧后端容错：extension-catalog / dev-scan 缺面 → 空集不阻断
    const legacy = await settings.getCatalog({
      async call<T>(method: string): Promise<T> {
        if (method === 'plugin/loaded') return { loaded: [] } as T;
        if (method === 'plugin/installed') return { installed: [] } as T;
        if (method === 'plugin/rows') throw new Error('无此面');
        if (method === 'plugin/extension-catalog') throw new Error('无此面');
        if (method === 'tools/list') return { tools: [] } as T;
        throw new Error(`unexpected ${method}`);
      },
    });
    expect(legacy.extensions).toEqual([]);
    expect(legacy.rows).toEqual([]);
  });

  it('timer 读写 + schema/市场/browse 降级', async () => {
    const { rpc, calls } = recorder({
      'timer/entries': { entries: [{ id: 't1', enabled: true, mode: 'time', time: '09:00', hint: 'h' }] },
      'timer/save': { saved: true, owner: 'helper' },
    });
    const t = await settings.getAgentTimers('helper', rpc);
    expect(t.entries[0]).toMatchObject({ id: 't1', mode: 'time' });
    await settings.saveAgentTimers('helper', t.entries, rpc);
    expect(calls.map((c) => c.method)).toEqual(['timer/entries', 'timer/save']);
    // LLM schema = 内置字段表（三 provider 键 + 采样白名单全集；P5 连接
    // 字段 api_key/base_url 已收敛——schema 不含，Agent 面只选 provider+model；
    // 「思考输出」勾选退役——推理力度下拉（无/low/high/max）替代）
    const llmSchema = await settings.getLlmSchemas();
    expect(Object.keys(llmSchema).sort()).toEqual(['deepseek', 'glm', 'glm-coding-plan', 'openai']);
    // GLM Coding Plan 模板（编程套餐独立端点；无 defaultModel——读取清单后取第一个）
    expect(settings.LLM_PROVIDER_TEMPLATES.find((t) => t.id === 'glm-coding-plan')).toMatchObject({
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    });
    expect((llmSchema.glm ?? []).map((f: { key: string }) => f.key)).toEqual(expect.arrayContaining([
      'model', 'temperature', 'max_tokens', 'top_p', 'response_format', 'stop', 'reasoning_effort',
    ]));
    expect((llmSchema.glm ?? []).map((f: { key: string }) => f.key)).not.toContain('thinking');
    expect((llmSchema.glm ?? []).map((f: { key: string }) => f.key)).not.toContain('api_key');
    expect((llmSchema.glm ?? []).map((f: { key: string }) => f.key)).not.toContain('base_url');
    // 推理力度 = 下拉档位（与会话输入框同词汇；'' = 默认/不覆盖，
    // 'none' = 显式关闭思考输出）
    const effort = (llmSchema.glm ?? []).find((f: { key: string }) => f.key === 'reasoning_effort') as { type?: string; options?: Array<{ label: string; value: string }> } | undefined;
    expect(effort?.type).toBe('select');
    expect(effort?.options?.map((o) => o.value)).toEqual(['', 'none', 'low', 'high', 'max']);
    // 新增模型条目带出 provider 默认模型（LLM_PROVIDER_DEFAULTS 同源）
    const glmModel = (llmSchema.glm ?? []).find((f: { key: string }) => f.key === 'model');
    expect((glmModel as { default?: unknown } | undefined)?.default).toBe('glm-5.3');
    // 搜索 schema = 双 provider 内置表（2026-10 收敛 tavily/deepseek——
    // 与 ac-web-search-core PROVIDER_REGISTRY 同口径；池页下拉同源）；
    // deepseek 配置项只剩 api_key（端点/模型/次数走 provider 内置缺省，
    // 调优字段 deepseek 不消费）
    const searchSchema = await settings.getSearchSchemas();
    expect(Object.keys(searchSchema).sort()).toEqual(['deepseek', 'tavily']);
    expect((searchSchema.tavily ?? []).map((f: { key: string }) => f.key)).toEqual(expect.arrayContaining(['api_key', 'defaultResults', 'defaultDepth']));
    expect((searchSchema.deepseek ?? []).map((f: { key: string }) => f.key)).toEqual(['api_key']);
    // 市场面已摘除（M22 D8）：无桩函数可调；browseFile 显式降级保留
    expect((await settings.browseFile()).success).toBe(false);
  });

  it('会话插件面（M22 P1）：getSessionPlugins 只取 sessionOnly；registerSessionPlugin 发 agentId', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const rpc = {
      async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        calls.push({ method, params });
        if (method === 'plugin/loaded') {
          return {
            loaded: [
              { name: 'sess', sessionOnly: true, dir: '/d/sess', agentId: 'helper' },
              { name: 'boot-installed', sessionOnly: false }, // boot 装载的已安装插件：不是会话插件（B3）
            ],
          } as T;
        }
        if (method === 'plugin/load') return { status: 'loaded', name: 'sess' } as T;
        throw new Error(`unexpected rpc ${method}`);
      },
    };
    const r = await settings.getSessionPlugins(rpc);
    expect(r.plugins).toHaveLength(1);
    expect(r.plugins[0]).toMatchObject({ name: 'sess', source: 'session', owner: 'helper' });
    await settings.registerSessionPlugin('/d/sess', 'helper', ['fs'], rpc);
    expect(calls[1].params).toMatchObject({ dir: '/d/sess', sessionOnly: true, agentId: 'helper', grants: ['fs'] });
    expect(calls[1].params!.owner).toBeUndefined(); // B2：字段名错配已修正
  });
});

describe('Port B：api/roster（Agent 名册，第三梯）', () => {
  function rec(results: Record<string, unknown>) {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    return {
      calls,
      rpc: {
        async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
          calls.push({ method, params });
          if (!(method in results)) throw new Error(`unexpected rpc ${method}`);
          return results[method] as T;
        },
      },
    };
  }

  it('toAgentList：name←name??description（显示名单源+存量回退）+ hasActiveSession + 头像 URL 指真实端点 + P4 摘要合成', () => {
    const r = toAgentList(
      [
        { id: 'helper', description: '小助手' },
        { id: 'named', name: '大名', description: '简介' },
        { id: 'bare' },
      ],
      [{ agentId: 'helper', conversationId: 'helper' }],
      [
        { conversationId: 'helper', updatedAt: 123, last: { role: 'user', text: '最后一条提问', ts: '2026-01-01T00:00:00Z' } },
        { conversationId: 'other', updatedAt: 456, last: { role: 'assistant', text: '别的会话', ts: '2026-01-02T00:00:00Z', name: 'other' } },
      ],
    );
    expect(r.agents[0]).toMatchObject({ id: 'helper', name: '小助手', hasActiveSession: true, avatar: '/api/agents/helper/avatar' });
    expect(r.agents[0].lastActivity).toBe(123);
    expect(r.agents[0].lastMessage).toMatchObject({ role: 'user', content: '最后一条提问', agent_id: 'user' });
    // name 优先：显示名与简介各自独立
    expect(r.agents[1]).toMatchObject({ id: 'named', name: '大名', description: '简介' });
    expect(r.agents[2]).toMatchObject({ id: 'bare', name: 'bare', hasActiveSession: false });
    expect(r.agents[2].lastMessage).toBeUndefined(); // 无会话桶：不合成摘要
  });

  it('fetchAgents：agents/list + conversation/stats + runs/snapshot 三 RPC 汇聚（snapshot 失败降级）', async () => {
    const { rpc, calls } = rec({
      'agents/list': { agents: [{ id: 'helper', description: '小助手' }] },
      'conversation/stats': { running: [{ agentId: 'helper', conversationId: 'helper', handle: 'h', startedAt: 1 }] },
    });
    const r = await fetchAgents(rpc);
    expect(calls.map((c) => c.method).sort()).toEqual(['agents/list', 'conversation/stats', 'runs/snapshot']);
    expect(r.agents[0]).toMatchObject({ id: 'helper', hasActiveSession: true });
    expect(r.agents[0].lastMessage).toBeUndefined(); // snapshot reject 被 catch → 旧形态
  });

  it('createAgent：src 形状 → AgentConfig 白名单（name→name 显示名单源）', async () => {
    const { rpc, calls } = rec({ 'agents/create': { config: { id: 'x1' } } });
    const r = await createAgent({ id: 'x1', name: '新人', llm: { model: 'glm-5.3' } }, rpc);
    expect(r).toEqual({ success: true, agentId: 'x1' });
    expect(calls[0].params!.config).toEqual({ id: 'x1', name: '新人', model: 'glm-5.3' });
  });

  it('fetchAgentModels / fetchLlmProviders / fetchPools / fetchSessionTokens / fetchAgentPresets：RPC 方法名与形状锁定', async () => {
    // 模型发现（P3 真 /models 代理）：方法名 + name/refresh 参数
    const { rpc: modelsRpc, calls: modelsCalls } = rec({ 'llm/models': { name: 'glm', models: ['a', 'b'] } });
    const models = await fetchAgentModels('glm', true, modelsRpc);
    expect(models.models).toEqual(['a', 'b']);
    expect(modelsCalls[0].params).toEqual({ name: 'glm', refresh: true });
    // Provider 注册面快照（AgentPane/ChatInput 选择器数据源）
    const provs = await fetchLlmProviders(rec({ 'llm/providers': { providers: ['glm'], stats: [{ name: 'glm', models: ['glm-5.3'], baseUrl: 'https://x' }] } }).rpc);
    expect(provs.providers).toEqual(['glm']);
    expect(provs.stats[0]).toMatchObject({ name: 'glm', models: ['glm-5.3'] });
    const pools = await fetchPools(rec({ 'config/get': { config: { llmProviders: { glm: { defaultModel: 'glm-5.3' } } } } }).rpc);
    expect(pools.llmProviders).toEqual({ glm: { defaultModel: 'glm-5.3' } });
    const tokens = await fetchSessionTokens('helper', rec({ 'session/tokens': { conversationId: 'helper', messageCount: 5, contextTokens: 8000, status: 'moderate' } }).rpc);
    expect(tokens).toMatchObject({ tokenCount: 8000, messageCount: 5, status: 'moderate' });
    // 预设目录（ac-agent-presets 物化；空回显容忍）
    const presets = await fetchAgentPresets(rec({ 'agents/presets': { presets: [{ id: '__standard__', name: '标准模式', label: '标准模式', description: '', default: true }] } }).rpc);
    expect(presets.presets[0]).toMatchObject({ id: '__standard__', default: true });
    const empty = await fetchAgentPresets(rec({ 'agents/presets': {} }).rpc);
    expect(empty.presets).toEqual([]);
  });
});

describe('Port B：api/groups（群名册，第三梯）', () => {
  function rec(results: Record<string, unknown>) {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    return {
      calls,
      rpc: {
        async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
          calls.push({ method, params });
          if (!(method in results)) throw new Error(`unexpected rpc ${method}`);
          return results[method] as T;
        },
      },
    };
  }

  it('fetchGroups：group/list → GroupInfo[]（group_id/participants/created_at 词汇）', async () => {
    const { rpc } = rec({ 'group/list': { groups: [{ id: 'g1', name: '群', members: ['a', 'b'], createdAt: 5 }] } });
    const r = await fetchGroups(rpc);
    expect(r.groups[0]).toEqual({ group_id: 'g1', name: '群', participants: ['a', 'b'], created_at: 5 });
  });

  it('群主（记忆属主）：memoryOwner 透传 memory_owner + set-memory-owner 设定/解除参数形（空 agentId = 不带字段）', async () => {
    // 透传：后端 GroupConfig.memoryOwner → 前端 memory_owner（未设置 = 无键）
    const { rpc } = rec({ 'group/list': { groups: [
      { id: 'g1', name: '群', members: ['a', 'b'], createdAt: 5, memoryOwner: 'a' },
      { id: 'g2', name: '群二', members: ['a'], createdAt: 6 },
    ] } });
    const r = await fetchGroups(rpc);
    expect(r.groups[0].memory_owner).toBe('a');
    expect(r.groups[1].memory_owner).toBeUndefined();
    // 设定：带 memoryOwner；解除（agentId 空）：不带字段——后端 optStr 空→undefined
    const set = rec({ 'group/set-memory-owner': { group: { id: 'g1', memoryOwner: 'b' } } });
    await setGroupMemoryOwner('g1', 'b', set.rpc);
    expect(set.calls).toEqual([{ method: 'group/set-memory-owner', params: { groupId: 'g1', memoryOwner: 'b' } }]);
    const clear = rec({ 'group/set-memory-owner': { group: { id: 'g1' } } });
    await setGroupMemoryOwner('g1', '', clear.rpc);
    expect(clear.calls).toEqual([{ method: 'group/set-memory-owner', params: { groupId: 'g1' } }]);
  });

  it('createGroup：group/create → {group:{group_id}}（创建后选中硬依赖）', async () => {
    const { rpc, calls } = rec({ 'group/create': { group: { id: 'g9' } } });
    const r = await createGroup({ name: '新群', participants: ['a'] }, rpc);
    expect(r).toEqual({ group: { group_id: 'g9' }, success: true });
    expect(calls[0].params).toMatchObject({ name: '新群', members: ['a'] });
  });

  it('updateGroup：改名 + 简介 + 成员差量（对账 group/list 现值）', async () => {
    const { rpc, calls } = rec({
      'group/rename': { renamed: true },
      'group/set-description': { descriptionSet: true },
      'group/list': { groups: [{ id: 'g1', name: '旧名', members: ['a', 'b'] }] },
      'group/join': { joined: true },
      'group/leave': { left: true },
    });
    await updateGroup('g1', { name: '新名', description: '新简介', participants: ['a', 'c'] }, rpc);
    expect(calls.map((c) => c.method)).toEqual(['group/rename', 'group/set-description', 'group/list', 'group/join', 'group/leave']);
    expect(calls[1].params).toEqual({ groupId: 'g1', description: '新简介' });
    expect(calls[3].params).toMatchObject({ groupId: 'g1', agentId: 'c' }); // 加入 c
    expect(calls[4].params).toMatchObject({ groupId: 'g1', agentId: 'b' }); // 移出 b
  });

  it('updateGroup：仅改简介（空串 = 清空）→ 只发 set-description 不带 rename', async () => {
    // 曾漏发 description 致群聊抽屉改简介"本地回写成功、刷新即丢"
    const { rpc, calls } = rec({ 'group/set-description': { descriptionSet: true } });
    await updateGroup('g1', { description: '' }, rpc);
    expect(calls).toEqual([{ method: 'group/set-description', params: { groupId: 'g1', description: '' } }]);
  });

  it('fetchGroupHistory：GroupMessageRecord → src 宽松行（from→agent_id/name、ISO 时间）', async () => {
    const { rpc, calls } = rec({ 'group/history': { messages: [{ id: 'm1', groupId: 'g1', from: 'a', content: '嗨', at: 1700000000000 }] } });
    const r = await fetchGroupHistory('g1', 0, 50, rpc);
    expect(calls[0].params).toMatchObject({ groupId: 'g1', limit: 50 });
    const row = r.messages[0] as Record<string, unknown>;
    expect(row).toMatchObject({ role: 'agent', agent_id: 'a', name: 'a', content: '嗨' });
    expect(typeof row.timestamp).toBe('string');
    expect(new Date(row.timestamp as string).getTime()).toBe(1700000000000);
  });

  it('fetchGroupHistory（D11）：steps[] 按步展开——agent 步气泡（tool_calls）+ 配对 tool 气泡；思维链透传', async () => {
    const { rpc } = rec({
      'group/history': {
        messages: [
          {
            id: 'm2', groupId: 'g1', from: 'a', content: '查完了', at: 1700000000001,
            reasoning: '先想想',
            steps: [
              { content: '', reasoning: '先想想', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"x"}', result: { ok: true } }] },
              { content: '查完了' },
            ],
          },
        ],
      },
    });
    const r = await fetchGroupHistory('g1', 0, 50, rpc);
    expect(r.messages).toHaveLength(3); // 步1气泡 + 工具气泡 + 终文本气泡
    const [step1, tool, final] = r.messages as Array<Record<string, unknown>>;
    expect(step1).toMatchObject({ role: 'agent', agent_id: 'a', reasoning_content: '先想想' });
    expect((step1.tool_calls as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'c1', name: 'read', label: 'read', arguments: { path: 'x' }, result: { ok: true },
    });
    expect(tool).toMatchObject({ role: 'tool', tool_call_id: 'c1', name: 'read', label: 'read' });
    expect(final).toMatchObject({ role: 'agent', content: '查完了' });
  });

  it('deleteGroup：group/delete 直连', async () => {
    const { rpc, calls } = rec({ 'group/delete': { deleted: true } });
    await deleteGroup('g1', rpc);
    expect(calls).toEqual([{ method: 'group/delete', params: { groupId: 'g1' } }]);
  });
});

describe('Port B：api/singles（独立会话，第四梯）', () => {
  function rec(results: Record<string, unknown>) {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    return {
      calls,
      rpc: {
        async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
          calls.push({ method, params });
          if (!(method in results)) throw new Error(`unexpected rpc ${method}`);
          return results[method] as T;
        },
      },
    };
  }

  it('fetchSingles：singles/list + sid 登记（dialogId 合成桥）', async () => {
    chatPresence.knownSingles.clear();
    const { rpc, calls } = rec({ 'singles/list': { singles: [{ id: 's1', agentId: 'helper', status: 'active', createdAt: '', updatedAt: '' }] } });
    const r = await fetchSingles(rpc);
    expect(calls).toEqual([{ method: 'singles/list' }]);
    expect(r.singles[0]).toMatchObject({ id: 's1', agentId: 'helper' });
    expect(chatPresence.knownSingles.has('s1')).toBe(true);
  });

  it('createSingle：session 硬依赖返回 + reuse 透传 + 登记', async () => {
    chatPresence.knownSingles.clear();
    const { rpc, calls } = rec({ 'singles/create': { single: { id: 's2', agentId: 'a' }, reused: true } });
    const r = await createSingle({ agentId: 'a', reuse: true }, rpc);
    expect(r.session.id).toBe('s2');
    expect(r.reused).toBe(true);
    expect(calls[0].params).toMatchObject({ agentId: 'a', reuse: true });
    expect(chatPresence.knownSingles.has('s2')).toBe(true);
  });

  it('updateSingle：model null/agentId "" 语义透传；archive vs delete（purge）分派', async () => {
    const upd = rec({ 'singles/update': { single: { id: 's1' } } });
    await updateSingle('s1', { model: null, agentId: '', workspaceId: '' }, upd.rpc);
    expect(upd.calls[0].params).toEqual({ id: 's1', model: null, agentId: '', workspaceId: '' });
    const arch = rec({ 'singles/archive': { single: { id: 's1' } } });
    const a = await archiveSingle('s1', arch.rpc);
    expect(a.session.id).toBe('s1');
    chatPresence.knownSingles.add('s1');
    const del = rec({ 'singles/delete': { deleted: true } });
    await deleteSingle('s1', del.rpc);
    expect(chatPresence.knownSingles.has('s1')).toBe(false); // 硬删移除登记
  });

  it('预设目录接真 RPC：拉取失败（服务未装载）→ 直接拒绝（store 层 catch 保空，defaultPresetId 回退 __standard__）', async () => {
    const failing = {
      async call<T>(_method: string): Promise<T> {
        throw new Error('agentPresets 服务未装载');
      },
    };
    await expect(fetchAgentPresets(failing as never)).rejects.toThrow('未装载');
  });
});

describe('Port B：api/runs（运行跟踪，第五梯——适配器 REST 面随之退役）', () => {
  function rec(results: Record<string, unknown>) {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    return {
      calls,
      rpc: {
        async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
          calls.push({ method, params });
          if (!(method in results)) throw new Error(`unexpected rpc ${method}`);
          return results[method] as T;
        },
      },
    };
  }

  it('toRunsSnapshot：矩阵契约合成（convKey ~ 格式 / 热力窗口透传 / running kind 判别 / user 成员去重）', () => {
    const s = toRunsSnapshot(
      {
        conversations: [
          { conversationId: 'helper~user', messageCount: 5, updatedAt: 9, size: 100, windows: { h1: 1, d1: 2, d3: 3, d7: 4, d30: 5 } },
          { conversationId: 'g1', messageCount: 8, updatedAt: 10, size: 200 }, // 群会话桶：无 windows（旧后端）
          { conversationId: 'a1~helper', messageCount: 3, updatedAt: 11, size: 50 }, // agent⇄agent 对桶（send_agent 委托）
          { conversationId: 'a1~a1', messageCount: 2, updatedAt: 12, size: 30 }, // 定时自会话桶（对角线）
          { conversationId: 'sid-9', messageCount: 9, updatedAt: 13, size: 90 }, // 独立会话（无 ~）：不进 pairs
        ],
        running: [
          { agentId: 'helper', conversationId: 'helper~user', handle: 'h', startedAt: 1 },
          { agentId: 'a1', conversationId: 'g1', handle: 'h2', startedAt: 2 },
          { agentId: 'helper', conversationId: 's9', handle: 'h3', startedAt: 3 },
          { agentId: 'a1', conversationId: 'a1~helper', handle: 'h4', startedAt: 4 },
        ],
        groups: [{ groupId: 'g1', name: '群', memberCount: 2 }],
      },
      [{ id: 'helper', description: '小助手' }, { id: 'a1', description: 'A1' }, { id: 'user', description: '风栗', virtual: true }],
    );
    // 后端按记录时间戳统计的热窗原样透传（矩阵范围按钮数据源）
    expect(s.pairs[0]).toMatchObject({ key: 'chat~helper~user', a: 'helper', b: 'user', messageCount: 5 });
    expect(s.pairs[0].windows).toEqual({ h1: 1, d1: 2, d3: 3, d7: 4, d30: 5 });
    expect((s.groups[0] as Record<string, unknown>).windows).toBeUndefined(); // 旧后端缺失 → 不伪造
    // M19 对桶统一：user~agent 直答 / a~b 委托 / a~a 自会话同规进 pairs；
    // singles（无 ~）不进
    expect(s.pairs.map((p) => p.key)).toEqual(['chat~helper~user', 'chat~a1~helper', 'chat~a1~a1']);
    expect(s.members.map((m) => m.id)).toEqual(['helper', 'a1', 'user', 'g1', 'system']);
    expect(s.running[0]).toMatchObject({ convKey: 'chat~helper~user', kind: 'chat' });
    expect(s.running[1]).toMatchObject({ convKey: 'group~g1~a1', kind: 'group' });
    expect(s.running[2]).toMatchObject({ convKey: 'single~s9', kind: 'single' });
    expect(s.running[3]).toMatchObject({ convKey: 'chat~a1~helper', kind: 'chat' });

    // 名册已含 user（workspace 注册，名=显示名）→ 不再合成占位（防矩阵双行）
    const s2 = toRunsSnapshot(
      { conversations: [], running: [], groups: [] },
      [{ id: 'helper', description: '小助手' }, { id: 'user', description: '风栗', virtual: true }],
    );
    const userIds = s2.members.filter((m) => m.id === 'user');
    expect(userIds).toHaveLength(1);
    expect(userIds[0].name).toBe('风栗');
  });

  it('fetchRuns：snapshot + agents/list 双 RPC 聚合', async () => {
    const { rpc, calls } = rec({
      'runs/snapshot': { conversations: [], running: [], groups: [] },
      'agents/list': { agents: [] },
    });
    const r = await fetchRuns(rpc);
    expect(calls.map((c) => c.method).sort()).toEqual(['agents/list', 'runs/snapshot']);
    expect(r.members.map((m) => m.id)).toEqual(['user', 'system']);
  });

  it('interruptRun：convKey → conversationId 换算（chat/group/single 三形态）', async () => {
    // M19：chat 对键双向保留（含 user 段——user 只是端点之一）
    expect(convKeyToId('chat~helper~user')).toBe('helper~user');
    expect(convKeyToId('group~g1~a1')).toBe('g1');
    expect(convKeyToId('single~s9')).toBe('s9');
    // agent 对 / 自会话 convKey → 对桶 conversationId（两段保留）
    expect(convKeyToId('chat~a1~helper')).toBe('a1~helper');
    expect(convKeyToId('chat~neko~neko')).toBe('neko~neko');
    const { rpc, calls } = rec({ 'runs/interrupt': { aborted: 1 } });
    const r = await interruptRun('chat~helper~user', rpc);
    expect(r.success).toBe(true);
    expect(calls[0].params).toEqual({ conversationId: 'helper~user' });
  });

  it('fetchPairHistory：session/history → src 宽松行（user 身份标注）', async () => {
    const { rpc, calls } = rec({
      'session/history': { records: [{ role: 'user', content: '问', name: 'user', message_id: 'm1', timestamp: '2026-01-01T00:00:00Z' }, { role: 'assistant', content: '答', name: 'helper', message_id: 'm2', timestamp: '2026-01-01T00:00:01Z' }] },
    });
    const r = await fetchPairHistory('user', 'helper', 100, 0, rpc);
    expect(calls[0].params).toEqual({ conversationId: 'helper~user', limit: 100 });
    expect(r.messages[0]).toMatchObject({ role: 'agent', agent_id: 'user', content: '问' });
    expect(r.messages[1]).toMatchObject({ role: 'agent', agent_id: 'helper', content: '答' });
  });

  it('toHistoryMessages：steps[] 步重建——assistant 步气泡（tool_calls 下划线键形）+ tool 气泡（M18 #6）', async () => {
    const { toHistoryMessages } = await import('../src/api/runs.ts');
    const rows = toHistoryMessages(
      [
        { role: 'user', content: '查一下', message_id: 'm1', timestamp: 't1' },
        {
          role: 'assistant',
          content: '结果如下',
          message_id: 'm2',
          timestamp: 't2',
          reasoning_content: '想想',
          steps: [
            {
              content: '',
              reasoning: '想想',
              toolCalls: [{ id: 'c1', name: 'glob', arguments: '{"pattern":"*.ts"}', result: { ok: true, output: { paths: ['a.ts'] } } }],
            },
            { content: '结果如下' },
          ],
        },
      ] as never,
      'helper',
    );
    // user 行
    expect(rows[0]).toMatchObject({ role: 'agent', agent_id: 'user', content: '查一下' });
    // 步 1：assistant 气泡带 thinking + tool_calls（src 持久化键形——
    // historyMsgToChatMessage 读 m.tool_calls；驼峰键会被静默丢弃）
    expect(rows[1]).toMatchObject({ role: 'agent', agent_id: 'helper', content: '', reasoning_content: '想想' });
    expect((rows[1] as Record<string, unknown>).tool_calls).toEqual([
      { id: 'c1', name: 'glob', arguments: { pattern: '*.ts' }, result: { ok: true, output: { paths: ['a.ts'] } }, label: 'glob' },
    ]);
    // 步 1 的工具气泡
    expect(rows[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1', name: 'glob' });
    // 步 2：纯文本步
    expect(rows[3]).toMatchObject({ role: 'agent', agent_id: 'helper', content: '结果如下' });
    // 无 steps 的旧 assistant 行：原样（不重建）
    const legacy = toHistoryMessages([{ role: 'assistant', content: '旧行', message_id: 'm9', timestamp: 't9' }] as never, 'helper');
    expect(legacy[0]).toMatchObject({ role: 'agent', content: '旧行' });
  });

  it('routeDialog：对桶统一路由（M19——pair: 分区；直答 = viewer 对桶糖）', async () => {
    const { routeDialog } = await import('../src/api/chat-ops');
    // 直答（conversationId 缺省或 = agentId 的旧帧）→ viewer 对桶 pair:
    expect(routeDialog('neko', undefined, 'user')?.dialogId).toBe('pair:neko|user');
    expect(routeDialog('neko', 'neko', 'user')?.dialogId).toBe('pair:neko|user');
    // viewer 直答对桶（新帧）→ 同一 pair 分区（可写）
    expect(routeDialog('neko', 'neko~user', 'user')?.dialogId).toBe('pair:neko|user');
    // agent⇄agent 委托（桶 a~b）→ pair 分区（矩阵只读视角）
    expect(routeDialog('responder', 'responder~writer', 'writer')?.dialogId).toBe('pair:responder|writer');
    // 定时自会话（桶 a~a）→ pair 对角线分区（两端同名）
    expect(routeDialog('neko', 'neko~neko', 'neko')?.dialogId).toBe('pair:neko|neko');
    // singles/groups 名册仍按各自分区路由
    chatPresence.knownSingles.add('sid-1');
    expect(routeDialog('neko', 'sid-1', 'user')?.dialogId).toBe('single:sid-1');
    chatPresence.knownSingles.delete('sid-1');
  });

  it('pickAskQuestions：live 帧（questions 上提）与 interaction/list 恢复记录（payload.questions）两形归一 + 超时语义 + 全题保留', async () => {
    const { pickAskQuestions } = await import('../src/api/chat-ops');
    const now = 1_000_000;
    // live 帧：ws-bridge 已整形（questions 顶层）——多题全保留
    const live = pickAskQuestions({
      kind: 'ask_questions',
      id: 'dur-1',
      owner: 'helper',
      deadline: now + 60_000,
      questions: [
        { question: '选哪个？', options: ['A', 'B'] },
        { question: '测试文件怎么处理？', options: ['保留', '删除'] },
      ],
    }, now);
    expect(live).toMatchObject({
      interaction_id: 'dur-1', agent_id: 'helper', allow_custom: true, timeout_ms: 60_000,
    });
    expect(live!.questions).toEqual([
      { question: '选哪个？', options: ['A', 'B'] },
      { question: '测试文件怎么处理？', options: ['保留', '删除'] },
    ]);
    // 恢复记录：原始 store 形（questions 在 payload 内）→ 同构输出
    const restored = pickAskQuestions({
      kind: 'ask_questions', id: 'dur-2', owner: 'helper', state: 'pending',
      key: 'helper~user', createdAt: now,
      payload: { questions: [{ question: '继续吗？', options: ['继续', '停'] }] },
    }, now);
    expect(restored).toMatchObject({
      interaction_id: 'dur-2', agent_id: 'helper', timeout_ms: 0, // 无 deadline → 永不自动关（后端永久等待）
    });
    expect(restored!.questions).toEqual([{ question: '继续吗？', options: ['继续', '停'] }]);
    // deadline 已过 → 剩余 0（下限钳制）；非 ask_questions / 空问题 → null
    expect(pickAskQuestions({ kind: 'ask_questions', id: 'dur-3', questions: [{ question: 'x', options: ['y'] }], deadline: now - 5 }, now)!.timeout_ms).toBe(0);
    expect(pickAskQuestions({ kind: 'approval', id: 'dur-4' }, now)).toBeNull();
    expect(pickAskQuestions({ kind: 'ask_questions', id: 'dur-5', questions: [] }, now)).toBeNull();
    expect(pickAskQuestions({ kind: 'ask_questions', id: 'dur-6', questions: [{ options: ['y'] }] }, now)).toBeNull();
  });
});

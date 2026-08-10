// ============================================================
// builtin prompt/session/memory 装配 + 档案工具测试
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { saveSession, loadHistory, agentOfDialog, toPersistedRole, logRunUsage } from '../src/plugins/builtin/hooks/session';
import {
  loadMemoryToMessages, loadMemory, truncateMemory,
  makeLoadMemoryHook,
} from '../src/plugins/builtin/hooks/memory';

import builtinPlugin from '../src/plugins/builtin';
import { PluginRegistry } from '../src/plugins/registry';
import { AgentRouter } from '../src/agents/router';
import type { AgentAssembly, AgentConfig } from '../src/agents/config';
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/core/types';
import { ChatStream } from '../src/core/llm/chat-stream';
import { chatDialogKey, groupDialogKey, yearWeek } from '../src/agents/paths';

/** 测试辅助：写 1:1 会话文件（新路径 sessions/chat~<lo>~<hi>/） */
function writeChatSession(a: string, b: string, lines: string[]): string {
  const dir = path.join(ws, 'sessions', chatDialogKey(a, b));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), lines.join('\n') + '\n', 'utf-8');
  return dir;
}

/** 测试辅助：写记忆文件（集中 files/<selfId>/memory/<cp>.memory.md） */
function writeMemory(selfId: string, cp: string, content: string): string {
  const file = path.join(ws, 'files', selfId, 'memory', `${cp}.memory.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

let ws = '';
beforeEach(() => {
  ws = path.join(os.tmpdir(), `agentchat-assembly-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(ws, { recursive: true });
  process.env.AGENTCHAT_WORKSPACE = ws;
});
afterEach(() => {
  delete process.env.AGENTCHAT_WORKSPACE;
  if (fs.existsSync(ws)) fs.rmSync(ws, { recursive: true, force: true });
});

const stop = (content: string): LLMResponse => ({ content, toolCalls: [], finishReason: 'stop' });
function makeLLM(handler: (req: LLMRequest, i: number) => LLMResponse | Promise<LLMResponse>): LLMProvider {
  let i = 0;
  return {
    model: 'mock-model',
    chat: async (req) => { const r = await handler(req, i); i++; return r; },
    stream: (req) => {
      const cs = new ChatStream();
      void (async () => { const r = await handler(req, i); i++; cs.done(r); })()
        .catch((err) => cs.error({ content: null, toolCalls: [], finishReason: 'error' }, String(err)));
      return cs;
    },
    toProviderMessages: (m) => m as any[],
    fromProviderMessages: (m) => m as any[],
  };
}
function makeAssembly(registry: PluginRegistry, llm: LLMProvider): AgentAssembly {
  return {
    createLLM: () => llm,
    resolveTools: (names, config) => registry.resolveTools(names, config),
    resolveHooks: (names, config) => registry.resolveHooks(names, config),
    loadHistory: () => [],
  };
}

describe('session 装配', () => {
  it('agentOfDialog 解析当前 Agent（末段约定）', () => {
    expect(agentOfDialog('user__agentA')).toBe('agentA');
    expect(agentOfDialog('g1__agentB')).toBe('agentB');
    expect(agentOfDialog('agentA')).toBe('agentA');
  });

  it('toPersistedRole：user/assistant → agent', () => {
    expect(toPersistedRole('user')).toBe('agent');
    expect(toPersistedRole('assistant')).toBe('agent');
    expect(toPersistedRole('system')).toBe('system');
    expect(toPersistedRole('trigger')).toBe('trigger');
    expect(toPersistedRole('tool')).toBe('tool');
  });

  it('saveSession（runEnd）持久化 + loadHistory 读回（归属 = dialogId 末段）', async () => {
    const ctx: any = { dialogId: 'user__agentA' };
    const messages: any[] = [
      { role: 'user', content: '你好', agent_id: 'user' },
      { role: 'assistant', content: '嗨', reasoning_content: '思考中' },
    ];
    await saveSession(ctx, { messages } as any);

    const history = loadHistory('user__agentA');
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('agent');
    expect(history[0].agent_id).toBe('user');
    expect(history[1].role).toBe('agent');
    expect(history[1].agent_id).toBe('agentA');
    expect(history[1].reasoning_content).toBe('思考中');
  });

  it('saveSession 群聊：仅写周归档（全量含思考/工具），群聊本体由 GroupService 落盘', async () => {
    const ctx: any = { dialogId: groupDialogKey('g1', 'agentA'), agentId: 'agentA' };
    const messages: any[] = [
      { role: 'assistant', content: '大家好', reasoning_content: '群聊思考' },
      { role: 'tool', name: 'bash', content: '工具输出', tool_call_id: 'c1' },
    ];
    await saveSession(ctx, { messages } as any);

    // 群聊本体：saveSession 不再写（群聊本体由 GroupService 监听 group.message.received 落盘）
    const body = path.join(ws, 'sessions', 'group~g1', 'messages.jsonl');
    expect(fs.existsSync(body)).toBe(false);

    // 周归档：全量（含工具 + 思考）
    const archiveFile = path.join(ws, 'sessions', 'group~g1', 'archive', 'agentA', `history_${yearWeek(new Date())}.jsonl`);
    expect(fs.existsSync(archiveFile)).toBe(true);
    const archLines = fs.readFileSync(archiveFile, 'utf-8').trim().split('\n').filter(Boolean);
    expect(archLines).toHaveLength(2);
    expect(JSON.parse(archLines[0]).reasoning_content).toBe('群聊思考');
    expect(JSON.parse(archLines[1]).role).toBe('tool');
  });

  it('loadHistory：无会话文件返回空；损坏行忽略', async () => {
    expect(loadHistory('nope')).toEqual([]);
    const dir = path.join(ws, 'sessions', 'user__agentA');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), '{bad json}\n{"role":"agent","content":"ok"}\n', 'utf-8');
    const history = loadHistory('user__agentA');
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe('ok');
  });

  it('logRunUsage（runEnd）：记录用量到 usage/token_<date>.jsonl（含模型名）', async () => {
    const ctx: any = { dialogId: chatDialogKey('user', 'agentA'), agentId: 'agentA', llm: { model: 'deepseek-v4-flash' } };
    const result: any = {
      content: 'ok', interrupted: false, messages: [],
      usage: {
        prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
        accumulated_prompt_tokens: 300, accumulated_total_tokens: 350,
        prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 100,
        react_turns: 3,
      },
    };
    await logRunUsage(ctx, result);

    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(ws, 'usage', `token_${date}.jsonl`);
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.agent).toBe('agentA');
    expect(rec.counterpart).toBe('user');
    expect(rec.model).toBe('deepseek-v4-flash');
    expect(rec.react_turns).toBe(3);
    expect(rec.total_tokens).toBe(150);
    expect(rec.accumulated_total_tokens).toBe(350);
    expect(rec.cache_hit_rate).toBeCloseTo(66.7, 0);
  });

  it('logRunUsage：无 usage / 无 dialogId 不写文件', async () => {
    await logRunUsage({} as any, { content: 'ok', interrupted: false, messages: [] } as any);
    await logRunUsage({ dialogId: 'user__agentA' } as any, { content: 'ok', interrupted: false, messages: [], usage: undefined } as any);
    const usageDir = path.join(ws, 'usage');
    expect(fs.existsSync(usageDir)).toBe(false); // 无任何记录则不创建目录
  });
});

describe('memory 装配（照搬旧 agent-memory）', () => {
  it('loadMemoryToMessages 直接拼接 system prompt（无标签、无去重）', async () => {
    writeMemory('agentA', 'user', '用户喜欢简洁的回答');

    const messages: any[] = [{ role: 'system', content: '你是助手' }];
    await loadMemoryToMessages({ dialogId: chatDialogKey('user', 'agentA'), agentId: 'agentA' } as any, messages);
    expect(messages[0].content).toBe('你是助手\n\n用户喜欢简洁的回答');

    // 再次加载会再次拼接（照搬旧 preHook：无去重）
    await loadMemoryToMessages({ dialogId: chatDialogKey('user', 'agentA'), agentId: 'agentA' } as any, messages);
    expect(messages[0].content).toContain('用户喜欢简洁的回答');
  });

  it('loadMemoryToMessages：无记忆文件/无 dialogId 不加载', async () => {
    const messages: any[] = [{ role: 'system', content: '你是助手' }];
    await loadMemoryToMessages({ dialogId: chatDialogKey('user', 'agentB'), agentId: 'agentB' } as any, messages);
    expect(messages).toHaveLength(1);
    await loadMemoryToMessages({} as any, messages);
    expect(messages).toHaveLength(1);
  });

  it('makeLoadMemoryHook（runStart）：拼接记忆到 systemPrompt；读取 agent.memory 预算配置', async () => {
    writeMemory('agentA', 'user', '用户偏好：简洁');

    // 默认预算路径：agent.memory 未配置 → DEFAULT（无截断）
    const hookDefault = makeLoadMemoryHook({ agent_id: 'agentA', name: 'A' } as any);
    const ctxDefault: any = { dialogId: chatDialogKey('user', 'agentA'), agentId: 'agentA', systemPrompt: '你是助手' };
    await hookDefault(ctxDefault);
    expect(ctxDefault.systemPrompt).toBe('你是助手\n\n用户偏好：简洁');

    // 配置 memoryBudgetTokens=0 → 不截断（仍注入全量）
    const hookZero = makeLoadMemoryHook({ agent_id: 'agentA', name: 'A', 'agent.memory': { memoryBudgetTokens: 0 } } as any);
    const ctxZero: any = { dialogId: chatDialogKey('user', 'agentA'), agentId: 'agentA', systemPrompt: 'SP' };
    await hookZero(ctxZero);
    expect(ctxZero.systemPrompt).toContain('用户偏好：简洁');

    // 无 dialogId：不加载
    const ctxNoId: any = { systemPrompt: 'SP' };
    await hookDefault(ctxNoId);
    expect(ctxNoId.systemPrompt).toBe('SP');
  });

  it('loadMemory 预算截断保留头部 + 截断提示', () => {
    const content = Array.from({ length: 50 }, (_, i) => `第${i + 1}行：用户偏好内容 ${i + 1}`).join('\n');
    writeMemory('agentA', 'user', content);
    const dialogId = chatDialogKey('user', 'agentA');

    const full = loadMemory(dialogId, 'agentA');
    expect(full).toBe(content);

    const truncated = loadMemory(dialogId, 'agentA', { budgetTokens: 20 })!;
    expect(truncated).toContain('[记忆已截断]');
    expect(truncated).toContain('memory.md');
    expect(truncated.length).toBeLessThan(content.length);
  });

  it('truncateMemory：预算足够返回原样', () => {
    expect(truncateMemory('短内容', 10000, chatDialogKey('user', 'agentA'), 'agentA')).toBe('短内容');
  });

  it('loadMemory：budgetTokens=0 不截断（返回全量）', () => {
    const content = Array.from({ length: 50 }, (_, i) => `第${i + 1}行：用户偏好内容 ${i + 1}`).join('\n');
    writeMemory('agentA', 'user', content);
    const dialogId = chatDialogKey('user', 'agentA');

    const full = loadMemory(dialogId, 'agentA', { budgetTokens: 0 })!;
    expect(full).toBe(content); // 0 = 不限制 → 全量，不出现截断提示
    expect(full).not.toContain('[记忆已截断]');
  });
});

describe('档案工具（read_agent_info / update_agent_profile）', () => {
  it('经 registry 读取/更新 Agent 档案（fields 形态）', async () => {
    const registry = new PluginRegistry();
    registry.register(builtinPlugin);
    const router = new AgentRouter(makeAssembly(registry, makeLLM(() => stop('ok'))));
    router.getRegistry().register({ agent_id: 'agentA', name: 'Agent A', tags: ['dev'], llm: { provider: 'deepseek' } });
    registry.setServices({ router });

    const cfgA: AgentConfig = { agent_id: 'agentA', name: 'Agent A' };
    const tools = registry.resolveTools(['read_agent_info', 'update_agent_profile'], cfgA);

    const info = await tools.get('read_agent_info')!.execute({});
    expect(String(info)).toContain('agentA');
    expect(String(info)).toContain('deepseek');

    // 多字段更新（name + tags）
    const upd = await tools.get('update_agent_profile')!.execute({ fields: { name: 'Agent A2', tags: ['dev', 'qa'] } });
    expect(String(upd)).toContain('修改字段');
    expect(String(upd)).toContain('name');
    expect(String(upd)).toContain('tags');
    const updated = router.getRegistry().get('agentA')!;
    expect(updated.tags).toEqual(['dev', 'qa']);
    expect(updated.name).toBe('Agent A2');

    // 非法字段拒绝
    const bad = await tools.get('update_agent_profile')!.execute({ fields: { agent_id: 'x', system_prompt: 'y' } as any });
    expect(String(bad)).toContain('不允许修改');
  });

  it('update_agent_profile persona 写入 AGENT.md（经 agentsDir 定位）', async () => {
    const agentsDir = path.join(ws, 'agents');
    const agentADir = path.join(agentsDir, 'agentA');
    fs.mkdirSync(agentADir, { recursive: true });
    fs.writeFileSync(path.join(agentADir, 'config.json'), JSON.stringify({ agent_id: 'agentA', name: 'Agent A', tags: ['dev'] }), 'utf-8');
    fs.writeFileSync(path.join(agentADir, 'AGENT.md'), '# Agent A\n\n旧设定\n', 'utf-8');

    const registry = new PluginRegistry();
    registry.register(builtinPlugin);
    const router = new AgentRouter(makeAssembly(registry, makeLLM(() => stop('ok'))));
    router.getRegistry().register({ agent_id: 'agentA', name: 'Agent A', tags: ['dev'] });
    registry.setServices({ router, agentsDir });

    const cfgA: AgentConfig = { agent_id: 'agentA', name: 'Agent A' };
    const tools = registry.resolveTools(['update_agent_profile'], cfgA);

    const upd = await tools.get('update_agent_profile')!.execute({ fields: { persona: '全新人物设定' } });
    expect(String(upd)).toContain('persona');
    const md = fs.readFileSync(path.join(agentADir, 'AGENT.md'), 'utf-8');
    expect(md).toContain('# Agent A'); // 保留标题行
    expect(md).toContain('全新人物设定');
    expect(md).not.toContain('旧设定');
  });

  it('read_agent_info 查他人：附加"我"对该 Agent 的印象（集中记忆 files/<self>/memory/）', async () => {
    const registry = new PluginRegistry();
    registry.register(builtinPlugin);
    const router = new AgentRouter(makeAssembly(registry, makeLLM(() => stop('ok'))));
    router.getRegistry().register({ agent_id: 'agentB', name: 'Agent B', tags: ['qa'], llm: { provider: 'openai' } });
    router.getRegistry().register({ agent_id: 'agentA', name: 'Agent A', tags: ['dev'] });
    registry.setServices({ router });

    // 写"agentA 对 agentB"的记忆（集中：files/agentA/memory/agentB.memory.md）
    writeMemory('agentA', 'agentB', 'Agent B 擅长测试用例设计，偏好简洁');

    const cfgA: AgentConfig = { agent_id: 'agentA', name: 'Agent A' };
    const tools = registry.resolveTools(['read_agent_info'], cfgA);

    // 查他人：公开信息 + 印象
    const other = await tools.get('read_agent_info')!.execute({ agent_id: 'agentB' });
    expect(String(other)).toContain('agentB');
    expect(String(other)).toContain('印象');
    expect(String(other)).toContain('擅长测试用例设计');

    // 反方向：agentB 查 agentA → 无记忆 → 尚无印象记录（方向敏感验证）
    const cfgB: AgentConfig = { agent_id: 'agentB', name: 'Agent B' };
    const toolsB = registry.resolveTools(['read_agent_info'], cfgB);
    const otherA = await toolsB.get('read_agent_info')!.execute({ agent_id: 'agentA' });
    expect(String(otherA)).toContain('尚无印象记录');

    // 查自己：不附加印象（无记忆干扰），含 llm 信息
    const selfInfo = await tools.get('read_agent_info')!.execute({});
    expect(String(selfInfo)).not.toContain('印象');
  });
});

describe('query_history（历史查询）', () => {
  it('tool 消息只显示工具名，不展示工具内容', async () => {
    const registry = new PluginRegistry();
    registry.register(builtinPlugin);
    const router = new AgentRouter(makeAssembly(registry, makeLLM(() => stop('ok'))));
    router.getRegistry().register({ agent_id: 'agentA', name: 'Agent A' });
    registry.setServices({ router });

    // 写会话文件：agentA 视角（chat~agentA~user）含 tool 消息（带较长内容）
    writeChatSession('agentA', 'user', [
      JSON.stringify({ role: 'agent', agent_id: 'user', content: '你好', timestamp: '2026-08-07T00:00:00.000Z' }),
      JSON.stringify({ role: 'agent', agent_id: 'agentA', content: '嗨', timestamp: '2026-08-07T00:00:01.000Z' }),
      JSON.stringify({ role: 'tool', name: 'bash', content: '这是一段非常长的工具输出内容不该出现在历史摘要里', tool_call_id: 'call_1', timestamp: '2026-08-07T00:00:02.000Z' }),
    ]);

    const cfgA: AgentConfig = { agent_id: 'agentA', name: 'Agent A' };
    const tools = registry.resolveTools(['query_history'], cfgA);
    const out = await tools.get('query_history')!.execute({ agent_id: 'user' });
    expect(String(out)).toContain('你好');
    expect(String(out)).toContain('[调用工具: bash]');
    // 工具内容不展示
    expect(String(out)).not.toContain('非常长的工具输出');
  });
});

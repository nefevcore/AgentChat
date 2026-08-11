// ============================================================
// 重启恢复端到端（真实插件装配）
// 验证：system_restart → restart-requested → pending 落盘 →
//       模拟重启 → flushPendingMessages → trigger 恢复 → 会话落盘
// 使用真实 builtin 插件 + 完整 hooks（runStart 4 + runEnd 5），
// 覆盖真实 Agent（agent_chat_dev）的装配形态。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AgentRouter } from '../src/agents/router';
import { PluginRegistry } from '../src/plugins/registry';
import builtinPlugin from '../src/plugins/builtin';
import { loadHistory } from '../src/plugins/builtin/hooks/session';
import type { AgentAssembly, AgentConfig } from '../src/agents/config';
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/core/types';
import { ChatStream } from '../src/core/llm/chat-stream';
import { chatDialogKey } from '../src/agents/paths';

let ws = '';
let savedWs: string | undefined;
let savedSup: string | undefined;

afterEach(() => {
  if (savedWs === undefined) delete process.env.AGENTCHAT_WORKSPACE; else process.env.AGENTCHAT_WORKSPACE = savedWs;
  if (savedSup === undefined) delete process.env.AGENTCHAT_SUPERVISED; else process.env.AGENTCHAT_SUPERVISED = savedSup;
  if (ws && fs.existsSync(ws)) fs.rmSync(ws, { recursive: true, force: true });
});

const stop = (content: string): LLMResponse => ({ content, toolCalls: [], finishReason: 'stop' });
function makeLLM(handler: (req: LLMRequest, i: number) => LLMResponse | Promise<LLMResponse>): LLMProvider & { callCount: () => number } {
  let i = 0;
  const llm: LLMProvider = {
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
  return Object.assign(llm, { callCount: () => i });
}

function makeRouter(assembly: AgentAssembly, config: AgentConfig): AgentRouter {
  const r = new AgentRouter(assembly);
  r.getRegistry().register(config);
  r.getRegistry().register({ agent_id: 'user', name: '用户', virtual: true });
  return r;
}

describe('重启恢复端到端（真实插件装配）', () => {
  it('system_restart → 落盘 → 模拟重启 flush → 恢复 run 落盘到会话', async () => {
    ws = path.join(os.tmpdir(), `restart-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(ws, { recursive: true });
    savedWs = process.env.AGENTCHAT_WORKSPACE;
    savedSup = process.env.AGENTCHAT_SUPERVISED;
    process.env.AGENTCHAT_WORKSPACE = ws;
    process.env.AGENTCHAT_SUPERVISED = '1'; // system_restart 工具需 Supervisor 模式才抛中断

    const registry = new PluginRegistry();
    registry.register(builtinPlugin);
    registry.setServiceContext({ workspaceDir: ws, agentsDir: path.join(ws, 'agents'), timezone: 'Asia/Shanghai' });

    const seen: any[][] = [];
    const llm = makeLLM((req, i) => {
      seen.push(req.messages as any[]);
      if (i === 0) {
        return { content: '', toolCalls: [{ id: 'c1', name: 'system_restart', arguments: { reason: 'e2e-test' } }], finishReason: 'tool_calls' };
      }
      return stop('重启完成，已继续 ✅');
    });

    // 与真实 agent_chat_dev 完全一致的 hooks（runStart 4 个 + runEnd 5 个），
    // 复现真实 flush 时 createAgentContext/resolveHooks 的行为。
    const config: AgentConfig = {
      agent_id: 'agentA', name: 'A', tags: ['agent', 'admin', 'dev'],
      plugins: [{
        name: 'builtin',
        runStart: [
          'builtin.discovered_skills',
          'builtin.build-system-prompt',
          'builtin.load-memory',
          'builtin.load-history',
        ],
        runEnd: [
          'builtin.save-session',
          'builtin.idle-reset',
          'builtin.archive-session',
          'builtin.log-usage',
          'builtin.update-memory',
        ],
      }],
    };

    const assembly: AgentAssembly = {
      workspaceDir: ws,
      createLLM: () => llm,
      resolveTools: (names, cfg) => registry.resolveTools(names, cfg),
      resolveHooks: (names, cfg) => registry.resolveHooks(names, cfg),
      loadHistory: (convKey) => loadHistory(convKey),
      requestRestart: () => { /* 测试不真退出 */ },
    };

    // ---- 阶段 1：正常会话，Agent 调用 system_restart ----
    const r1 = makeRouter(assembly, config);
    const res = await r1.send({ from: 'user', to: 'agentA', type: 'chat.send', payload: '请重启后端' });
    expect(res).toBe(''); // 中断无最终回复
    expect(r1.isShutdownMode()).toBe(true);

    const pf = path.join(ws, '.router_pending.jsonl');
    expect(fs.existsSync(pf)).toBe(true);
    expect(fs.readFileSync(pf, 'utf-8')).toContain('系统已重启完成');

    // ---- 阶段 2：模拟重启（新进程新 router），flush 恢复 ----
    const r2 = makeRouter(assembly, config);
    const flushed = await r2.flushPendingMessages();
    expect(flushed).toBe(1);
    expect(fs.existsSync(pf)).toBe(false);

    // ---- 阶段 3：会话文件应有恢复痕迹 ----
    const sessionFile = path.join(ws, 'sessions', chatDialogKey('user', 'agentA'), 'messages.jsonl');
    expect(fs.existsSync(sessionFile)).toBe(true);
    const content = fs.readFileSync(sessionFile, 'utf-8');
    expect(content).toContain('系统已重启完成');

    // 恢复请求必须是 trigger 语义
    const resumeReq = seen[1];
    expect(resumeReq).toBeDefined();
    expect(resumeReq.some((m: any) => m.role === 'trigger' && String(m.content).includes('系统已重启完成'))).toBe(true);
  });
});

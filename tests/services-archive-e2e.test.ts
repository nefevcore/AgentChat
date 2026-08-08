// ============================================================
// 归档端到端链路测试（L2 router + L3 插件 + L4 ArchiveService）
//
// 复现用户报告问题：手工 requestArchive → 整理轮 → archiveAndRebuild
// 验证：① pending 写入 + 参与者判定（虚拟 counterpart 单侧）
//       ② 整理轮 runEnd → completeArchiveReview → archiveAndRebuild
//       ③ 归档后 messages.jsonl 截断 + history_N 生成 + 标记清理
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { PluginRegistry } from '../src/plugins/registry';
import builtinPlugin from '../src/plugins/builtin';
import { AgentRouter } from '../src/agents/router';
import type { AgentAssembly, AgentConfig } from '../src/agents/config';
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/core/types';
import { ChatStream } from '../src/core/llm/chat-stream';
import { ArchiveService, ARCHIVE_REVIEW_PREFIX } from '../src/services/archive-service';
import { chatDialogKey } from '../src/agents/paths';

let ws = '';
beforeEach(() => {
  ws = path.join(os.tmpdir(), `agentchat-arch-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    loadHistory: (convKey) => {
      // 与 hooks/session loadHistory 一致：读 <ws>/sessions/<dialogId>/messages.jsonl
      const file = path.join(ws, 'sessions', convKey, 'messages.jsonl');
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}

/** 写入会话文件 */
function writeSession(from: string, to: string, msgs: any[]): string {
  const dir = path.join(ws, 'sessions', chatDialogKey(from, to));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), msgs.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
  return dir;
}

describe('归档端到端链路', () => {
  it('手工 requestArchive → 整理轮 runEnd → archiveAndRebuild（虚拟 counterpart 单侧完成）', async () => {
    const registry = new PluginRegistry();
    registry.register(builtinPlugin);
    const llm = makeLLM((req) => {
      // 整理轮 ReAct：直接结束（不调用工具）
      return stop('整理完成');
    });
    const assembly = makeAssembly(registry, llm);
    const router = new AgentRouter(assembly);
    const reg = router.getRegistry();

    // 注册 agent_chat_dev（真实，含归档配置）+ user（虚拟）
    reg.register({
      agent_id: 'agent_chat_dev', name: '艾吉',
      plugins: [{
        name: 'builtin',
        runStart: ['builtin.build-system-prompt', 'builtin.load-history'],
        runEnd: ['builtin.save-session', 'builtin.idle-reset', 'builtin.archive-session', 'builtin.log-usage'],
      }],
      'agent.session': { maxContextTokens: 2000, keepRecentRatio: 0.3, archiveTokenRatio: 0.7 },
    } as unknown as AgentConfig);
    reg.register({ agent_id: 'user', name: '风栗', virtual: true } as AgentConfig);

    // 归档服务（注入真实 router + registry）
    const archive = new ArchiveService({
      wsRoot: ws,
      agentsDir: path.join(ws, 'agents'),
      router,
      registry: reg,
    });

    // 对齐 app/index.ts 装配：注入 PluginServices.archiveSession
    // （builtin hooks 工厂经 makeArchiveSessionHook 读取并委托 handleRunEnd）
    registry.setServices({
      archiveSession: (ctx: any, result: any) => archive.handleRunEnd(ctx, result),
    });

    // 会话：足够大消息使截断生效（maxContextTokens=2000 × keepRecentRatio=0.3 = 600 预算）
    const bigMsgs: any[] = [];
    for (let i = 0; i < 20; i++) {
      bigMsgs.push({
        role: 'agent', content: `m${i} ` + 'x'.repeat(200),
        agent_id: i % 2 ? 'agent_chat_dev' : 'user',
        message_id: `M${i}`,
        timestamp: `2026-08-08T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
    const dir = writeSession('agent_chat_dev', 'user', bigMsgs);

    // 手工触发归档
    archive.requestArchive('agent_chat_dev', 'user');

    // 验证 pending（参与者应只有 agent_chat_dev，user 是虚拟）
    const pendingPath = path.join(dir, '.archive_pending');
    expect(fs.existsSync(pendingPath)).toBe(true);
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    expect(pending.participants).toEqual(['agent_chat_dev']);

    // 等整理轮触发 + runEnd 完成（trigger 300ms 延迟 + run 时间）
    await new Promise((r) => setTimeout(r, 2500));

    // 归档应完成：pending/done 清理
    expect(fs.existsSync(pendingPath)).toBe(false);
    expect(fs.existsSync(path.join(dir, '.archive_done_agent_chat_dev'))).toBe(false);
    // history_1 生成
    const arch = path.join(dir, 'archive', 'history_1.jsonl');
    expect(fs.existsSync(arch)).toBe(true);
    const archMsgs = fs.readFileSync(arch, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(archMsgs.length).toBeGreaterThan(0);
    // messages.jsonl 重建（截断后保留尾部）
    const rebuilt = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8').split('\n').filter(Boolean);
    expect(rebuilt.length).toBeLessThan(bigMsgs.length);
    // 成功归档（整理轮完成）不写审查标记（审查标记机制已移除）
    expect(fs.existsSync(path.join(ws, 'files', 'agent_chat_dev', 'memory', 'user.memory_review_needed'))).toBe(false);
  });

  it('整理轮 hint 以 [归档整理] 开头', async () => {
    const registry = new PluginRegistry();
    registry.register(builtinPlugin);
    const router = new AgentRouter(makeAssembly(registry, makeLLM(() => stop('ok'))));
    const reg = router.getRegistry();
    reg.register({ agent_id: 'agentA', name: 'A' } as AgentConfig);
    reg.register({ agent_id: 'user', virtual: true } as AgentConfig);

    const seen: any[] = [];
    const archive = new ArchiveService({
      wsRoot: ws,
      router: { trigger: async (id: string, opts?: any) => { seen.push({ id, opts }); return ''; } } as any,
      registry: reg,
    });
    archive.requestArchive('agentA', 'user');
    await new Promise((r) => setTimeout(r, 400));
    expect(seen.length).toBe(1); // 仅 agent 侧
    expect(seen[0].opts.meta?.['archive-review']).toBe(true);
    expect(seen[0].opts.hint.startsWith(ARCHIVE_REVIEW_PREFIX)).toBe(true);
  });
});

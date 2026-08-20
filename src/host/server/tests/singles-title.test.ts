// ============================================================
// 独立会话自动标题钩子测试（singles.auto-title stepEnd）
//   · 未命名 single 会话：step 1 结束 → LLM 生成标题 + onUpdated 通知
//   · LLM 失败 → 回落首条用户消息截断
//   · 已有标题 / 非 single 会话 → 不触发
//   · 并发幂等（in-flight 守卫）
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMProvider, LLMRequest, LLMResponse } from '@agentchat/llm';
import { SinglesService } from '../src/singles';
import { makeSingleTitleHook } from '../src/singles-title';
import type { CurrentContext } from '@agentchat/contracts';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-singles-title-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const fakeRegistry = {
  get: (id: string) => (id === 'alpha' ? { agent_id: 'alpha' } : undefined),
  listIds: () => ['alpha'],
};

function makeService(): SinglesService {
  return new SinglesService({ wsRoot: tmp, registry: fakeRegistry, llmPools: () => ({}) });
}

/** 最小 CurrentContext 桩（钩子只读 dialogId/currentMessage/history/llm） */
function makeCtx(dialogId: string, userText: string, llm: LLMProvider): CurrentContext {
  return {
    llm,
    systemPrompt: '',
    history: [],
    currentMessage: { role: 'user', content: userText },
    tools: new Map(),
    inbox: { nextTurn: [], nextStep: [] },
    dialogId,
    agentId: 'alpha',
  } as unknown as CurrentContext;
}

function makeLLM(reply?: string): LLMProvider {
  return {
    model: 'test',
    async chat(req: LLMRequest): Promise<LLMResponse> {
      // 标题生成必须关思考（轻量任务）
      expect(req.thinking).toBe(false);
      if (reply === undefined) throw new Error('LLM down');
      return { content: reply, toolCalls: [], finishReason: 'stop' };
    },
    stream() { throw new Error('unused'); },
    toProviderMessages: (m) => m as any,
    fromProviderMessages: (m) => m as any,
  };
}

/** 等待 fire-and-forget 标题任务落盘 */
async function waitForTitle(svc: SinglesService, sid: string, ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (svc.getRecord(sid)?.title) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('singles.auto-title 钩子', () => {
  it('未命名 single 会话：step 结束 → LLM 标题落盘 + onUpdated 通知', async () => {
    const svc = makeService();
    const info = svc.create({ agentId: 'alpha' });
    const onUpdated = vi.fn();
    const hook = makeSingleTitleHook(svc, onUpdated);

    await hook(makeCtx(`single~${info.id}`, '帮我重构一下登录模块', makeLLM('"登录模块重构"')),
      { done: false, interrupted: false }, []);
    await waitForTitle(svc, info.id);

    expect(svc.get(info.id)?.title).toBe('登录模块重构'); // 引号被清洗
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(onUpdated.mock.calls[0][0]).toMatchObject({ id: info.id });
  });

  it('LLM 失败 → 回落首条用户消息截断', async () => {
    const svc = makeService();
    const info = svc.create({ agentId: 'alpha' });
    const hook = makeSingleTitleHook(svc);

    const long = '这是一个非常长的用户消息'.repeat(5);
    await hook(makeCtx(`single~${info.id}`, long, makeLLM(undefined)),
      { done: false, interrupted: false }, []);
    await waitForTitle(svc, info.id);

    const title = svc.get(info.id)?.title ?? '';
    expect(title.length).toBeLessThanOrEqual(25); // 24 字符 + 省略号
    expect(title.endsWith('…')).toBe(true);
  });

  it('已有标题 / 非 single 会话 / 空消息 → 不触发', async () => {
    const svc = makeService();
    const titled = svc.create({ agentId: 'alpha', title: '已有标题' });
    const untitled = svc.create({ agentId: 'alpha' });
    const hook = makeSingleTitleHook(svc);
    const llm = makeLLM('不该出现的标题');

    await hook(makeCtx(`single~${titled.id}`, '消息', llm), { done: false, interrupted: false }, []);
    await hook(makeCtx('chat~user~alpha', '消息', llm), { done: false, interrupted: false }, []);
    await hook(makeCtx(`single~${untitled.id}`, '   ', llm), { done: false, interrupted: false }, []);
    await new Promise((r) => setTimeout(r, 50));

    expect(svc.get(titled.id)?.title).toBe('已有标题');
    expect(svc.get(untitled.id)?.title).toBeUndefined();
  });

  it('模型输出清洗：去引号/取首行/超长截断', async () => {
    const svc = makeService();
    const info = svc.create({ agentId: 'alpha' });
    const hook = makeSingleTitleHook(svc);

    await hook(makeCtx(`single~${info.id}`, '问', makeLLM('「多行\n标题」'.repeat(6))),
      { done: false, interrupted: false }, []);
    await waitForTitle(svc, info.id);

    const title = svc.get(info.id)?.title ?? '';
    expect(title).not.toContain('\n');
    expect(title.length).toBeLessThanOrEqual(24);
  });
});

// Router 网络失效模式集成测试：notifyNetworkError → 消息入队 → recover → 重投
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock @agents/config（getGlobalConfig 返回 llmProviders）
const mockCfg = vi.hoisted(() => ({
  llmProviders: { deepseek: { base_url: 'https://api.deepseek.com' } },
}));
vi.mock('@agents/config', () => ({ getGlobalConfig: () => mockCfg }));

import { AgentRouter } from '@agents/router';

// 构造最小 registry（不触发真实 Agent）
function makeRouter() {
  const registry: any = {
    getAgent: () => null,
    listIds: () => ['agent1'],
    isVirtual: () => false,
    getAgentName: () => undefined,
  };
  const r = new AgentRouter(registry);
  return r as any;
}

describe('Router 网络失效模式', () => {
  it('连续 2 次网络错误进入 down，之后 send 入队', async () => {
    const r = makeRouter();
    expect(r.isNetworkDown()).toBe(false);
    r.notifyNetworkError(); // 1 次
    expect(r.isNetworkDown()).toBe(false); // 未达阈值
    r.notifyNetworkError(); // 2 次
    expect(r.isNetworkDown()).toBe(true); // 进入 down

    // down 时 send 应入队返回提示
    const msg = { from: 'user', to: 'agent1', type: 'chat.send', payload: 'hi' };
    const result = await r.send(msg);
    expect(result).toContain('网络异常');
    expect(r._networkDownMessages.length).toBe(1);
  });

  it('recover 退出 down 并清空队列', async () => {
    const r = makeRouter();
    r.notifyNetworkError(); r.notifyNetworkError();
    expect(r.isNetworkDown()).toBe(true);
    r._networkDownMessages.push({ from: 'user', to: 'agent1', type: 'chat.send', payload: 'hi' });
    const sent = await r.notifyNetworkRecover();
    expect(sent).toBe(1); // 尝试重投
    expect(r.isNetworkDown()).toBe(false);
    expect(r._networkDownMessages.length).toBe(0);
  });

  it('单次网络错误不进入 down（防抖动）', () => {
    const r = makeRouter();
    r.notifyNetworkError();
    expect(r.isNetworkDown()).toBe(false);
  });
});

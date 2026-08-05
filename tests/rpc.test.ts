// RPC 桥单元测试（v0.5.0 P5）
import { describe, it, expect } from 'vitest';
import { RPCBridge, parseRPCMessage, buildRPCSuccess, buildRPCError } from '../src/services/rpc';
import { ServiceRegistry } from '../src/services/registry';

class FakeAgentService {
  list() { return [{ agent_id: 'a', name: 'A' }]; }
  getEffectiveConfig(agentId: string) { return { agent_id: agentId, model: 'x' }; }
  update(obj: { id: string; name: string }) { return { ok: true, id: obj.id, name: obj.name }; }
}

describe('RPCBridge（v0.5.0 P5）', () => {
  it('registerService 映射公开方法为 name.method', () => {
    const reg = new ServiceRegistry();
    const svc = new FakeAgentService();
    reg.register('agentService', svc);
    const rpc = new RPCBridge(reg);
    rpc.registerService('agent', svc);
    const methods = rpc.listMethods();
    expect(methods).toContain('agent.list');
    expect(methods).toContain('agent.getEffectiveConfig');
    expect(methods).not.toContain('agent.constructor');
  });

  it('call 执行服务方法并返回结果', async () => {
    const reg = new ServiceRegistry();
    const svc = new FakeAgentService();
    reg.register('agentService', svc);
    const rpc = new RPCBridge(reg);
    rpc.registerService('agent', svc);

    const result = await rpc.call('agent.list', {});
    expect(result).toEqual([{ agent_id: 'a', name: 'A' }]);
  });

  it('call 对象参数透传给服务方法', async () => {
    const reg = new ServiceRegistry();
    const svc = new FakeAgentService();
    reg.register('agentService', svc);
    const rpc = new RPCBridge(reg);
    rpc.registerService('agent', svc);
    const result = await rpc.call('agent.update', { id: 'b', name: 'B' });
    expect(result).toEqual({ ok: true, id: 'b', name: 'B' });
  });

  it('call 无参方法', async () => {
    const reg = new ServiceRegistry();
    const svc = new FakeAgentService();
    reg.register('agentService', svc);
    const rpc = new RPCBridge(reg);
    rpc.registerService('agent', svc);
    const result = await rpc.call('agent.list', undefined);
    expect(result).toEqual([{ agent_id: 'a', name: 'A' }]);
  });

  it('call 未知方法抛 -32601', async () => {
    const rpc = new RPCBridge(new ServiceRegistry());
    await expect(rpc.call('nope.missing', {})).rejects.toMatchObject({ code: -32601 });
  });

  it('parseRPCMessage 解析 type=rpc 消息', () => {
    const parsed = parseRPCMessage({ type: 'rpc', method: 'agent.list', params: {}, id: 1 });
    expect(parsed).toEqual({ method: 'agent.list', params: {}, id: 1 });
    expect(parseRPCMessage({ type: 'chat.send', method: 'x' })).toBeNull();
  });

  it('buildRPCSuccess / buildRPCError 序列化正确', () => {
    const ok = JSON.parse(buildRPCSuccess(1, { a: 1 }));
    expect(ok.type).toBe('rpc.response');
    expect(ok.id).toBe(1);
    expect(ok.result).toEqual({ a: 1 });

    const err = JSON.parse(buildRPCError(2, -32601, '不存在'));
    expect(err.type).toBe('rpc.error');
    expect(err.error.code).toBe(-32601);
  });
});

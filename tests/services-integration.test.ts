// ============================================================
// L4 门面集成测试 —— ServiceRegistry + RPCBridge + AgentService +
// InteractionBridge + GroupService + runtime 协同
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRouter } from '../src/agents/router';
import type { AgentAssembly, AgentConfig } from '../src/agents/config';
import { AgentService } from '../src/services/agent-service';
import { ServiceRegistry } from '../src/services/registry';
import { RPCBridge } from '../src/services/rpc';
import { InteractionBridge } from '../src/services/interactions';
import { GroupService } from '../src/services/group-service';
import { initRuntime, getRegistry } from '../src/services/runtime';

/** 最小装配（集成不实际跑 LLM；仅构造 Router 用） */
function makeAssembly(): AgentAssembly {
  return {
    createLLM: () => ({ model: 'stub' }) as any,
    resolveTools: () => new Map(),
    loadHistory: () => [],
  };
}

afterEach(() => {
  fs.rmSync(path.join(os.tmpdir(), 'svc-integ'), { recursive: true, force: true });
});

describe('L4 门面集成', () => {
  it('ServiceRegistry + RPCBridge + AgentService + runtime 协同', async () => {
    const router = new AgentRouter(makeAssembly());
    const registry = router.getRegistry();
    registry.register({ agent_id: 'agentA', name: 'Agent A', llm: { provider: 'deepseek', model: 'x' } } as AgentConfig);
    registry.register({ agent_id: 'user', name: '用户', virtual: true } as AgentConfig);

    initRuntime({ router, globalConfig: { workspaceDir: 'workspace/default', llmProviders: {}, agentsDir: 'agents' } });

    const svcReg = new ServiceRegistry();
    const agentService = new AgentService({ registry: getRegistry() });
    svcReg.register('agentService', agentService);
    const rpc = new RPCBridge(svcReg);
    rpc.registerService('agent', agentService);

    // 方法映射
    expect(rpc.listMethods()).toContain('agent.listBasic');
    expect(rpc.listMethods()).toContain('agent.getEffectiveConfig');
    expect(rpc.listMethods()).not.toContain('agent.constructor');

    // 无参方法
    const basic = await rpc.call('agent.listBasic', undefined);
    expect(basic).toEqual([
      { id: 'agentA', name: 'Agent A', virtual: false },
      { id: 'user', name: '用户', virtual: true },
    ]);

    // 数组参数（多参方法：getEffectiveConfig(agentId, agentDiff)）
    const eff = await rpc.call('agent.getEffectiveConfig', ['agentA', { name: 'AgentA', llm: { provider: 'deepseek' } }]);
    expect(eff.agent_id).toBe('agentA');
    expect(eff.workspaceDir).toBeUndefined(); // 全局专属键删除
    expect((eff as any).llm?.provider).toBe('deepseek');

    // 未知方法 → JSON-RPC 标准错误码
    await expect(rpc.call('agent.nope', {})).rejects.toMatchObject({ code: -32601 });
  });

  it('InteractionBridge 经 router（EventEmitter）桥接', async () => {
    const router = new AgentRouter(makeAssembly());
    const events: any[] = [];
    router.on('chat.interaction', (d) => events.push(d));

    const bridge = new InteractionBridge(router);
    const p = bridge.askUser({ agentId: 'a', convKey: 'user__a', question: 'Q', options: ['1', '2'], timeoutMs: 5000 });
    expect(events.length).toBe(1);
    bridge.respond(events[0].interaction_id, '2');
    await expect(p).resolves.toBe('2');
  });

  it('GroupService 挂到 router 内置 GroupManager 持久化', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-integ-'));
    const router = new AgentRouter(makeAssembly());
    router.getRegistry().register({ agent_id: 'a', name: 'A' } as AgentConfig);
    router.getRegistry().register({ agent_id: 'b', name: 'B' } as AgentConfig);

    const groupService = new GroupService(router.getGroupManager(), tmp);
    const g = groupService.createGroup({ group_id: 'gi', name: '集成群', participants: ['a', 'b'] });
    expect(g.participants).toEqual(['a', 'b']);
    expect(groupService.getGroup('gi')?.name).toBe('集成群');

    // 磁盘已落 group.json（createGroup → group.created 事件 → GroupService 持久化）
    const cfgPath = path.join(tmp, 'groups', 'gi', 'group.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).group_id).toBe('gi');

    // 重启恢复：新建 router + GroupService 从磁盘加载（内存已清空的场景）
    const router2 = new AgentRouter(makeAssembly());
    router2.getRegistry().register({ agent_id: 'a', name: 'A' } as AgentConfig);
    router2.getRegistry().register({ agent_id: 'b', name: 'B' } as AgentConfig);
    const svc2 = new GroupService(router2.getGroupManager(), tmp);
    expect(svc2.loadGroupsFromDisk()).toBe(1);
    expect(router2.getGroupManager().getGroup('gi')?.name).toBe('集成群');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

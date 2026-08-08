// ============================================================
// src/services/runtime 单元测试 —— 运行时门面（L4）
//
// 注意：本文件内模块级状态（initRuntime）按测试声明顺序流转——
// 首条测试在未注入状态下断言抛错，其后测试注入 stub router。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  initRuntime, getRouter, getRegistry, getGroupManager,
  requestRestart, getGlobalConfig, setGlobalConfig,
} from '../src/services/runtime';

/** 最小结构 router（含内置 registry/groupManager 访问器） */
function makeStubRouter() {
  const registry = { listIds: () => ['a', 'b'] };
  const groupManager = { listGroups: () => [{ group_id: 'g1', name: 'G1', participants: ['a'], created_at: 1 }] };
  return {
    getRegistry: () => registry,
    getGroupManager: () => groupManager,
  };
}

describe('services/runtime', () => {
  it('未 initRuntime 时 getRouter 抛错（标识装配顺序问题）', () => {
    expect(() => getRouter()).toThrow(/Router 未注入/);
    expect(() => getRegistry()).toThrow(/未注入/);
  });

  it('initRuntime 注入 router + requestRestart + globalConfig', () => {
    const router = makeStubRouter() as any;
    const registry = router.getRegistry();
    const groupManager = router.getGroupManager();
    let restartReason: string | undefined;
    initRuntime({
      router,
      requestRestart: (r?: string) => { restartReason = r; },
      globalConfig: { workspaceDir: 'ws', llmProviders: {} },
    });

    expect(getRouter()).toBe(router);
    expect(getRegistry()).toBe(registry);
    expect(getGroupManager()).toBe(groupManager);
    expect(getGlobalConfig()).toEqual({ workspaceDir: 'ws', llmProviders: {} });

    requestRestart('test-reason');
    expect(restartReason).toBe('test-reason');
  });

  it('setGlobalConfig 更新持有对象', () => {
    setGlobalConfig({ a: 1, b: 2 });
    expect(getGlobalConfig()).toEqual({ a: 1, b: 2 });
    setGlobalConfig({});
    expect(getGlobalConfig()).toEqual({});
  });

  it('requestRestart 未注入时降级不抛', () => {
    initRuntime({ router: makeStubRouter() as any });
    expect(() => requestRestart('x')).not.toThrow();
  });

  it('getGroupManager 从 router 派生（非独立注入）', () => {
    const router = makeStubRouter() as any;
    initRuntime({ router });
    expect(getGroupManager()).toBe(router.getGroupManager());
  });
});

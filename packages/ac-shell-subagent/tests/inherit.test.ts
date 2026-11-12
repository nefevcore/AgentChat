// ============================================================
// inherit.test.ts —— spawn 物化单源回归锁（cr-856 症状三）
//
// 「什么该继承」判据收拢后用纯函数直测锁定：过滤词表 / 会话映射表 /
// 形态合成 / workdir 与 model 快照。此前这些语义散在 spawnOp 内联，
// 只能经服务面间接触达（新键登记靠记忆——继承问题反复的根源）。
// ============================================================
import { describe, it, expect } from 'vitest';
import type { AgentConfig } from 'ac-agents-core';
import { filterSpawnTools, convInheritOf, spawnChildConfigOf } from '../src/inherit.ts';

describe('cr-856 spawn 物化单源（inherit.ts）', () => {
  it('filterSpawnTools：行 id 词形——未命中/subagent/run-code/父行集外拒绝，面内授予', () => {
    // cr-1022 批4：词面 = 父壳活装配行集（bootShell 注入——静态目录不查）
    const shellRowIds = new Set(['fs-tools', 'fs-search', 'shell-tools', 'ledger', 'tools', 'browser', 'subagent', 'run-code']);
    const parentIds = new Set(['fs-tools', 'fs-search', 'shell-tools', 'ledger', 'tools']);
    const out = filterSpawnTools(['fs-search', 'subagent', 'run-code', 'healthz', 'browser', 'fs_read'], parentIds, shellRowIds);
    expect(out.granted).toEqual(['fs-search']);
    expect(out.rejected).toContain('subagent'); // 拒绝词（防子孙无限增长）
    expect(out.rejected).toContain('run-code'); // 拒绝词（子域程序化形态收窄）
    expect(out.rejected).toContain('healthz'); // 未命中目录
    expect(out.rejected).toContain('browser'); // 不属父行集
    expect(out.rejected).toContain('fs_read'); // 工具名词形退役——不再展开
  });

  it('convInheritOf：access 水位取高 + browserTier 层级映射；tc-*/issueSubmit 无继承面', () => {
    const full = convInheritOf({ access: 'full-access', toolMode: 'tc-programmatic', browserTier: 'inject', issueSubmit: 'enabled' }, 'sandbox-access');
    expect(full.access).toBe('full-access');
    expect(full.browserLevel).toBe('inject');
    // 无设置 + per-call 提权兜底
    expect(convInheritOf({}, 'full-access')).toEqual({ access: 'full-access' });
    // 空面无词
    expect(convInheritOf({}, undefined)).toEqual({});
  });

  it('spawnChildConfigOf：toolMode 结构化合成 + rows 含 run-code 合成形态 + model/workdir 快照', () => {
    const parent: AgentConfig = {
      id: 'papa', model: 'mock',
      rows: ['run-code', 'fs-tools'],
      access: 'full-access',
      settings: { other: { flag: 1 } },
    } as AgentConfig;
    // ① 缺省继承（rows 含 run-code）：形态 = 父形态 ∧ 子行集（cr-1021：
    // 常规父不合成程序化——run-code 进基础集后行集信号对缺省继承恒真）
    const inheritRun = spawnChildConfigOf({ parent });
    expect(inheritRun.toolMode).toBeUndefined();
    expect(inheritRun.access).toBe('full-access');
    // ①' 程序化父 + 子行集含 run-code：合成 tc-programmatic
    const progParent = { ...parent, toolMode: 'tc-programmatic' } as AgentConfig;
    const inheritProg = spawnChildConfigOf({ parent: progParent });
    expect(inheritProg.toolMode).toBe('tc-programmatic');
    // ② 显式子集（无 run-code）：无形态词
    const subset = spawnChildConfigOf({ parent, tools: ['fs-tools'] });
    expect(subset.toolMode).toBeUndefined();
    expect(subset.rows).toEqual(['fs-tools']);
    // ③ workdir 快照并入 security（其余 settings 保留）；model 覆盖拆分
    const withAnchor = spawnChildConfigOf({ parent, tools: ['fs-tools'], workdirAnchor: 'D:/ws', modelOverride: 'poolB@glm-5.3' });
    const sec = (withAnchor.settings as { security?: { workdir?: string }; other?: unknown }).security;
    expect(sec?.workdir).toBe('D:/ws');
    expect((withAnchor.settings as { other?: unknown }).other).toEqual({ flag: 1 });
    expect(withAnchor.model).toBe('glm-5.3');
    expect(withAnchor.provider).toBe('poolB');
    // ④ 无锚点不写 security；父 settings 缺席 + 无锚 = 不带 settings 键
    const noAnchor = spawnChildConfigOf({ parent: { id: 'p', model: 'm', rows: ['read'] } as AgentConfig, tools: ['read'] });
    expect((noAnchor as { settings?: unknown }).settings).toBeUndefined();
  });
});

// ============================================================
// inherit.test.ts —— spawn 物化单源回归锁（cr-856 症状三）
//
// 「什么该继承」判据收拢后用纯函数直测锁定：过滤词表 / 会话映射表 /
// 形态合成 / workdir 与 model 快照。此前这些语义散在 spawnOp 内联，
// 只能经服务面间接触达（新键登记靠记忆——继承问题反复的根源）。
// ============================================================
import { describe, it, expect } from 'vitest';
import type { AgentConfig } from 'ac-agents-core';
import { readCatalog, deriveShellRowset } from 'ac-rowset-core';
import { filterSpawnTools, convInheritTagsOf, spawnChildConfigOf } from '../src/inherit.ts';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const CATALOG = readCatalog(path.join(process.env.AGENTCHAT_REPO_ROOT ?? process.cwd(), 'apps', 'catalog', 'row-catalog.json'));

describe('cr-856 spawn 物化单源（inherit.ts）', () => {
  it('filterSpawnTools：越面/subagent/run-code 拒绝，面内授予', () => {
    // parentIds 与 spawnOp 同构（真实派生——含恒并基座行）
    const parentIds = new Set(deriveShellRowset({ rows: ['fs-tools', 'shell-tools', 'fs-search'] }, CATALOG).rowIds);
    const out = filterSpawnTools(['read', 'fs-search', 'subagent', 'run_code', 'healthz', 'browser'], parentIds, CATALOG);
    expect(out.granted).toEqual(['read', 'fs-search']);
    expect(out.rejected).toContain('subagent');
    expect(out.rejected).toContain('run_code');
    expect(out.rejected).toContain('healthz'); // 未命中目录
    expect(out.rejected).toContain('browser'); // 不属父行集
  });

  it('convInheritTagsOf：水位取高 + grants 全链映射；tc-* 不产生', () => {
    const full = convInheritTagsOf({ elevation: 'full-access', toolMode: 'tc-programmatic', browserTier: 'inject', issueSubmit: 'enabled' }, 'sandbox-access');
    for (const t of ['full-access', 'web', 'observe', 'manipulate', 'inject', 'issue-report']) {
      expect(full).toContain(t);
    }
    expect(full).not.toContain('tc-programmatic'); // 形态词非授权——不继承
    // 无设置 + per-call 提权兜底
    expect(convInheritTagsOf({}, 'full-access')).toEqual(['full-access']);
    // 空面无词
    expect(convInheritTagsOf({}, undefined)).toEqual([]);
  });

  it('spawnChildConfigOf：tc-* 剥除 + rows 含 run-code 合成形态 + model/workdir 快照', () => {
    const parent: AgentConfig = {
      id: 'papa', model: 'mock',
      rows: ['run-code', 'fs-tools'],
      tags: ['tc-programmatic', 'full-access'],
      settings: { other: { flag: 1 } },
    } as AgentConfig;
    // ① 缺省继承（rows 含 run-code）：形态合成 + 授权词保留
    const inheritRun = spawnChildConfigOf({ parent }, CATALOG);
    expect(inheritRun.tags).toContain('tc-programmatic');
    expect(inheritRun.tags).toContain('full-access');
    // ② 显式子集（无 run-code）：无形态词
    const subset = spawnChildConfigOf({ parent, tools: ['read'] }, CATALOG);
    expect(subset.tags).not.toContain('tc-programmatic');
    expect(subset.rows).toEqual(['read']);
    // ③ workdir 快照并入 security（其余 settings 保留）；model 覆盖拆分
    const withAnchor = spawnChildConfigOf({ parent, tools: ['read'], workdirAnchor: 'D:/ws', modelOverride: 'poolB@glm-5.3' }, CATALOG);
    const sec = (withAnchor.settings as { security?: { workdir?: string }; other?: unknown }).security;
    expect(sec?.workdir).toBe('D:/ws');
    expect((withAnchor.settings as { other?: unknown }).other).toEqual({ flag: 1 });
    expect(withAnchor.model).toBe('glm-5.3');
    expect(withAnchor.provider).toBe('poolB');
    // ④ 无锚点不写 security；父 settings 缺席 + 无锚 = 不带 settings 键
    const noAnchor = spawnChildConfigOf({ parent: { id: 'p', model: 'm', rows: ['read'] } as AgentConfig, tools: ['read'] }, CATALOG);
    expect((noAnchor as { settings?: unknown }).settings).toBeUndefined();
  });
});

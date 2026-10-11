// ============================================================
// ac-plugin-registry：MINIMAL_CORE_ENTRY_IDS 与装配树一致性锁定
//
// 核心集是 cordis.yml 行 id 的纯手工镜像（行 id 无程序化导出面，只能
// 字面维护）——此前零锁定：yml 新增行漏进核心集 → minimal 模式照旧
// 停用它，语义漂移静默发生。双向锁：
//   · 核心集 ⊆ 装配树行 id——拼写漂移即红（永不命中的死 id）；
//   · 装配树每行 ∈ 核心集 ∪ 豁免表——新增 yml 行未裁决即红，迫使
//     维护者显式定夺（核心行进集 / 可停用行进豁免表）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MINIMAL_CORE_ENTRY_IDS } from '../src/service.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const yml = readFileSync(join(repoRoot, 'src', 'cordis.yml'), 'utf8');

/** cordis.yml 全部裸行 id（与组合根 TREE 一致性另有测试锁定） */
function ymlEntryIds(): string[] {
  return [...yml.matchAll(/^- id: (\S+)/gm)].map((m) => m[1]);
}

/** 装配树中经显式裁决不进核心集的行（可停用行；增删即本测试红灯） */
const DISABLABLE_EXEMPT = new Set([
  'agent-presets', 'preset-builtin', 'singles', 'conv-settings', 'persona', 'system-prompt',
  'memory', 'goal', 'todo', 'hello', 'bench', 'fs-tools', 'fs-search', 'file-snapshots',
  'str-replace-editor', 'shell-tools', 'run-code', 'math', 'web-tools', 'issue-tools',
  'harness-tools', 'sap-adt', 'sap-adt-preset', 'dev-tools', 'tag-registry', 'restart',
  'session-query', 'subagent', 'ask-questions', 'archive',
  // UI 行全部可停用（最小集 = 无 UI 裸聊天诊断基线）
  'ui-runview', 'ui-todo', 'ui-jobs', 'ui-workspace', 'ui-singles', 'ui-group', 'ui-agents',
  'ui-goal', 'ui-usage', 'ui-skill', 'ui-system', 'ui-timer', 'ui-shell', 'ui-fs', 'ui-web',
  'ui-browser', 'ui-subagent', 'ui-run-code', 'ui-run-nodes', 'ui-llm-pool',
  'ui-plugin-registry', 'ui-desktop-storage', 'ui-search-pool', 'ui-onboarding', 'ui-theme',
  'ui-renderer', 'ui-tool', 'ui-conversation', 'ui-settings', 'ui-layout', 'ui-remote',
  // 其余可停用行
  'event-policy', 'datetime', 'skill', 'collab-tools', 'mcp', 'timer-tools', 'job-wakeup',
  'plugin-market', 'remote-link', 'agent-admin', 'hmr',
]);

describe('MINIMAL_CORE_ENTRY_IDS 与装配树一致性', () => {
  it('核心集 ⊆ 装配树行 id（拼写漂移即红）', () => {
    const ymlIds = new Set(ymlEntryIds());
    const drifted = [...MINIMAL_CORE_ENTRY_IDS].filter((id) => !ymlIds.has(id));
    expect(drifted).toEqual([]);
  });

  it('装配树每行已裁决：∈ 核心集 ∪ 豁免表（新增行未定夺即红）', () => {
    const undecided = ymlEntryIds().filter((id) => !MINIMAL_CORE_ENTRY_IDS.has(id) && !DISABLABLE_EXEMPT.has(id));
    expect(undecided).toEqual([]);
  });
});

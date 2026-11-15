// ============================================================
// cr1114-faces.test.ts —— cr-1114 批1 三面验收（计划 §2.4 新增用例 ①②）
//
// 目的态：白名单/程序化会话首 run 即见 timer 与 update_agent_profile——
//   ① tc-base 会话工具面（llmToolFace 单源 → toolDefs）含二者
//   ② singles + tc-programmatic 会话**首 run** 物化的前缀快照即含
//      GUIDELINES_TIMER 段与 PTC_SDK 中的 timer 声明（非 run 2 收敛）
// 真壳 boot（bootShell——骨架行全量，含 host-face-client 承诺面）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootShell, type ShellBootResult } from '../boot.ts';
import { makeEnvelope } from 'ac-envelope-core';
import { readPrefixSnapshot } from 'ac-shell-conversation/src/prefix-snapshot.ts';
import { writeAgentConfig, writeAgentPatchV3At, rowsToMenuDefs } from 'ac-agents-core';
import { readCatalog } from 'ac-rowset-core';

const ROOT = path.join('sandbox', 'test-cr1114-faces-' + process.pid);
const CATALOG = fileURLToPath(new URL('../../catalog/row-catalog.json', import.meta.url));

beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** 能力行定义面（catalog 非骨架行）——rowsToMenuDefs 的展开源 */
function capabilityRows(): Array<{ id: string; name?: string; requires?: string[] }> {
  return readCatalog(CATALOG).rows
    .filter((r) => r.tree === 'shell' && r.zone !== 'skeleton')
    .map((r) => ({
      id: r.id,
      ...(r.path !== undefined ? { name: 'link:' + r.path } : {}),
      ...(r.requires !== undefined ? { requires: r.requires } : {}),
    }));
}

/**
 * Agent 播种：rows = 行集点名（v3 菜单片段定义面）。
 * 注意与 toolFaceOf 的 include 词形区分——后者只影响工具名展开，不驱动行装配
 *（行装配 = 骨架 ∪ patch defs ∪ installed，menu-assembly §六）。
 */
function seedAgent(id: string, rows?: string[]): void {
  writeAgentConfig(ROOT, { id, model: 'mock', ...(rows !== undefined ? { rows } : {}) } as never);
  const dir = path.join(ROOT, 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  const { defs, fingerprints } = rowsToMenuDefs(rows, capabilityRows());
  writeAgentPatchV3At(dir, defs, fingerprints);
}

/** singles 注册表直投（SinglesShim 读面——meta/sessions/） */
function seedSingles(sid: string): void {
  const dir = path.join(ROOT, 'meta', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.singles-registry.json'), JSON.stringify({ version: 1, entries: { [sid]: {} } }), 'utf-8');
}

/** conv-settings 直投（壳内 ConvSettingsShim 读面） */
function seedConvSettings(sid: string, patch: Record<string, string>): void {
  fs.mkdirSync(path.join(ROOT, 'conv-settings'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'conv-settings', sid + '.json'), JSON.stringify(patch), 'utf-8');
}

async function boot(agentId: string): Promise<ShellBootResult> {
  fs.copyFileSync(CATALOG, path.join(ROOT, 'row-catalog.json'));
  return bootShell({ dataRoot: ROOT, agentId, catalogFile: CATALOG, mockProvider: true }, { emit: () => {} });
}

describe('cr-1114 批1 三面验收（宿主能力面承诺面）', () => {
  it('① 白名单 Agent：tc-base 会话工具面含 timer 与 update_agent_profile（boot 即在册，无需首 run）', async () => {
    // 行集点名 host-face-client（骨架行恒装；此处显式点名 = 白名单消费形态）
    seedAgent('timerable', ['fs-tools', 'host-face-client']);
    const shell = await boot('timerable');
    try {
      const conv = shell.ctx.get('conversation', false) as { toolDefs(conversationId?: string): { names: string[] } } | undefined;
      expect(conv).toBeDefined();
      const names = conv!.toolDefs('u~timerable').names;
      expect(shell.rowset.rowIds).toContain('fs-tools'); // 点名行已装配
      expect(names).toContain('timer');
      expect(names).toContain('update_agent_profile');
      expect(names).toContain('read'); // 点名行工具照旧在面
    } finally { await shell.close(); }
  });

  it('② singles tc-programmatic 会话：首 run 快照即含 GUIDELINES_TIMER 段与 PTC_SDK timer 声明', async () => {
    seedAgent('timerable', ['run-code', 'host-face-client']);
    const sid = 'sid-cr1114-prog';
    seedSingles(sid);
    seedConvSettings(sid, { toolMode: 'tc-programmatic' });
    const shell = await boot('timerable');
    try {
      expect(shell.rowset.rowIds).toContain('run-code');
      const conv = shell.ctx.get('conversation', false) as unknown as {
        receiveEnvelope(env: unknown, opts: { fresh: boolean }): Promise<unknown>;
      };
      await conv.receiveEnvelope(makeEnvelope({
        uuid: sid, requestId: 'cr1114-r1', sender: 'user', to: 'timerable',
        payload: { text: '第一问' },
      }), { fresh: true });
      // 首 run 物化的快照（无第二次 run）
      const snap = readPrefixSnapshot(ROOT, sid);
      expect(snap).not.toBeNull();
      const byName = new Map(snap!.sections.map((s) => [s.name, s.text]));
      // 远程段：GUIDELINES_TIMER（壳内无本地 owner，宿主承诺面提供）
      expect(byName.get('GUIDELINES_TIMER')).toContain('主动用 timer(action="set")');
      // SDK 投影：PTC_SDK 段文本含 timer 声明
      const ptc = byName.get('PTC_SDK') ?? '';
      expect(ptc).toContain('timer');
      expect(ptc).toContain('update_agent_profile');
    } finally { await shell.close(); }
  });
});

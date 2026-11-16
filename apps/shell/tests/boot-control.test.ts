// ============================================================
// boot 控制帧面单测（M8.3）：mock 壳 control 直调——interrupt（无 run 时
// false）/ bench（scripted 全链真跑 + TSV 信号）；persist 语义归 e2e。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IpcClient } from 'ac-envelope-core';
import { isManageReply, makeManageRequest, type ManageReply } from 'ac-envelope-core';
import { bootShell } from '../boot.ts';
import { writeAgentConfig } from 'ac-agents-core';
import type { AgentConfig } from 'ac-agents-core';

const ROOT = path.join('sandbox', 'test-ctrl-' + process.pid);
const CATALOG = path.join(process.env.AGENTCHAT_REPO_ROOT ?? process.cwd(), 'apps', 'catalog', 'row-catalog.json');
/** v3 播种（cr-1022 批3：boot 对 config.json-only 旧形态 fail-loud） */
function seed(agentId: string, cfg: { rows?: AgentConfig['rows']; settings?: Record<string, unknown> } = {}): void {
  writeAgentConfig(ROOT, { id: agentId, model: 'mock', ...cfg });
}
beforeEach(() => {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.copyFileSync(CATALOG, path.join(ROOT, 'row-catalog.json'));
  seed('kilo', { rows: { include: ['bench'] } });
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('M8.3 boot 控制帧面', () => {
  it('interrupt：无活跃 run 返回 {interrupted:false}', async () => {
    seed('kilo');
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'kilo', catalogFile: CATALOG, mockProvider: true },
    );
    try {
      expect(await boot.control({ ctrl: 'interrupt' })).toEqual({ interrupted: false });
    } finally { await boot.close(); }
  });

  it('bench：控制帧全链（scripted mock → loop → 对拍）——报告经 control 返回面（cr-1129 批4：TSV 信号退役）', async () => {
    const signals: string[] = [];
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'kilo', catalogFile: CATALOG, mockProvider: true },
    );
    try {
      const report = await boot.control({
        ctrl: 'bench', suite: 'bfcl',
        options: { model: 'bench-mock-model', provider: 'bench-mock', scripted: true, limit: 2 },
      }) as { total: number; passed: number };
      expect(report.total).toBeGreaterThan(0);
      expect(report.passed).toBe(report.total);
    } finally { await boot.close(); }
  }, 30_000);

  it('preview：system-prompt 干跑（config.system 直过）+ assembly-tools 目录', async () => {
    seed('kilo', { rows: { include: ['math'] }, settings: { persona: { text: '我是 kilo' } } });
    // cr-1121：壳 boot 静态面 = 宿主写契约缓存（无宿主进程的测试形态直投）
    fs.mkdirSync(path.join(ROOT, 'meta'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'meta', 'host-face-contract.json'), JSON.stringify({
      version: 1,
      tools: [{ name: 'timer', description: 'd', parameters: { type: 'object' } }, { name: 'update_agent_profile', description: 'd', parameters: { type: 'object' } }],
      sections: [{ name: 'GUIDELINES_TIMER', text: 't', promise: true, gate: { toolsAny: ['timer'] } }],
      facts: [],
    }), 'utf-8');
    const signals: string[] = [];
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'kilo', catalogFile: CATALOG, mockProvider: true },
    );
    try {
      const sys = await boot.control({ ctrl: 'preview', what: 'system-prompt' }) as { systemPrompt: string };
      expect(sys.systemPrompt).toContain('我是 kilo');
      const asm = await boot.control({ ctrl: 'preview', what: 'assembly-tools' }) as { tools: Array<{ name: string }>; enabled: string[] };
      // cr-1114 批1：骨架行（host-face-client）静态面工具不再被 include 白名单
      // 滤除（cr-1007 滤除语义退役——cr-1121 起数据源 = 宿主写契约缓存）。
      // 点名行 math 照旧在面。
      expect(asm.enabled).toContain('math');
      expect(asm.enabled).toContain('timer');
      expect(asm.enabled).toContain('update_agent_profile');
      expect(asm.tools.length).toBeGreaterThan(0);
    } finally { await boot.close(); }
  }, 30_000);

  it('bench 缺行集：fail-loud（bench 服务缺席）', async () => {
    seed('kilo', { rows: { include: ['math'] } }); // 点名不含 bench——不进即不装
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'kilo', catalogFile: CATALOG, mockProvider: true },
    );
    try {
      await expect(boot.control({ ctrl: 'bench', suite: 'bfcl', options: { model: 'x', provider: 'y', scripted: true, limit: 1 } }))
        .rejects.toThrow(/bench 服务缺席/);
    } finally { await boot.close(); }
  }, 30_000);
  it('manage 帧：socket 通道答控制帧（控制面不绑 spawn 所有权——cr-675）', async () => {
    seed('kilo', { rows: { include: ['math'] }, settings: { persona: { text: '我是 kilo' } } });
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'kilo', catalogFile: CATALOG, mockProvider: true },
    );
    const client = new IpcClient();
    try {
      await client.connect(boot.transportHint);
      // manage 帧即唯一控制面入口（cr-1129 批4：stdin 帧对退役）：preview 干跑照常答
      const reply = await client.request(
        makeManageRequest('m1', { ctrl: 'preview', what: 'system-prompt' }),
        (f) => isManageReply(f, 'm1'),
      ) as ManageReply;
      expect(reply.manage.ok).toBe(true);
      expect((reply.manage.value as { systemPrompt: string }).systemPrompt).toContain('我是 kilo');
      // 壳侧抛错 → ok:false + 可读拒因（不留悬空回执）
      const bad = await client.request(
        makeManageRequest('m2', { ctrl: 'bench', suite: 'bfcl', options: {} }),
        (f) => isManageReply(f, 'm2'),
      ) as ManageReply;
      expect(bad.manage.ok).toBe(false);
      expect(bad.manage.error).toContain('bench 服务缺席');
    } finally {
      client.close();
      await boot.close();
    }
  }, 30_000);

  it('system/shutdown 帧（换代接管）：回执 ok 后触发 onShutdown（cr-1129 批4 起唯一优雅关停面）', async () => {
    seed('kilo', { rows: { include: ['math'] }, settings: { persona: { text: '我是 kilo' } } });
    let shutdownCalls = 0;
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'kilo', catalogFile: CATALOG, mockProvider: true },
      { onShutdown: () => { shutdownCalls += 1; } },
    );
    const client = new IpcClient();
    try {
      await client.connect(boot.transportHint);
      const reply = await client.request(
        makeManageRequest('m3', { ctrl: 'system', op: 'shutdown' }),
        (f) => isManageReply(f, 'm3'),
      ) as ManageReply;
      expect(reply.manage.ok).toBe(true);
      expect(shutdownCalls).toBe(1);
      // 无 onShutdown 面时 fail-loud（ok:false 可读拒因）
      seed('mini');
      const boot2 = await bootShell(
        { dataRoot: ROOT, agentId: 'mini', catalogFile: CATALOG, mockProvider: true },
        );
      try {
        const c2 = new IpcClient();
        await c2.connect(boot2.transportHint);
        const bad = await c2.request(
          makeManageRequest('m4', { ctrl: 'system', op: 'shutdown' }),
          (f) => isManageReply(f, 'm4'),
        ) as ManageReply;
        expect(bad.manage.ok).toBe(false);
        expect(bad.manage.error).toContain('system 帧无面');
        c2.close();
      } finally {
        await boot2.close();
      }
    } finally {
      client.close();
      await boot.close();
    }
  }, 30_000);
});

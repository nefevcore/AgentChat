// ============================================================
// ac-skill/tests/workspace-anchor.test.ts —— cr-865
//   子 Agent 工作区技能可见性：workspaceOf 挂载 miss 时回落
//   settings.security.workdir 锚点（spawn 快照层——子会话键是
//   agent⇄agent 对桶，singles 记录结构上到不了，cr-758 同因）。
//   层序与 sandboxWorkdir 同源：挂载 > 显式 workdir > files/<id>。
//   另覆盖 load_skill 空目录错误信息的三源空态提示。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as llmRow from 'ac-llm';
import * as agentLoopRow from 'ac-agent-loop';
import * as skillRow from '../src/index.ts';

class WorkspaceStub extends Service {
  constructor(c: Context, private miss: boolean) { super(c, 'workspace'); tmps.push(this.dataDir); }
  conversationWorkspaceRoot(_cid: string): string | null { return this.miss ? null : this.mounted; }
  agentWorkdir(_agentId?: string): string { return this.dataDir; }
  private mounted = '';
  private dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr865-files-'));
  mount(p: string): void { this.mounted = p; }
}

class AgentsStub extends Service {
  constructor(c: Context, private security: unknown) { super(c, 'agents'); }
  settingsOf(_id: string, name?: string): unknown { return name === 'security' ? this.security : undefined; }
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const tmps: string[] = [];
function trackTmp(dir: string): string { tmps.push(dir); return dir; }

function tmpDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr865-' + tag + '-'));
  tmps.push(dir);
  return dir;
}

function mkSkill(root: string, name: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + name + ' 测试技能\n---\n正文', 'utf-8');
}

async function boot(opts: { mounted: string | null; security?: unknown }) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  // Service 实例不能直接 plugin()（invalid plugin）——effect 工厂插件现建实例
  // （effect 返回值须为空/dispose，fiber 不回传）
  const wsRow = (mounted: string | null) => (c: Context) => {
    c.plugin(class extends WorkspaceStub { constructor(cc: Context) { super(cc, mounted === null); if (mounted !== null) this.mount(mounted); } });
  };
  const agentsRowStub = (security: unknown) => (c: Context) => {
    c.plugin(class extends AgentsStub { constructor(cc: Context) { super(cc, security); } });
  };
  for (const [plugin, config] of [
    [toolsRow, undefined],
    [llmRow, undefined],
    [agentLoopRow, undefined], // cr-881：skill 行段注册面 inject ['agentLoop']
    [wsRow(opts.mounted), undefined],
    [agentsRowStub(opts.security ?? {}), undefined],
    [skillRow, { root: tmpDir('data') }],
  ] as Array<[unknown, unknown]>) {
    const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('cr-865 workdir 锚点回落（子 Agent 工作区技能可见性）', () => {
  it('挂载 miss + workdir 锚点在场 → 工作区组扫锚点目录（子 Agent 继承父挂载工作区技能）', async () => {
    const ws = tmpDir('ws');
    mkSkill(path.join(ws, '.dsh', 'skills'), 'agentchat-dev');
    const { ctx } = await boot({ mounted: null, security: { workdir: ws } });
    const view = ctx.skills.listForAgent('sub-x', 'parent~sub-x');
    expect(view.workspace.map((g) => g.skills.map((s) => s.name))).toEqual([['agentchat-dev']]);
  });

  it('挂载 miss + 无锚点（常规 singles 未挂载）→ 工作区组保持为空', async () => {
    const { ctx } = await boot({ mounted: null, security: {} });
    const view = ctx.skills.listForAgent('sub-x', 'parent~sub-x');
    expect(view.workspace).toEqual([]);
  });

  it('挂载命中 → 锚点不参与（挂载 > 锚点，同 sandboxWorkdir 层序）', async () => {
    const mounted = tmpDir('mounted');
    mkSkill(path.join(mounted, '.dsh', 'skills'), 'mounted-skill');
    const { ctx } = await boot({ mounted, security: { workdir: '/nowhere-should-be-used' } });
    const view = ctx.skills.listForAgent('sub-x', 'parent~sub-x');
    expect(view.workspace.map((g) => g.skills.map((s) => s.name))).toEqual([['mounted-skill']]);
  });

  it('load_skill 三源皆空 → 错误信息含三源空态提示（不再是裸「不存在」）', async () => {
    const { ctx } = await boot({ mounted: null, security: {} });
    let err = '';
    try { ctx.skills['loadSkill']('agentchat-dev', 'sub-x', 'parent~sub-x'); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    expect(err).toContain('三源均空');
  });
});

// ============================================================
// ac-skill/tests/inject-dedup.test.ts —— cr-1103
//   跨 run 去重命中 v2 inject 行形态：壳内技能落账实际是 inject 事件
//   （injectSource='skill'），recordedSkillContexts 经 session.records()
//   统一读面（SessionShim → ledger.recordsFor 投影 source=injectSource）
//   扫描——已注入技能不再重复登记（此前 SessionShim 缺 records 恒返 []，
//   去重形同虚设，同技能可重复注入）。
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

/** 假 session（主线 records 消费面）：rows 内存列表 */
class FakeSession extends Service {
  rows = new Map<string, Array<{ role: string; source?: string; injectSource?: string; content: string; agent_id?: string }>>();
  recorded: string[] = [];
  constructor(ctx: Context) { super(ctx, 'session'); }
  async records(id: string) { return this.rows.get(id) ?? []; }
  recordContext(id: string, agentId: string, content: string, extra: { source: string; label?: string }) {
    this.recorded.push(extra.label ?? '');
    const list = this.rows.get(id) ?? [];
    list.push({ role: 'context', source: extra.source, content, agent_id: agentId });
    this.rows.set(id, list);
  }
}

class AgentsStub extends Service {
  constructor(ctx: Context) { super(ctx, 'agents'); }
  settingsOf(): undefined { return undefined; }
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr1103-'));
  tmps.push(dir);
  return dir;
}

function mkSkill(root: string, name: string): void {
  const dir = path.join(root, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + name + ' 测试技能\n---\n正文', 'utf-8');
}

async function boot() {
  const root = tmpRoot();
  mkSkill(root, 'demo-skill');
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, llmRow, agentLoopRow, AgentsStub, FakeSession, skillRow]) {
    const fiber = ctx.plugin(row as any, row === skillRow ? { root } : undefined);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx, session: ctx.get('session') as unknown as FakeSession };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) if (fiber.uid !== null) await fiber.dispose();
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 触发 load_skill 子调用登记链（tool/after-execute——async 监听器落定） */
async function fireLoadSkill(ctx: Context): Promise<void> {
  ctx.emit('tool/after-execute',
    { name: 'load_skill', agentId: 'a1', conversationId: 'u~a1', runId: 'run-1', toolCallId: 'tc1', runCodeSubcall: true },
    { ok: true, output: { name: 'demo-skill', scope: 'global', baseDir: 'x', status: 'injected' } });
  await new Promise((r) => setTimeout(r, 20));
}

/** pending 内已登记的技能名清单（claim 先行的空 Map 不算——数条目不数 Map） */
function pendingSkillsOf(ctx: Context): string[] {
  const pending = (ctx.get('skills') as unknown as { subcallPending: Map<string, Map<string, unknown>> }).subcallPending;
  return [...pending.values()].flatMap((m) => [...m.keys()].filter((k) => k !== '__recorded__'));
}

describe('ac-skill 跨 run 去重（cr-1103：records 读面覆盖 v2 inject 行）', () => {
  it('已注入技能在 inject 行形态在场 → 不再登记（去重命中）', async () => {
    const { ctx, session } = await boot();
    // 壳内现行落账形：inject 事件（injectSource='skill'）——读面投影后
    // source='skill'，content 仍带 <skill_content name=...> 包裹烘焙
    session.rows.set('u~a1', [{
      role: 'context', source: 'skill', injectSource: 'skill', agent_id: 'a1',
      content: '<system-reminder>已加载\n<skill_content name="demo-skill">\n正文\n</skill_content></system-reminder>',
    }]);
    await fireLoadSkill(ctx);
    // 去重命中：登记不进 pending（claim 先行留下的空 Map 不算——数技能条目）
    expect(pendingSkillsOf(ctx)).toEqual([]);
    expect(session.recorded).toHaveLength(0); // 无重复落账
  });

  it('无历史行 → 登记待注入（对照组：records 数据驱动去重）', async () => {
    const { ctx, session } = await boot();
    await fireLoadSkill(ctx);
    expect(pendingSkillsOf(ctx)).toEqual(['demo-skill']); // 未注入过 → 正常登记
    expect(session.recorded).toHaveLength(0); // 落账在 before-step 消费点，登记阶段不落
  });
});

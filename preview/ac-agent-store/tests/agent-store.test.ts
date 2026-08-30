// ============================================================
// ac-agent-store：AgentConfig 物化 / 机制 entries / 原子写 / 路径防护
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentStoreRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-agent-store-'));
  tmps.push(dir);
  return dir;
}

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot(root: string) {
  const ctx = new Context();
  const fiber = ctx.plugin(agentStoreRow as any, { root });
  await fiber;
  booted.push({ ctx, fibers: [fiber] });
  return ctx;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of fibers) if (fiber.uid !== null) await fiber.dispose();
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ac-agent-store：AgentConfig', () => {
  it('save/get/list 往返；目录名即 Agent id（无前缀魔法）', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    ctx.agentStore.saveAgent({
      id: 'helper',
      model: 'glm-5.3',
      system: '你是助手',
      settings: { persona: { text: '温柔' } },
    });
    expect(ctx.agentStore.getAgent('helper')).toEqual({
      id: 'helper',
      model: 'glm-5.3',
      system: '你是助手',
      settings: { persona: { text: '温柔' } },
    });
    expect(ctx.agentStore.agentIds()).toEqual(['helper']);
    expect(fs.existsSync(path.join(root, 'agents', 'helper', 'config.json'))).toBe(true);
    // 原子写不留临时文件
    expect(fs.readdirSync(path.join(root, 'agents', 'helper'))).toEqual(['config.json']);
  });

  it('重启回读（持久化）；listAgents 只含 config 可解析者', async () => {
    const root = tmpRoot();
    const ctx1 = await boot(root);
    ctx1.agentStore.saveAgent({ id: 'helper', model: 'glm-5.3' });
    const ctx2 = await boot(root);
    expect(ctx2.agentStore.listAgents().map((c) => c.id)).toEqual(['helper']);

    // 损坏 config：agentIds 列出（诊断）但 listAgents 剔除
    fs.writeFileSync(
      path.join(root, 'agents', 'helper', 'config.json'),
      '{broken',
      'utf-8',
    );
    const ctx3 = await boot(root);
    expect(ctx3.agentStore.agentIds()).toEqual(['helper']);
    expect(ctx3.agentStore.listAgents()).toEqual([]);
    expect(ctx3.agentStore.getAgent('helper')).toBeUndefined();
  });

  it('removeAgent 删目录；remove 不存在的 → false', async () => {
    const ctx = await boot(tmpRoot());
    ctx.agentStore.saveAgent({ id: 'a', model: 'm' });
    ctx.agentStore.saveEntry('a', 'timer', [{ cron: '* * * * *' }]);
    expect(ctx.agentStore.removeAgent('a')).toBe(true);
    expect(ctx.agentStore.getAgent('a')).toBeUndefined();
    expect(ctx.agentStore.removeAgent('a')).toBe(false);
  });
});

describe('ac-agent-store：机制 entries（唯一写口）', () => {
  it('saveEntry/readEntry/entryKeys/removeEntry 往返', async () => {
    const ctx = await boot(tmpRoot());
    ctx.agentStore.saveAgent({ id: 'a', model: 'm' });
    const timers = [{ id: 't1', cron: '0 9 * * *', hint: '早报' }];
    ctx.agentStore.saveEntry('a', 'timer', timers);
    expect(ctx.agentStore.readEntry<typeof timers>('a', 'timer')).toEqual(timers);
    expect(ctx.agentStore.entryKeys('a')).toEqual(['timer']);
    expect(ctx.agentStore.removeEntry('a', 'timer')).toBe(true);
    expect(ctx.agentStore.readEntry('a', 'timer')).toBeUndefined();
  });

  it('entry key 校验：param-case 之外的 key 抛错（防路径注入）', async () => {
    const ctx = await boot(tmpRoot());
    expect(() => ctx.agentStore.saveEntry('a', '../evil', {})).toThrow(/非法/);
    expect(() => ctx.agentStore.saveEntry('a', 'UpCase', {})).toThrow(/非法/);
    expect(() => ctx.agentStore.saveEntry('a', 'has/slash', {})).toThrow(/非法/);
  });

  it('agent id 校验：路径分隔/遍历字符抛错', async () => {
    const ctx = await boot(tmpRoot());
    expect(() => ctx.agentStore.saveAgent({ id: '../evil', model: 'm' })).toThrow(/非法/);
    expect(() => ctx.agentStore.saveAgent({ id: 'a/b', model: 'm' })).toThrow(/非法/);
    expect(() => ctx.agentStore.agentDir('a~b')).toThrow(/非法/);
  });
});

describe('ac-agent-store：文档（AGENT.md 等，M14 唯一写口）', () => {
  it('saveDoc/readDoc/removeDoc 往返；内容原样（frontmatter 归消费侧剥离）', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    ctx.agentStore.saveAgent({ id: 'a', model: 'm' });
    ctx.agentStore.saveDoc('a', 'AGENT.md', '---\ntitle: x\n---\n\n人设正文');
    expect(ctx.agentStore.readDoc('a', 'AGENT.md')).toBe('---\ntitle: x\n---\n\n人设正文\n');
    // 原子写不留临时文件；与 config.json 共存
    expect(fs.readdirSync(path.join(root, 'agents', 'a')).sort()).toEqual(['AGENT.md', 'config.json']);
    expect(ctx.agentStore.removeDoc('a', 'AGENT.md')).toBe(true);
    expect(ctx.agentStore.readDoc('a', 'AGENT.md')).toBeUndefined();
    expect(ctx.agentStore.removeDoc('a', 'AGENT.md')).toBe(false);
  });

  it('文档名校验：非单词 .md 文件名抛错（防路径注入）', async () => {
    const ctx = await boot(tmpRoot());
    expect(() => ctx.agentStore.saveDoc('a', '../evil.md', 'x')).toThrow(/非法/);
    expect(() => ctx.agentStore.saveDoc('a', 'sub/AGENT.md', 'x')).toThrow(/非法/);
    expect(() => ctx.agentStore.saveDoc('a', 'config.json', 'x')).toThrow(/非法/);
    expect(() => ctx.agentStore.readDoc('a', 'noext')).toThrow(/非法/);
  });
});

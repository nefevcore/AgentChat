// ============================================================
// ac-agent-store/tests/migrate-hooks.test.ts —— M24 X1 双读归一 + 存量迁移
//   · 双读归一（唯一落点 = getAgent）：旧 hooks 键读取时归一 settings；
//     两者同给新键优先；saveAgent 只写新键（旧键只读不写）
//   · migrateAgentConfig 恒等门：改名 / 双给新键优先 / 无旧键幂等
//   · 端到端：盘上旧键档案 → 保存回写后盘上只余新键
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import { AgentStoreService } from '../src/service.ts';
import { migrateAgentConfig } from '../../scripts/migrate-hooks-to-settings.ts';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];
const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-store-mig-'));
  tmps.push(dir);
  return dir;
}

async function boot(root: string) {
  const ctx = new Context();
  const fiber = ctx.plugin(AgentStoreService, { root });
  await fiber;
  booted.push({ ctx, fibers: [fiber] });
  return { ctx };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of fibers.reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('agent-store 双读归一（M24 X1 store 加载边界）', () => {
  it('旧 hooks 键读取时归一为 settings（类型层之下）', async () => {
    const root = tmpRoot();
    const dir = path.join(root, 'agents', 'legacy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ id: 'legacy', model: 'm', hooks: { persona: { text: '旧档案' } } }, null, 2),
      'utf-8',
    );
    const { ctx } = await boot(root);
    expect(ctx.agentStore.getAgent('legacy')).toEqual({
      id: 'legacy',
      model: 'm',
      settings: { persona: { text: '旧档案' } },
    });
  });

  it('新旧同给：新键优先（settings 在场时旧键丢弃）', async () => {
    const root = tmpRoot();
    const dir = path.join(root, 'agents', 'both');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        id: 'both',
        model: 'm',
        hooks: { persona: { text: '旧' } },
        settings: { persona: { text: '新' } },
      }, null, 2),
      'utf-8',
    );
    const { ctx } = await boot(root);
    expect(ctx.agentStore.getAgent('both')?.settings).toEqual({ persona: { text: '新' } });
    // 新档案无 hooks 键：原样直通
    expect('hooks' in (ctx.agentStore.getAgent('both') as object)).toBe(false);
  });

  it('旧键只读不写：saveAgent 回写后盘上只余新键（双读归一自然退役）', async () => {
    const root = tmpRoot();
    const dir = path.join(root, 'agents', 'rw');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ id: 'rw', model: 'm', hooks: { memory: { maxTokens: 10 } } }, null, 2),
      'utf-8',
    );
    const { ctx } = await boot(root);
    const config = ctx.agentStore.getAgent('rw')!;
    expect(config.settings).toEqual({ memory: { maxTokens: 10 } });
    ctx.agentStore.saveAgent(config);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(onDisk.hooks).toBeUndefined();
    expect(onDisk.settings).toEqual({ memory: { maxTokens: 10 } });
  });
});

describe('migrate-hooks-to-settings 恒等门（纯函数）', () => {
  it('改名：hooks → settings（键位保持）', () => {
    const { config, changed } = migrateAgentConfig({ id: 'a', model: 'm', hooks: { persona: 'X' }, tags: ['dev'] });
    expect(changed).toBe(true);
    expect(Object.keys(config)).toEqual(['id', 'model', 'settings', 'tags']);
    expect(config.settings).toEqual({ persona: 'X' });
  });

  it('双给：新键优先', () => {
    const { config } = migrateAgentConfig({
      id: 'a',
      hooks: { persona: '旧' },
      settings: { persona: '新' },
    });
    expect(config.settings).toEqual({ persona: '新' });
  });

  it('幂等：无旧键不动（原引用返回）', () => {
    const raw = { id: 'a', settings: { persona: 'X' } };
    const { config, changed } = migrateAgentConfig(raw);
    expect(changed).toBe(false);
    expect(config).toBe(raw);
  });

  it('幂等重入：迁移后再迁 = 零变更', () => {
    const first = migrateAgentConfig({ id: 'a', hooks: { memory: { maxTokens: 1 } } });
    const second = migrateAgentConfig(first.config);
    expect(second.changed).toBe(false);
    expect(second.config).toBe(first.config);
  });
});

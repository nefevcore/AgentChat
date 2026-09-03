// ============================================================
// ac-conv-settings 测试：get/set/clear 覆盖语义 · 原子写 · 事件 ·
// conversationId 词法校验 · 键删除落删文件
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as convSettingsRow from '../src/index.ts';

const tmps: string[] = [];
const booted: { ctx: Context; fiber: Fiber }[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-conv-settings-'));
  tmps.push(dir);
  return dir;
}

async function boot(root: string) {
  const ctx = new Context();
  const fiber = ctx.plugin(convSettingsRow as any, { root });
  await fiber;
  booted.push({ ctx, fiber });
  return ctx;
}

afterEach(async () => {
  for (const { fiber } of booted.splice(0)) {
    if (fiber.uid !== null) await fiber.dispose();
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ac-conv-settings', () => {
  it('get/set/clear：键级覆盖（null=删键）、文件名即 conversationId、原子写', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    // 无覆盖 → 空对象
    expect(ctx.convSettings.get('user~helper')).toEqual({});
    // set：name@model 引用原样存
    const next = ctx.convSettings.set('user~helper', { model: 'deepseek@deepseek-v4-pro' });
    expect(next).toEqual({ model: 'deepseek@deepseek-v4-pro' });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'conv-settings', 'user~helper.json'), 'utf-8'))).toEqual({
      model: 'deepseek@deepseek-v4-pro',
    });
    // get 回读
    expect(ctx.convSettings.get('user~helper')).toEqual({ model: 'deepseek@deepseek-v4-pro' });
    // 盘上无 .tmp 残留（原子写）
    expect(fs.readdirSync(path.join(root, 'conv-settings')).filter((f) => f.includes('.tmp'))).toEqual([]);
    // null = 删键 → 全空 = 删文件
    ctx.convSettings.set('user~helper', { model: null });
    expect(fs.existsSync(path.join(root, 'conv-settings', 'user~helper.json'))).toBe(false);
    expect(ctx.convSettings.get('user~helper')).toEqual({});
  });

  it('conv-settings/updated 事件：set/cleared 终态载荷', async () => {
    const ctx = await boot(tmpRoot());
    const seen: Array<[string, { model?: string }, string]> = [];
    ctx.on('conv-settings/updated', (id, settings, change) => seen.push([id, settings, change]));
    ctx.convSettings.set('room-1', { model: 'glm@glm-5.3' });
    ctx.convSettings.set('room-1', { model: null });
    expect(seen).toEqual([
      ['room-1', { model: 'glm@glm-5.3' }, 'set'],
      ['room-1', {}, 'cleared'],
    ]);
  });

  it('clear：幂等（无文件不 emit）', async () => {
    const ctx = await boot(tmpRoot());
    const events: string[] = [];
    ctx.on('conv-settings/updated', (_id, _s, change) => events.push(change));
    ctx.convSettings.clear('user~helper'); // 无文件：静默
    ctx.convSettings.set('user~helper', { model: 'm-1' });
    ctx.convSettings.clear('user~helper');
    expect(events).toEqual(['set', 'cleared']);
    expect(ctx.convSettings.get('user~helper')).toEqual({});
  });

  it('conversationId 词法校验：路径分隔/../空白 拒绝（对桶 ~ 合法）', async () => {
    const ctx = await boot(tmpRoot());
    expect(() => ctx.convSettings.get('a/b')).toThrow(/非法/);
    expect(() => ctx.convSettings.get('a..b')).toThrow(/非法/);
    expect(() => ctx.convSettings.get('a b')).toThrow(/非法/);
    expect(() => ctx.convSettings.get('')).toThrow(/非法/);
    expect(() => ctx.convSettings.set('../escape', { model: 'm' })).toThrow(/非法/);
    // 未知键忽略（wire 宽容）
    expect(ctx.convSettings.set('a~b', { effort: 'high' } as never)).toEqual({});
  });
});

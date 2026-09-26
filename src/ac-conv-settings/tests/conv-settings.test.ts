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

describe('ac-conv-settings 注册制扩展键（生态行贡献会话覆盖键的正路）', () => {
  it('registerKey：枚举键写入/回读/删键全链；撞名 fail-loud；未注册键静默清', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    // 生态行注册（模拟插件行 apply 里的注册）
    ctx.convSettings.registerKey({ key: 'pluginMode', enum: ['pm-a', 'pm-b'], description: '某插件模式' });
    const next = ctx.convSettings.set('user~helper', { pluginMode: 'pm-a' });
    expect(next).toMatchObject({ pluginMode: 'pm-a' });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'conv-settings', 'user~helper.json'), 'utf-8'))).toMatchObject({ pluginMode: 'pm-a' });
    // 非法枚举 → 清除
    expect(ctx.convSettings.set('user~helper', { pluginMode: 'pm-x' })).toEqual({});
    // null 删键
    ctx.convSettings.set('user~helper', { pluginMode: 'pm-b' });
    expect(ctx.convSettings.set('user~helper', { pluginMode: null })).toEqual({});
    // 撞名 fail-loud
    expect(() => ctx.convSettings.registerKey({ key: 'toolMode', enum: ['x'] })).toThrow(/已注册/);
    // 未注册键静默清（RPC 泛透传后的兜底）
    expect(ctx.convSettings.set('user~helper', { unknownKey: 'v' })).toEqual({});
    // 键目录
    expect(ctx.convSettings.listKeys().some((k) => k.key === 'pluginMode')).toBe(true);
  });

  it('注册即归属：注册方卸载 → 键回收（新值不进；存量值宽松可读）', async () => {
    const root = tmpRoot();
    const ctx = new Context();
    const fiber = ctx.plugin(convSettingsRow as any, { root });
    await fiber;
    booted.push({ ctx, fiber });
    // 模拟生态行：独立 fiber 里注册键
    const pluginFiber = ctx.plugin({
      name: 'test-plugin-row',
      inject: ['convSettings'],
      apply(c: Context) {
        (c as unknown as { convSettings: { registerKey(def: { key: string; enum: string[] }): void } }).convSettings
          .registerKey({ key: 'pluginMode', enum: ['pm-a'] });
      },
    } as any);
    await pluginFiber;
    ctx.convSettings.set('user~helper', { pluginMode: 'pm-a' });
    expect(ctx.convSettings.get('user~helper')).toMatchObject({ pluginMode: 'pm-a' });
    // 卸载生态行 → 键回收：新写入不进
    await pluginFiber.dispose();
    expect(ctx.convSettings.set('user~helper', { pluginMode: 'pm-a' })).toEqual({});
    // 存量落盘值宽松可读（消费方不炸；重 boot 后同样宽松）
    expect(ctx.convSettings.get('user~helper')).toEqual({}); // 枚举回收后回读校验也清——见 readSettings 注释
  });
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

  it(`toolMode 键（工具调用模式覆盖，tc-* 标签轴）：合法枚举写/读、其余清、盘上损坏值丢弃`, async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    expect(ctx.convSettings.get('user~helper')).toEqual({});
    // 合法枚举（wire 字符串原样）→ 持久同值
    let next = ctx.convSettings.set('user~helper', { toolMode: 'tc-programmatic' });
    expect(next).toEqual({ toolMode: 'tc-programmatic' });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'conv-settings', 'user~helper.json'), 'utf-8'))).toEqual({
      toolMode: 'tc-programmatic',
    });
    expect(ctx.convSettings.get('user~helper').toolMode).toBe('tc-programmatic');
    // 三值都可写入
    ctx.convSettings.set('user~helper', { toolMode: 'tc-none' });
    expect(ctx.convSettings.get('user~helper').toolMode).toBe('tc-none');
    ctx.convSettings.set('user~helper', { toolMode: 'tc-base' });
    expect(ctx.convSettings.get('user~helper').toolMode).toBe('tc-base');
    // 非法值（'tc-foo'/'false'/null）→ 删键（全空 = 删文件）
    next = ctx.convSettings.set('user~helper', { toolMode: 'tc-foo' as never });
    expect(next).toEqual({});
    expect(fs.existsSync(path.join(root, 'conv-settings', 'user~helper.json'))).toBe(false);
    // 与 model/elevation 共存（键级独立）
    ctx.convSettings.set('user~helper', { model: 'glm@glm-5.3', toolMode: 'tc-none' });
    expect(ctx.convSettings.get('user~helper')).toEqual({ model: 'glm@glm-5.3', toolMode: 'tc-none' });
    // 盘上损坏值（toolMode: 'programmatic'——旧开关词不迁移，读侧丢弃）→ 宽容面
    fs.writeFileSync(
      path.join(root, 'conv-settings', 'bad.json'),
      JSON.stringify({ toolMode: 'programmatic' }),
      'utf-8',
    );
    expect(ctx.convSettings.get('bad')).toEqual({});
    // 盘上旧 programmatic 布尔键（存量不迁移）→ 读侧直接失效（不映射）
    fs.writeFileSync(
      path.join(root, 'conv-settings', 'legacy.json'),
      JSON.stringify({ programmatic: true }),
      'utf-8',
    );
    expect(ctx.convSettings.get('legacy')).toEqual({});
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

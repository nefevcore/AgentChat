// ============================================================
// ac-conv-settings 测试：get/set 覆盖语义 · 原子写 · 事件 ·
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
    expect(JSON.parse(fs.readFileSync(path.join(root, 'meta', 'conv-settings', 'user~helper.json'), 'utf-8'))).toMatchObject({ pluginMode: 'pm-a' });
    // cr-1091 键域校验退役：非法枚举值也原样落盘（落盘即真相——垃圾值由
    // 消费方天然回落兜底）
    expect(ctx.convSettings.set('user~helper', { pluginMode: 'pm-x' })).toEqual({ pluginMode: 'pm-x' });
    // null 删键
    ctx.convSettings.set('user~helper', { pluginMode: 'pm-b' });
    expect(ctx.convSettings.set('user~helper', { pluginMode: null })).toEqual({});
    // 撞名 fail-loud
    expect(() => ctx.convSettings.registerKey({ key: 'toolMode', enum: ['x'] })).toThrow(/已注册/);
    // 未注册键字符串值同样落盘（wire 宽容——消费方直读不命中即回落）
    expect(ctx.convSettings.set('user~helper', { unknownKey: 'v' })).toEqual({ unknownKey: 'v' });
    ctx.convSettings.set('user~helper', { unknownKey: null });
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
    // 卸载生态行 → 键回收：键目录不再含该键（UI/治理面消失）
    await pluginFiber.dispose();
    expect(ctx.convSettings.listKeys().some((k) => k.key === 'pluginMode')).toBe(false);
    // cr-1091 落盘即真相：已落盘值保留不清理——消费方不炸、天然回落兜底
    expect(ctx.convSettings.get('user~helper')).toEqual({ pluginMode: 'pm-a' });
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
    expect(JSON.parse(fs.readFileSync(path.join(root, 'meta', 'conv-settings', 'user~helper.json'), 'utf-8'))).toEqual({
      model: 'deepseek@deepseek-v4-pro',
    });
    // get 回读
    expect(ctx.convSettings.get('user~helper')).toEqual({ model: 'deepseek@deepseek-v4-pro' });
    // 盘上无 .tmp 残留（原子写）
    expect(fs.readdirSync(path.join(root, 'meta', 'conv-settings')).filter((f) => f.includes('.tmp'))).toEqual([]);
    // null = 删键 → 全空 = 删文件
    ctx.convSettings.set('user~helper', { model: null });
    expect(fs.existsSync(path.join(root, 'meta', 'conv-settings', 'user~helper.json'))).toBe(false);
    expect(ctx.convSettings.get('user~helper')).toEqual({});
  });

  it('conv-settings/updated 事件：set/cleared 终态载荷', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    const seen: Array<[string, { model?: string }, string]> = [];
    ctx.on('conv-settings/updated', (id, settings, change) => seen.push([id, settings, change]));
    ctx.convSettings.set('room-1', { model: 'glm@glm-5.3' });
    ctx.convSettings.set('room-1', { model: null }); // 全空 = 删文件 → cleared（clear() 收口后唯一入口）
    expect(seen).toEqual([
      ['room-1', { model: 'glm@glm-5.3' }, 'set'],
      ['room-1', {}, 'cleared'],
    ]);
    expect(fs.existsSync(path.join(root, 'meta', 'conv-settings', 'room-1.json'))).toBe(false);
  });

  it(`toolMode 键（工具调用模式覆盖，tc-* 标签轴）：合法枚举写/读、其余清、盘上损坏值丢弃`, async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    expect(ctx.convSettings.get('user~helper')).toEqual({});
    // 合法枚举（wire 字符串原样）→ 持久同值
    let next = ctx.convSettings.set('user~helper', { toolMode: 'tc-programmatic' });
    expect(next).toEqual({ toolMode: 'tc-programmatic' });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'meta', 'conv-settings', 'user~helper.json'), 'utf-8'))).toEqual({
      toolMode: 'tc-programmatic',
    });
    expect(ctx.convSettings.get('user~helper').toolMode).toBe('tc-programmatic');
    // 三值都可写入
    ctx.convSettings.set('user~helper', { toolMode: 'tc-none' });
    expect(ctx.convSettings.get('user~helper').toolMode).toBe('tc-none');
    ctx.convSettings.set('user~helper', { toolMode: 'tc-base' });
    expect(ctx.convSettings.get('user~helper').toolMode).toBe('tc-base');
    // 开放词（cr-1049）：tc- 前缀词合法（'tc-foo' 持久；注册表校验在投影端
    // 兜底——未注册词回退常规面 + warn）；'false'/null → 删键（cr-1091
    // 起字符串值一律落盘，删键只剩 null 显式语义）
    next = ctx.convSettings.set('user~helper', { toolMode: 'tc-foo' });
    expect(next).toEqual({ toolMode: 'tc-foo' });
    next = ctx.convSettings.set('user~helper', { toolMode: 'false' as never });
    expect(next).toEqual({ toolMode: 'false' });
    ctx.convSettings.set('user~helper', { toolMode: null });
    // 与 model/access 共存（键级独立）
    ctx.convSettings.set('user~helper', { model: 'glm@glm-5.3', toolMode: 'tc-none' });
    expect(ctx.convSettings.get('user~helper')).toEqual({ model: 'glm@glm-5.3', toolMode: 'tc-none' });
    // 盘上损坏值（toolMode: 'programmatic'——旧开关词不迁移）：cr-1091
    // 落盘即真相——原样透出，消费方（投影端）不命中即回落
    fs.writeFileSync(
      path.join(root, 'meta', 'conv-settings', 'bad.json'),
      JSON.stringify({ toolMode: 'programmatic' }),
      'utf-8',
    );
    expect(ctx.convSettings.get('bad')).toEqual({ toolMode: 'programmatic' });
    // 盘上非字符串值（布尔/数字）仍被类型闸滤除（文件损坏防护，非键域校验）
    fs.writeFileSync(
      path.join(root, 'meta', 'conv-settings', 'legacy.json'),
      JSON.stringify({ programmatic: true }),
      'utf-8',
    );
    expect(ctx.convSettings.get('legacy')).toEqual({});
  });

  it('access 键已退役（cr-1082）：盘上存量值原样透出、无人消费（cr-1091 落盘即真相）', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    // 盘上存量值（access/elevation 旧形态）原样透出——退役键零消费方，透出
    // 即无效；物理删除由 cr-1082 清理脚本负责（键域校验已退役不再读侧清）
    fs.mkdirSync(path.join(root, 'meta', 'conv-settings'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'meta', 'conv-settings', 'legacy-elev.json'),
      JSON.stringify({ elevation: 'full-access', access: 'full-access' }),
      'utf-8',
    );
    expect(ctx.convSettings.get('legacy-elev')).toEqual({ elevation: 'full-access', access: 'full-access' });
  });

  it('迁居兼容窗：旧位置 <root>/conv-settings/<id>.json 可读；清除删双位置', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    // 旧位置存量（寄居期文件）
    fs.mkdirSync(path.join(root, 'conv-settings'), { recursive: true });
    fs.writeFileSync(path.join(root, 'conv-settings', 'legacy~user.json'), JSON.stringify({ model: 'glm@glm-5.3' }), 'utf-8');
    expect(ctx.convSettings.get('legacy~user')).toEqual({ model: 'glm@glm-5.3' });
    // 写侧升级到新位置（旧文件不动）
    ctx.convSettings.set('legacy~user', { model: 'deepseek@deepseek-flash' });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'meta', 'conv-settings', 'legacy~user.json'), 'utf-8')))
      .toEqual({ model: 'deepseek@deepseek-flash' });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'conv-settings', 'legacy~user.json'), 'utf-8')))
      .toEqual({ model: 'glm@glm-5.3' });
    // 新位置在场恒胜出（旧位置不复活）
    expect(ctx.convSettings.get('legacy~user')).toEqual({ model: 'deepseek@deepseek-flash' });
    // 全空删键：双位置一并清
    ctx.convSettings.set('legacy~user', { model: null });
    // 全空删键：双位置一并清（只清新位置会让旧文件复活旧值）
    expect(fs.existsSync(path.join(root, 'meta', 'conv-settings', 'legacy~user.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'conv-settings', 'legacy~user.json'))).toBe(false);
    expect(ctx.convSettings.get('legacy~user')).toEqual({});
  });

  it('conversationId 词法校验：路径分隔/../空白 拒绝（对桶 ~ 合法）', async () => {
    const ctx = await boot(tmpRoot());
    expect(() => ctx.convSettings.get('a/b')).toThrow(/非法/);
    expect(() => ctx.convSettings.get('a..b')).toThrow(/非法/);
    expect(() => ctx.convSettings.get('a b')).toThrow(/非法/);
    expect(() => ctx.convSettings.get('')).toThrow(/非法/);
    expect(() => ctx.convSettings.set('../escape', { model: 'm' })).toThrow(/非法/);
    // cr-1091 未知键字符串值落盘（wire 宽容；删键只剩 null 显式语义）
    expect(ctx.convSettings.set('a~b', { effort: 'high' } as never)).toEqual({ effort: 'high' });
    ctx.convSettings.set('a~b', { effort: null });
  });

  // cr-1083 conv-scope 批1 V1：决策面读取 effective——无人桶恒 {}，
  // 有人桶（a~user / singles sid）= get；get 保持原样（展示面读残留）。
  it('effective：无人桶（self/agent~agent/g~member）文件有残值也恒 {}；有人桶同 get', async () => {
    const ctx = await boot(tmpRoot());
    // 三类无人桶写残值（绕过 set 面直接落盘——模拟早期全树写入产物）
    for (const id of ['news~news', 'alice~bob', 'g-mthfaf3e-tmx1~news']) {
      ctx.convSettings.set(id, { toolMode: 'tc-none', browserTier: 'disabled', approval: 'allow', issueSubmit: 'disabled' });
    }
    ctx.convSettings.set('a~user', { toolMode: 'tc-none' });
    ctx.convSettings.set('sid-1234', { browserTier: 'observe' });
    // 决策面：无人桶恒 {}（Agent 侧配置接管）；有人桶原样
    expect(ctx.convSettings.effective('news~news')).toEqual({});
    expect(ctx.convSettings.effective('alice~bob')).toEqual({});
    expect(ctx.convSettings.effective('g-mthfaf3e-tmx1~news')).toEqual({});
    expect(ctx.convSettings.effective('a~user')).toEqual({ toolMode: 'tc-none' });
    expect(ctx.convSettings.effective('sid-1234')).toEqual({ browserTier: 'observe' });
    // 展示面：get 原样返回残留（读写分离）
    expect(ctx.convSettings.get('news~news').toolMode).toBe('tc-none');
  });
});

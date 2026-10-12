// ============================================================
// ac-agent-store：头像实体 + 盘面非法目录过滤（cr-353 补——原零覆盖）
//   · saveAvatar/avatarPath/removeAvatar 往返 + 扩展名归一小写
//     （.PNG 曾原样落盘而探测面只认小写——上传成功但头像不可见）
//   · agentIds 过滤非法词法目录名（~ 等——外部污染盘面不拖垮
//     listAgents/timer reload 遍历链，agents-dir「非法 id 告警跳过」
//     承诺由此成立）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentStoreRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-store-av-'));
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

describe('ac-agent-store：头像（M17-E 二进制实体）', () => {
  it('saveAvatar/avatarPath/removeAvatar 往返；换扩展名清理旧残留', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    ctx.agentStore.saveAgent({ id: 'a', model: 'm' });
    ctx.agentStore.saveAvatar('a', buf, '.png');
    expect(ctx.agentStore.avatarPath('a')).toBe(path.join(root, 'agents', 'a', 'avatar.png'));
    // 换 webp：旧 png 残留清理（探测面唯一）
    ctx.agentStore.saveAvatar('a', buf, '.webp');
    expect(ctx.agentStore.avatarPath('a')).toBe(path.join(root, 'agents', 'a', 'avatar.webp'));
    expect(fs.readdirSync(path.join(root, 'agents', 'a')).sort()).toEqual(['avatar.webp', 'config.json']);
    expect(ctx.agentStore.removeAvatar('a')).toBe(true);
    expect(ctx.agentStore.avatarPath('a')).toBeUndefined();
    expect(ctx.agentStore.removeAvatar('a')).toBe(false);
  });

  it('扩展名归一小写（.PNG/.JPEG → avatar.png/avatar.jpeg——cr-353 回归锁）', async () => {
    const root = tmpRoot();
    const ctx = await boot(root);
    ctx.agentStore.saveAgent({ id: 'a', model: 'm' });
    ctx.agentStore.saveAvatar('a', Buffer.from('x'), '.PNG');
    // 旧 bug：.PNG 原样落盘而 avatarPath 只探测小写——上传成功但头像不可见。
    // 落盘名以 readdir 实名为证（Windows 大小写不敏感，existsSync 无从分辨）
    expect(ctx.agentStore.avatarPath('a')).toBe(path.join(root, 'agents', 'a', 'avatar.png'));
    expect(fs.readdirSync(path.join(root, 'agents', 'a'))).toContain('avatar.png');
    ctx.agentStore.saveAvatar('a', Buffer.from('x'), '.JPEG');
    expect(ctx.agentStore.avatarPath('a')).toBe(path.join(root, 'agents', 'a', 'avatar.jpeg'));
    expect(fs.readdirSync(path.join(root, 'agents', 'a'))).toEqual(['avatar.jpeg', 'config.json']);
  });

  it('未知扩展名回落 .png；空扩展名回落 .png', async () => {
    const ctx = await boot(tmpRoot());
    ctx.agentStore.saveAgent({ id: 'a', model: 'm' });
    ctx.agentStore.saveAvatar('a', Buffer.from('x'), '.bmp');
    expect(ctx.agentStore.avatarPath('a')).toBe(
      path.join(ctx.agentStore.agentDir('a'), 'avatar.png'),
    ); // .bmp 不在支持表 → 回落 .png 落盘，探测面可见
  });

  it('agent id 校验沿用：头像面同口（非法 id 抛错）', async () => {
    const ctx = await boot(tmpRoot());
    expect(() => ctx.agentStore.saveAvatar('../evil', Buffer.from('x'), '.png')).toThrow(/非法/);
  });
});

describe('ac-agent-store：盘面非法目录过滤', () => {
  it('agentIds 跳过非法词法目录名（~ 遍历/分隔符——污染盘面不炸穿遍历链）', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'agents', 'evil~pair'), { recursive: true });
    fs.mkdirSync(path.join(root, 'agents', 'ok'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agents', 'ok', 'config.json'), JSON.stringify({ id: 'ok', model: 'm' }), 'utf-8');
    const ctx = await boot(root);
    expect(ctx.agentStore.agentIds()).toEqual(['ok']); // ~evil 过滤、ok 存活
    expect(ctx.agentStore.listAgents().map((c) => c.id)).toEqual(['ok']); // 遍历链整体不炸
  });

  it('getAgent 对非法 id 仍抛错（词法防线在 agentDir——过滤只影响目录枚举）', async () => {
    const ctx = await boot(tmpRoot());
    expect(() => ctx.agentStore.getAgent('evil~pair')).toThrow(/非法/);
  });
});

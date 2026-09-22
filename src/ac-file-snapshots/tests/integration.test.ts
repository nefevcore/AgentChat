// ============================================================
// ac-file-snapshots/tests/integration.test.ts —— 工具行 × 快照
// 服务集成验收（方案 C 挂点）
//
// 真实工具执行（fs-tools write/edit + str-replace-editor 三命令）
// 时快照服务收到 ensure：存量文件首编辑前内容入快照；同会话二写
// no-op；跨会话独立；无 conversationId（宿主直调）不触发。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as configRow from 'ac-config';
import * as fsToolsRow from 'ac-fs-tools';
import * as sreRow from 'ac-str-replace-editor';
import * as snapshotsRow from 'ac-file-snapshots';
import type { FileSnapshotsService } from 'ac-file-snapshots';

type ExecRes = { ok: boolean; output: any; error?: string };
async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-snapint-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot(root: string, snapRoot: string, snapOpts: Record<string, unknown> = {}) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: Array<[unknown, unknown]> = [
    [toolsRow, undefined],
    [configRow, { root }], // settings 层热更测试用（config.json 落临时根）
    [snapshotsRow, { root: snapRoot, ...snapOpts }],
    [fsToolsRow, { workdir: root }],
    [sreRow, { workdir: root }],
  ];
  for (const [plugin, config] of rows) {
    const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('方案 C 挂点 —— 工具写路径 × 快照服务', () => {
  it('edit 存量文件：首编辑前内容入快照；同会话再写 no-op', async () => {
    const root = tmpRoot();
    const snapRoot = path.join(root, 'snaps');
    const target = path.join(root, 'old.ts');
    fs.writeFileSync(target, 'before\n', 'utf-8');
    const { ctx } = await boot(root, snapRoot);

    const r = await exec(ctx, {
      name: 'edit',
      args: { file_path: 'old.ts', old_string: 'before', new_string: 'after' },
      conversationId: 'conv~1',
    });
    expect(r.ok).toBe(true);
    const svc = ctx.fileSnapshots as FileSnapshotsService;
    const snap = svc.get('conv~1', target);
    expect(snap?.content).toBe('before\n'); // 首编辑前的磁盘内容

    // 同会话第二次编辑——快照不变
    await exec(ctx, {
      name: 'edit',
      args: { file_path: 'old.ts', old_string: 'after', new_string: 'final' },
      conversationId: 'conv~1',
    });
    expect(svc.get('conv~1', target)?.content).toBe('before\n');
  });

  it('write 新建文件：首见不存在快照（content=null）；跨会话独立', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, path.join(root, 'snaps'));
    const svc = ctx.fileSnapshots as FileSnapshotsService;

    await exec(ctx, {
      name: 'write',
      args: { file_path: 'fresh.md', content: 'v1\n' },
      conversationId: 'conv~a',
    });
    const target = path.join(root, 'fresh.md');
    expect(svc.get('conv~a', target)?.content).toBe(null); // 首见不存在

    // 另一会话覆盖写——该会话首见 = v1 内容
    await exec(ctx, {
      name: 'write',
      args: { file_path: 'fresh.md', content: 'v2\n' },
      conversationId: 'conv~b',
    });
    expect(svc.get('conv~b', target)?.content).toBe('v1\n');
  });

  it('str_replace_editor 三命令均挂快照', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, path.join(root, 'snaps'));
    const svc = ctx.fileSnapshots as FileSnapshotsService;

    // create（新建——null 快照）
    await exec(ctx, {
      name: 'str_replace_editor',
      args: { command: 'create', path: 'n.md', file_text: 'l1\nl2\n' },
      conversationId: 'conv~s',
    });
    expect(svc.get('conv~s', path.join(root, 'n.md'))?.content).toBe(null);

    // str_replace（存量——快照 = create 后内容）
    await exec(ctx, {
      name: 'str_replace_editor',
      args: { command: 'str_replace', path: 'n.md', old_str: 'l2', new_str: 'L2' },
      conversationId: 'conv~s',
    });
    expect(svc.get('conv~s', path.join(root, 'n.md'))?.content).toBe(null); // 同会话 no-op

    // insert（另一会话——快照 = str_replace 后内容）
    await exec(ctx, {
      name: 'str_replace_editor',
      args: { command: 'insert', path: 'n.md', new_str: 'top', insert_line: 0 },
      conversationId: 'conv~t',
    });
    expect(svc.get('conv~t', path.join(root, 'n.md'))?.content).toBe('l1\nL2\n');
  });

  it('无 conversationId（宿主直调）不触发快照；list/drop 往返', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'x.ts'), 'x\n', 'utf-8');
    const { ctx } = await boot(root, path.join(root, 'snaps'));
    await exec(ctx, { name: 'edit', args: { file_path: 'x.ts', old_string: 'x', new_string: 'y' } });
    const svc = ctx.fileSnapshots as FileSnapshotsService;
    expect(svc.list('conv~none')).toHaveLength(0);

    // 带会话键写 → list 可见 → drop 清空
    await exec(ctx, { name: 'write', args: { file_path: 'y.ts', content: '1\n' }, conversationId: 'conv~z' });
    expect(svc.list('conv~z')).toHaveLength(1);
    svc.dropConversation('conv~z');
    expect(svc.list('conv~z')).toHaveLength(0);
  });

  it('准入双闸：二进制/超限文件编辑照常成功，快照只落 skipped 标记', async () => {
    const root = tmpRoot();
    // maxBytes=16：小文本可入，超限被拒
    const { ctx } = await boot(root, path.join(root, 'snaps'), { maxBytes: 16 });
    const svc = ctx.fileSnapshots as FileSnapshotsService;
    const bin = path.join(root, 'blob.bin');
    fs.writeFileSync(bin, Buffer.from([0x00, 0x01, 0x02]));
    const big = path.join(root, 'big.log');
    fs.writeFileSync(big, 'z'.repeat(26) + 'UNIQUE-MARK' + 'z'.repeat(28), 'utf-8'); // 64 B，标记唯一

    // 二进制文件 edit 成功（写路径不受快照准入影响）+ skipped=not-text
    const r1 = await exec(ctx, {
      name: 'edit',
      args: { file_path: 'blob.bin', old_string: '', new_string: 'A' },
      conversationId: 'conv~g',
    });
    expect(r1.ok).toBe(true);
    expect(svc.get('conv~g', bin)!.skipped).toBe('not-text');

    // 超限文本 edit 成功 + skipped=too-large
    const r2 = await exec(ctx, {
      name: 'edit',
      args: { file_path: 'big.log', old_string: 'UNIQUE-MARK', new_string: 'REPLACED!' },
      conversationId: 'conv~g',
    });
    expect(r2.ok).toBe(true);
    expect(svc.get('conv~g', big)!.skipped).toBe('too-large');

    // 小文本文件照常全量快照（对照组）
    fs.writeFileSync(path.join(root, 's.txt'), 'tiny\n', 'utf-8');
    await exec(ctx, {
      name: 'edit',
      args: { file_path: 's.txt', old_string: 'tiny', new_string: 'TINY' },
      conversationId: 'conv~g',
    });
    expect(svc.get('conv~g', path.join(root, 's.txt'))!.content).toBe('tiny\n');
  });

  it('settings.fileSnapshots.maxBytes 全局层：构造吸收 + config/changed 热更 + 非法值保持现状', async () => {
    const root = tmpRoot();
    const snapRoot = path.join(root, 'snaps');
    const { ctx, fibers } = await boot(root, snapRoot);
    const svc = ctx.fileSnapshots as FileSnapshotsService;
    const cfg = ctx.get('config') as { set(key: string, value: unknown): void; get<T>(key: string): T | undefined };

    // 行配置缺省（无 maxBytes）——settings 层写入 64：构造后热更生效
    const target = path.join(root, 'hot.log');
    fs.writeFileSync(target, 'x'.repeat(128), 'utf-8');
    cfg.set('settings.fileSnapshots', { maxBytes: 64 });
    // config.set 内部 emit config/changed → applySettings 已吸收
    expect(svc.get('conv~h', target)).toBeUndefined(); // 尚未首见
    svc.ensure('conv~h', target);
    expect(svc.get('conv~h', target)!.skipped).toBe('too-large'); // 热更后 64B 上限生效

    // 调大 → 同一会话另一文件恢复全量快照
    cfg.set('settings.fileSnapshots', { maxBytes: 4096 });
    const target2 = path.join(root, 'hot2.log');
    fs.writeFileSync(target2, 'y'.repeat(128), 'utf-8');
    svc.ensure('conv~h', target2);
    expect(svc.get('conv~h', target2)!.content).toBe('y'.repeat(128));

    // 非法值（负数）——保持现状（4096 不变）
    cfg.set('settings.fileSnapshots', { maxBytes: -1 });
    const target3 = path.join(root, 'hot3.log');
    fs.writeFileSync(target3, 'z'.repeat(300), 'utf-8');
    svc.ensure('conv~h', target3);
    expect(svc.get('conv~h', target3)!.content).toBe('z'.repeat(300)); // 仍按 4096 快照

    // 0 = 关闭上限
    cfg.set('settings.fileSnapshots', { maxBytes: 0 });
    const target4 = path.join(root, 'hot4.log');
    fs.writeFileSync(target4, 'w'.repeat(99999), 'utf-8');
    svc.ensure('conv~h', target4);
    expect(svc.get('conv~h', target4)!.content).toBe('w'.repeat(99999));
    void fibers;
  });

  it('快照行缺席：工具照常工作（软依赖不阻断）', async () => {
    const root = tmpRoot();
    const ctx = new Context();
    const fibers: Fiber[] = [];
    for (const [plugin, config] of [
      [toolsRow, undefined],
      [fsToolsRow, { workdir: root }],
    ] as Array<[unknown, unknown]>) {
      const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
      await fiber;
      fibers.push(fiber);
    }
    booted.push({ ctx, fibers });
    fs.writeFileSync(path.join(root, 'a.ts'), 'v1\n', 'utf-8');
    const r = await exec(ctx, {
      name: 'edit',
      args: { file_path: 'a.ts', old_string: 'v1', new_string: 'v2' },
      conversationId: 'conv~x',
    });
    expect(r.ok).toBe(true); // 无快照行——写路径不受影响
    expect(fs.readFileSync(path.join(root, 'a.ts'), 'utf-8')).toBe('v2\n');
  });
});

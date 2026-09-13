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

async function boot(root: string, snapRoot: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: Array<[unknown, unknown]> = [
    [toolsRow, undefined],
    [snapshotsRow, { root: snapRoot }],
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

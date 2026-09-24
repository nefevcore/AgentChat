// ============================================================
// bootstrap.test.ts —— dist 直调发布入口（npm 包形态）行为锁定
//
// 覆盖：--port 参数解析 / 全树装配 + web-server 生产 config /
// 行偏好层停用行 / 单实例锁（锚定数据根）/ 未知停用行 fail-soft。
// 语义对齐锚点 = boot.ts（Loader 路径）与 tree.test.ts（bootTree）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDist, parsePortArg, type BootedDist } from '../src/bootstrap';

const booted: BootedDist[] = [];
const tmpDirs: string[] = [];
const savedEnv = process.env.AGENTCHAT_DATA_ROOT;

function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-bootstrap-'));
  tmpDirs.push(dir);
  return dir;
}

async function boot(root: string) {
  const tree = await bootDist({ dataRoot: root, staticDir: root, port: 0 });
  booted.push(tree);
  return tree;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers.values()].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  if (savedEnv === undefined) delete process.env.AGENTCHAT_DATA_ROOT;
  else process.env.AGENTCHAT_DATA_ROOT = savedEnv;
  delete process.env.AGENTCHAT_BOOT_FORM; // bootDist 设置的形态标记
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parsePortArg（--port=N / --port N；非法值 undefined）', () => {
  it('--port=3902 → 3902', () => {
    expect(parsePortArg(['--port=3902'])).toBe(3902);
  });

  it('--port 3902（空格形态）→ 3902', () => {
    expect(parsePortArg(['chat', '--port', '3902'])).toBe(3902);
  });

  it('缺省/非法（0、超界、NaN）→ undefined', () => {
    expect(parsePortArg([])).toBeUndefined();
    expect(parsePortArg(['--port=0'])).toBeUndefined();
    expect(parsePortArg(['--port=99999'])).toBeUndefined();
    expect(parsePortArg(['--port=abc'])).toBeUndefined();
  });
});

describe('bootDist（dist 直调 boot）', () => {
  it('全树装配 + web-server 监听（port 0 随机口）+ 数据根锚定 + dist 形态标记', async () => {
    const root = freshRoot();
    const { ctx } = await boot(root);
    const port = await ctx.webServer.ready();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(ctx.tools.has('hello')).toBe(true);
    expect(process.env.AGENTCHAT_DATA_ROOT).toBe(root);
    // 形态标记：行偏好 setPatch 等按 dist 语义报告（重启生效而非无消费者）
    expect(process.env.AGENTCHAT_BOOT_FORM).toBe('dist');
  });

  it('行偏好层停用行：cordis.patch.yml {id, disabled} → 该行不装配', async () => {
    const root = freshRoot();
    writeFileSync(join(root, 'cordis.patch.yml'), '- { id: hello, disabled: true }\n');
    const tree = await boot(root);
    expect(tree.skippedRows).toEqual(['hello']);
    expect(tree.fibers.has('hello')).toBe(false); // 停用行未装配
    expect(tree.fibers.has('fs-tools')).toBe(true); // 其余行不受影响
  });

  it('停用未知行 fail-soft：warn 不阻断 boot', async () => {
    const root = freshRoot();
    writeFileSync(join(root, 'cordis.patch.yml'), '- { id: no-such-row, disabled: true }\n');
    const tree = await boot(root);
    expect(tree.skippedRows).toEqual([]);
    expect(tree.ctx.tools.has('hello')).toBe(true);
  });

  it('单实例锁锚定数据根：同根二次 boot 拒绝，异根不受影响', async () => {
    const rootA = freshRoot();
    const first = await boot(rootA); // 持锁直至显式 unlock
    await expect(bootDist({ dataRoot: rootA, staticDir: rootA, port: 0 })).rejects.toThrow(/另一实例/);
    const rootB = freshRoot();
    const second = await boot(rootB); // 异根不冲突
    expect(second.ctx.tools.has('hello')).toBe(true);
    first.unlock?.();
  });
});

describe('bootDist 版本升级数据迁移（对齐 boot.ts；桌面/npm 形态此前漏接的缺口）', () => {
  /** v0 老形态会话数据：主文件内联 event 角色 + subcall 行（v1 迁移目标） */
  function v0Root(): string {
    const root = freshRoot();
    const dir = join(root, 'sessions', 'a~user');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'messages.jsonl'),
      [
        JSON.stringify({ type: 'session-header', version: 1 }),
        JSON.stringify({ role: 'agent', content: 'hi', agent_id: 'user', message_id: 'm1', timestamp: 't', seq: 1 }),
        JSON.stringify({ role: 'event', source: 'event', content: '任务完成', agent_id: 'a', message_id: 'm2', timestamp: 't', seq: 2 }),
        JSON.stringify({ type: 'tool-result', subcall: true, run: 'r1', tool_call_id: 'c#1', result: { ok: true }, seq: 3 }),
      ].join('\n'),
      'utf-8',
    );
    return root;
  }

  it('v0 老数据 boot：迁移按序应用（快照 + 版本推进 + 主文件改写）', async () => {
    const root = v0Root();
    const tree = await boot(root);
    expect(tree.appliedMigrations).toEqual([
      'role-v2-subcall-split',
      'partials-split',
      'subagents-dir',
      'partial-rematerialize-purge',
      'legacy-journal-purge',
    ]);
    // 版本标记推进 + 审计面
    const meta = JSON.parse(readFileSync(join(root, 'meta.json'), 'utf-8')) as { dataVersion: number };
    expect(meta.dataVersion).toBe(5);
    // 迁移前强制快照留档（backups/migrations/ 不参与轮转）
    expect(existsSync(join(root, 'backups', 'migrations'))).toBe(true);
    // 主文件改写到位：role v2 + subcall 剥离
    const raw = readFileSync(join(root, 'sessions', 'a~user', 'messages.jsonl'), 'utf-8');
    expect(raw).toContain('"role":"context"');
    expect(raw).not.toContain('"subcall":true');
  });

  it('已是当前版本：零迁移，appliedMigrations = []', async () => {
    const root = v0Root();
    writeFileSync(join(root, 'meta.json'), JSON.stringify({ dataVersion: 5 }), 'utf-8');
    const tree = await boot(root);
    expect(tree.appliedMigrations).toEqual([]);
    const raw = readFileSync(join(root, 'sessions', 'a~user', 'messages.jsonl'), 'utf-8');
    expect(raw).toContain('"subcall":true'); // 未迁移，原样保留
  });

  it('迁移失败 = 拒绝启动（半迁移数据不可用；快照已留档 backups/migrations/）', async () => {
    // 让迁移必然失败：主文件旁放置同名 .tmp 目录——migrateSessionDir 的
    // 原子写 writeFileSync(tmp) 撞 EISDIR 抛错 → bootDist 整体拒绝
    //（boot 未完成，无行激活）。try/catch 而非 rejects：后者失败时会序列化
    // resolve 出的 BootedDist（含 cordis ctx），撞 inject 守卫报 PrettyFormat 错。
    const root = v0Root();
    mkdirSync(join(root, 'sessions', 'a~user', 'messages.jsonl.tmp'), { recursive: true });
    let thrown: unknown;
    try {
      await boot(root);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    // 迁移前强制快照先行留档（失败恢复的最后防线）
    expect(existsSync(join(root, 'backups', 'migrations'))).toBe(true);
  });
});

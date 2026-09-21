// ============================================================
// bootstrap.test.ts —— dist 直调发布入口（npm 包形态）行为锁定
//
// 覆盖：--port 参数解析 / 全树装配 + web-server 生产 config /
// 行偏好层停用行 / 单实例锁（锚定数据根）/ 未知停用行 fail-soft。
// 语义对齐锚点 = boot.ts（Loader 路径）与 tree.test.ts（bootTree）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

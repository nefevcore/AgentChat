// ============================================================
// plugin-core-f6.test.ts —— F6 approveStaging 中途失败可恢复（定点注入）
//
// 失败注入 = vi.mock fsx.atomicWriteFile 在 writeRegistry 一步抛错。
// （原手段「registry.json chmod 0444」只在 Windows 可靠——rename 在 POSIX
// 不受目标只读位影响（写权限看目录），目录级手段又会破坏回滚 renames；
// mock 注入在两平台命中同一代码点，补偿路径测试完全等价且确定性。）
// 回滚/重试断言全走真实文件系统（copy/backup/renames 不 mock）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 注入开关（vi.hoisted：mock 工厂与测试体共享的模块级状态） */
const inject = vi.hoisted(() => ({ failNextRegistryWrite: false }));

vi.mock('../src/fsx.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/fsx.ts')>();
  return {
    ...actual,
    atomicWriteFile: (file: string, content: string) => {
      if (inject.failNextRegistryWrite && file.endsWith(join('plugins', 'registry.json'))) {
        inject.failNextRegistryWrite = false;
        throw new Error("EACCES: permission denied, rename 'registry.json.tmp' -> 'registry.json'（测试注入）");
      }
      return actual.atomicWriteFile(file, content);
    },
  };
});

const { approveStaging, stagePlugin, listStaging, resetQueuesForTest } = await import('../src/index.ts');

let root: string;
let srcDir: string;

beforeEach(async () => {
  resetQueuesForTest();
  inject.failNextRegistryWrite = false;
  root = await mkdtemp(join(tmpdir(), 'ac-plugin-f6-'));
  srcDir = join(root, 'src-plugin');
  await mkdir(srcDir, { recursive: true });
  await writeFile(join(srcDir, 'manifest.json'), JSON.stringify({
    name: 'demo-plugin',
    version: '1.0.0',
    entry: 'index.ts',
    permissions: ['fs'],
  }));
  await writeFile(join(srcDir, 'index.ts'), 'export function apply() {}\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('F6 approveStaging 中途失败可恢复（writeRegistry 注入）', () => {
  it('writeRegistry 失败 → 回滚到安装前形态，重试成功', async () => {
    // v1 安装成功（基线）
    const r1 = await stagePlugin(root, srcDir, 'tester');
    await approveStaging(root, r1.id);
    const registryFile = join(root, 'plugins', 'registry.json');
    const baseline = readFileSync(registryFile, 'utf-8');

    // bump 1.1.0 后 stage；下一次 registry 原子写定点抛错
    await writeFile(join(srcDir, 'manifest.json'), JSON.stringify({ name: 'demo-plugin', version: '1.1.0', permissions: ['fs'] }));
    const r2 = await stagePlugin(root, srcDir, 'tester');
    inject.failNextRegistryWrite = true;
    let threw = false;
    try {
      await approveStaging(root, r2.id);
    } catch (err: unknown) {
      threw = true;
      expect(err instanceof Error ? err.message : String(err)).toMatch(/写入 registry 失败/);
    }
    expect(threw).toBe(true);

    // 补偿全覆盖：新代码回暂存位（target 无 v2 内容）、旧版复位（v1 可装载）、
    // registry 字节不变、暂存记录仍在（可重试）、无 tmp 残留
    const manifestOnTarget = JSON.parse(readFileSync(join(root, 'plugins', 'demo-plugin', 'manifest.json'), 'utf-8')) as { version: string };
    expect(manifestOnTarget.version).toBe('1.0.0'); // 旧版复位
    expect(readFileSync(registryFile, 'utf-8')).toBe(baseline); // 安装态未变
    expect(existsSync(r2.stagedDir)).toBe(true); // 新代码回暂存位
    expect((await listStaging(root)).some((s) => s.id === r2.id)).toBe(true);
    expect((await readdir(join(root, 'plugins'))).some((e) => e.includes('.tmp'))).toBe(false);

    // 故障解除（注入一次性）→ 重试成功（同 staging 记录，无需重新 stage）
    const retried = await approveStaging(root, r2.id);
    expect(retried.replaced?.oldVersion).toBe('1.0.0');
    expect(JSON.parse(await readFile(join(root, 'plugins', 'demo-plugin', 'manifest.json'), 'utf-8'))).toMatchObject({ version: '1.1.0' });
    expect((await listStaging(root)).some((s) => s.id === r2.id)).toBe(false); // 记录消费
  });
});

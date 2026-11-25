// ============================================================
// shared-externalize.test.ts —— 路径归一外部化插件（cr-1310）
//
// 两面锁：
//   ① 纯函数面：normalizeSharedImport 命中/未命中/词形/注入索引判定；
//   ② 实构建面：微型 vite 构建复现根因链（entry 相对引用共享面文件——
//      rollup 解析为绝对路径、字面 external 永不命中的形态）→ 产物 import
//      词 = 宿主模块表说明符。临时目录住 sandbox/，afterAll 清理。
// ============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { normalizeSharedImport, sharedExternalizePlugin } from '../scripts/shared-externalize.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const convClient = join(repoRoot, 'packages', 'ac-client-ui-conversation', 'client');

describe('normalizeSharedImport（纯函数面）', () => {
  it('相对引用命中共享面 → 宿主模块表说明符', () => {
    expect(normalizeSharedImport('./feed.ts', join(convClient, 'feed-core.ts'))).toBe('ac-client-ui-conversation/client/feed.ts');
  });

  it('相对引用链（./chatOps）命中', () => {
    expect(normalizeSharedImport('./chatOps.ts', join(convClient, 'index.ts'))).toBe('ac-client-ui-conversation/client/chatOps.ts');
  });

  it('未命中文件（非共享相对引用）→ undefined', () => {
    expect(normalizeSharedImport('./somePrivateModule.ts', join(convClient, 'index.ts'))).toBeUndefined();
  });

  it('裸说明符 / 仓库外 importer / importer 缺席 → undefined', () => {
    expect(normalizeSharedImport('vue', join(convClient, 'index.ts'))).toBeUndefined();
    expect(normalizeSharedImport('./feed.ts', 'D:/elsewhere/y.ts')).toBeUndefined();
    expect(normalizeSharedImport('./feed.ts', undefined)).toBeUndefined();
  });

  it('Windows 反斜杠 importer 词形归一（node:path 原生形兼容）', () => {
    const win = join(convClient, 'feed-core.ts');
    expect(normalizeSharedImport('./feed.ts', win)).toBe('ac-client-ui-conversation/client/feed.ts');
  });

  it('注入索引（specs 参数）独立于全仓共享面', () => {
    // 合成路径须落在真实 repoRoot 内（前缀守卫）且键 = 正斜杠形（契约）
    const fwd = (p: string) => p.split(sep).join('/');
    const synthetic = new Map([[fwd(join(convClient, 'a.ts')), 'fake-pkg/client/a.ts']]);
    expect(normalizeSharedImport('./a.ts', join(convClient, 'index.ts'), synthetic)).toBe('fake-pkg/client/a.ts');
    expect(normalizeSharedImport('./c.ts', join(convClient, 'index.ts'), synthetic)).toBeUndefined();
  });

  it('插件 resolveId 形：命中 → { id, external: true }', () => {
    const fwd = (p: string) => p.split(sep).join('/');
    const synthetic = new Map([[fwd(join(convClient, 'a.ts')), 'fake-pkg/client/a.ts']]);
    const p = sharedExternalizePlugin(synthetic);
    expect(p.resolveId('./a.ts', join(convClient, 'b.ts'))).toEqual({ id: 'fake-pkg/client/a.ts', external: true });
    expect(p.resolveId('./zz.ts', join(convClient, 'b.ts'))).toBeUndefined();
  });
});

describe('实构建面（微型 vite 构建——根因链复现）', () => {
  const tmp = join(repoRoot, 'sandbox', 'shared-ext-test');

  it('相对引用命中共享面 → 产物 import 词 = 宿主模块表说明符（不内联）', async () => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(tmp, 'src'), { recursive: true });
    const relSpec = './' + relative(join(tmp, 'src'), join(convClient, 'feed.ts')).split(sep).join('/');
    writeFileSync(join(tmp, 'src', 'entry.ts'), [
      "import { parseDialogId } from '" + relSpec + "';",
      'export const x = parseDialogId;',
    ].join('\n'), 'utf-8');
    await build({
      configFile: false,
      publicDir: false,
      plugins: [sharedExternalizePlugin()],
      build: {
        outDir: join(tmp, 'out'), emptyOutDir: true, target: 'esnext', minify: false,
        lib: { entry: join(tmp, 'src', 'entry.ts'), formats: ['es'], fileName: () => 'index.js' },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    });
    const out = readFileSync(join(tmp, 'out', 'index.js'), 'utf-8');
    expect(out).toContain('ac-client-ui-conversation/client/feed.ts');
    expect(out).not.toContain('directDialog');
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
});

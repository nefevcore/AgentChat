// ============================================================
// hmr-reload-child.ts —— L1.5 reloadFiles e2e 子进程脚本
// （由 hmr-reloadfiles.e2e.test.ts 以 node --expose-internals --import tsx 拉起）
//
// 流程：迷你组合树（hmr 行 root:[] + fixture 插件行）→ 改写 fixture 源码 →
// ctx.hmr.reloadFiles([fixtureUrl]) → 校验新模块生效/水位线推进/externals 拒绝。
// 结果以单行 JSON 打到 stdout。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'node:url';
import { bootComposed } from '../../src/composition';

const dir = process.argv[2];
const hmrEntry = process.argv[3]; // vendored hmr lib 入口（file URL）
const timerEntry = process.argv[4]; // vendored cordis-timer 入口（file URL；hmr inject 依赖）

const fixture = path.join(dir, 'fixture.mjs');
const fixtureUrl = pathToFileURL(fixture).href;
const writeFixture = (delta: number) => {
  fs.writeFileSync(fixture, `
export const name = 'reload-fixture';
export function apply() {
  globalThis.__reloadCount = (globalThis.__reloadCount ?? 0) + ${delta};
}
`, 'utf-8');
};

async function main() {
  writeFixture(1); // v1：每次 apply +1
  const bundle = path.join(dir, 'bundle.yml');
  fs.writeFileSync(bundle, [
    '- insert:',
    // hmr static inject = ['loader', 'timer']：timer 行必须同树（否则 fiber PENDING）
    '    - id: timer',
    `      name: ${JSON.stringify(timerEntry)}`,
    '    - id: hmr',
    `      name: ${JSON.stringify(hmrEntry)}`,
    '      config:',
    '        root: []',
    '        debounce: 100',
    '    - id: fx',
    `      name: ${JSON.stringify(fixtureUrl)}`,
    '',
  ].join('\n'), 'utf-8');

  const booted = await bootComposed({
    profileDir: dir,
    bundleFile: bundle,
    homeDir: null,
    marketDir: null,
    skipUserLayer: true,
  });
  try {
    await booted.include.await();
    const count1 = (globalThis as { __reloadCount?: number }).__reloadCount ?? 0;

    // 行 fiber 激活可能略滞后于 include.await()：短窗轮询取服务
    let hmr: {
      watermark: number;
      isLoaded(url: string): boolean;
      isExternal(url: string): boolean;
      reloadFiles(urls: string[]): Promise<{ ok: boolean; reloaded: string[]; error?: string }>;
    } | undefined;
    for (let i = 0; i < 50 && !hmr; i++) {
      hmr = booted.ctx.get('hmr') as typeof hmr;
      if (!hmr) await new Promise((r) => setTimeout(r, 100));
    }
    if (!hmr) {
      const loader = (booted.ctx as unknown as {
        loader?: { entries(): Iterable<{ options: { name: string } }> };
      }).loader;
      const names = [...(loader?.entries() ?? [])].map((e) => e.options.name);
      const registryNames = [...booted.ctx.registry.keys()].map(String);
      throw new Error(`hmr 服务未就绪（entries=${JSON.stringify(names)} registry-keys=${registryNames.map((s) => s.slice(0, 60))}）`);
    }

    // 本脚本是 argv[1] 依赖树成员 = externals：主动重载必须拒绝（导向 42）
    const selfUrl = pathToFileURL(fs.realpathSync(process.argv[1]!)).href;
    let externalsRejected = false;
    try {
      await hmr.reloadFiles([selfUrl]);
    } catch (err) {
      externalsRejected = String((err as Error).message).includes('system_restart');
    }

    // 写者宣告完成（此处模拟 agent）：改写 fixture 为 v2（apply +10）→ reloadFiles
    const watermarkBefore = hmr.watermark;
    writeFixture(10);
    const result = await hmr.reloadFiles([fixtureUrl]);
    await new Promise((r) => setTimeout(r, 200)); // fiber 重注册收尾
    const count2 = (globalThis as { __reloadCount?: number }).__reloadCount ?? 0;

    console.log('RESULT ' + JSON.stringify({
      count1,
      count2,
      reloadedOk: result.ok,
      reloaded: result.reloaded,
      error: result.error ?? null,
      watermarkAdvanced: hmr.watermark > watermarkBefore,
      watermarkBefore,
      watermarkAfter: hmr.watermark,
      isLoadedFixture: hmr.isLoaded(fixtureUrl),
      externalsRejected,
    }));
  } finally {
    await booted.ctx.fiber.dispose();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('CHILD-FAIL ' + (err?.stack ?? String(err)));
  process.exit(1);
});

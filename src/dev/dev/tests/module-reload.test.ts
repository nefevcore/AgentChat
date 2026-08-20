// ============================================================
// @agentchat/dev 测试：module-reload —— L1.5 水位线扫描 + 变更集发现
// （docs/restart-design.md §2.3：机械发现，不信任自报清单）
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import {
  makeReloadModulesTool,
  planModuleReload,
  scanChangedFiles,
  type ModuleReloadHmr,
} from '../src/module-reload';
import { isToolInterrupt } from '@agentchat/agent-loop';
import type { AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-modreload-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 假 HMR：externals/loaded 集合 + 可设水位线 */
function fakeHmr(opts: { external?: string[]; loaded?: string[]; watermark?: number }): ModuleReloadHmr {
  const external = new Set((opts.external ?? []).map(urlOf));
  const loaded = new Set((opts.loaded ?? []).map(urlOf));
  return {
    watermark: opts.watermark ?? 0,
    isExternal: (url) => external.has(url),
    isLoaded: (url) => loaded.has(url),
  };
}

function urlOf(p: string): string {
  return p.startsWith('file://') ? p : pathToFileURL(path.resolve(tmp, 'proj', p)).href;
}

function writeProjectFile(rel: string, content = '// code', mtime?: Date): string {
  const file = path.join(tmp, 'proj', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

describe('scanChangedFiles', () => {
  it('只返回 mtime ≥ since 的源码文件；跳过依赖/构建/测试/隐藏目录', () => {
    const old = new Date(Date.now() - 60_000);
    const fresh = new Date();
    writeProjectFile('src/a.ts', 'a', old);
    writeProjectFile('src/pkg/b.ts', 'b', fresh);
    writeProjectFile('src/pkg/node_modules/c.ts', 'c', fresh);
    writeProjectFile('src/pkg/dist/d.ts', 'd', fresh);
    writeProjectFile('src/pkg/tests/e.ts', 'e', fresh);
    writeProjectFile('src/pkg/.hidden/f.ts', 'f', fresh);
    writeProjectFile('src/pkg/g.txt', 'g', fresh); // 非源码扩展名
    const since = Date.now() - 10_000;
    const changed = scanChangedFiles([path.join(tmp, 'proj', 'src')], since);
    const rels = changed.map((f) => path.relative(path.join(tmp, 'proj'), f).split(path.sep).join('/'));
    expect(rels).toEqual(['src/pkg/b.ts']);
  });
});

describe('planModuleReload', () => {
  it('扫描 ∩ loadCache ∪ 显式已加载；externals 进 framework 拒绝桶', () => {
    const fresh = new Date();
    const watermark = Date.now() - 10_000;
    writeProjectFile('src/changed-loaded.ts', 'x', fresh);
    writeProjectFile('src/changed-unloaded.ts', 'x', fresh);
    writeProjectFile('src/changed-external.ts', 'x', fresh);

    const hmr = fakeHmr({
      watermark,
      loaded: ['src/changed-loaded.ts', 'src/old-loaded.ts', 'src/changed-external.ts'],
      external: ['src/changed-external.ts'],
    });
    const plan = planModuleReload(hmr, path.join(tmp, 'proj'), ['src/old-loaded.ts', 'src/new-file.ts']);

    expect(plan.targets).toEqual([urlOf('src/changed-loaded.ts'), urlOf('src/old-loaded.ts')]);
    expect(plan.framework).toEqual([urlOf('src/changed-external.ts')]);
    expect(plan.unloaded).toEqual([urlOf('src/new-file.ts')]);
    expect(plan.watermark).toBe(watermark);
  });

  it('显式 file:// URL 与绝对/相对路径归一为同一 URL（去重）', () => {
    writeProjectFile('src/x.ts', 'x');
    const hmr = fakeHmr({ watermark: 0, loaded: ['src/x.ts'] });
    const plan = planModuleReload(hmr, path.join(tmp, 'proj'), [
      'src/x.ts',
      path.join(tmp, 'proj', 'src', 'x.ts'),
      urlOf('src/x.ts'),
    ]);
    expect(plan.targets).toEqual([urlOf('src/x.ts')]);
  });
});

describe('reload_modules 工具', () => {
  const config: AgentConfig = { agent_id: 'dev-agent', name: 'Dev', tags: ['dev'] };

  function makeTool(hmr?: ModuleReloadHmr): Tool {
    return makeReloadModulesTool(() => hmr, config, path.join(tmp, 'proj'));
  }

  it('HMR 不可用 → 错误提示（不中断）', async () => {
    const res = await makeTool(undefined).execute({});
    expect(res).toContain('不可用');
    expect(res).toContain('error');
  });

  it('无变更 → ok 空清单（不中断）', async () => {
    writeProjectFile('src/a.ts', 'a', new Date(Date.now() - 60_000));
    const hmr = fakeHmr({ watermark: Date.now() - 10_000, loaded: ['src/a.ts'] });
    const res = await makeTool(hmr).execute({});
    expect(res).toContain('"ok"');
    expect(res).toContain('未发现需要重载的模块变更');
  });

  it('框架文件命中 → 拒绝并导向 system_restart（不中断）', async () => {
    writeProjectFile('src/vendor/cordis/src/context.ts', 'x', new Date());
    const hmr = fakeHmr({
      watermark: Date.now() - 10_000,
      loaded: ['src/vendor/cordis/src/context.ts'],
      external: ['src/vendor/cordis/src/context.ts'],
    });
    const res = await makeTool(hmr).execute({});
    expect(res).toContain('error');
    expect(res).toContain('system_restart');
    expect(res).toContain('框架/内核文件');
  });

  it('有已加载变更 → ToolInterrupt(scope=modules, files=URL 清单)', async () => {
    writeProjectFile('src/shell/src/tools.ts', 'x', new Date());
    const hmr = fakeHmr({ watermark: Date.now() - 10_000, loaded: ['src/shell/src/tools.ts'] });
    try {
      await makeTool(hmr).execute({});
      expect.unreachable('应抛 ToolInterrupt');
    } catch (err) {
      expect(isToolInterrupt(err)).toBe(true);
      const reason = (err as { reason: { type: string; scope: string; files: string[] } }).reason;
      expect(reason.type).toBe('reload-requested');
      expect(reason.scope).toBe('modules');
      expect(reason.files).toEqual([urlOf('src/shell/src/tools.ts')]);
    }
  });

  it('显式 files 并入重载清单', async () => {
    writeProjectFile('src/explicit.ts', 'x', new Date(Date.now() - 60_000));
    const hmr = fakeHmr({ watermark: Date.now() - 30_000, loaded: ['src/explicit.ts'] });
    try {
      await makeTool(hmr).execute({ files: ['src/explicit.ts'] });
      expect.unreachable('应抛 ToolInterrupt');
    } catch (err) {
      expect(isToolInterrupt(err)).toBe(true);
      const reason = (err as { reason: { files: string[] } }).reason;
      expect(reason.files).toEqual([urlOf('src/explicit.ts')]);
    }
  });
});

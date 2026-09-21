// ============================================================
// ac-web-api/src/version.ts —— 版本面纯助手单测
// 根定位/比较语义/Release 缓存（TTL + 失败不缓存）/
// 自更新非 git 守卫（不执行任何命令）。git 路径 e2e 不进测试
// （会真实 pull 仓库——手动冒烟覆盖）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareVersion,
  fetchLatestRelease,
  findProjectVersion,
  readChangelog,
  resetReleaseCache,
  resolveBundleVersion,
  runSelfUpdate,
} from '../src/version.ts';

describe('version 纯助手', () => {
  it('compareVersion：三段语义比较', () => {
    expect(compareVersion('0.9.0', '0.8.4')).toBe(1);
    expect(compareVersion('0.8.4', '0.8.4')).toBe(0);
    expect(compareVersion('0.8.3', '0.8.4')).toBe(-1);
    expect(compareVersion('0.8.10', '0.8.9')).toBe(1);
    expect(compareVersion('1.0.0', '0.99.99')).toBe(1);
    // 缺段补 0（'0.8' ≡ '0.8.0'）
    expect(compareVersion('0.8', '0.8.0')).toBe(0);
  });

  it('findProjectVersion：定位带 version 的根包（dir 供自更新/changelog 锚定）', () => {
    const v = findProjectVersion();
    expect(v?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof v?.name).toBe('string');
    expect(typeof v?.dir).toBe('string');
  });

  it('resolveBundleVersion：dist/version.json 自述优先（桌面装配锚）；缺失/无 version → undefined', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-version-bundle-'));
    // 缺失 → undefined（源码形态回落 package.json 走查）
    expect(resolveBundleVersion(dir)).toBeUndefined();
    // 有 version.json → 读出（name 缺省 agentchat）
    writeFileSync(join(dir, 'version.json'), JSON.stringify({ version: '9.9.9' }));
    expect(resolveBundleVersion(dir)).toEqual({ dir, name: 'agentchat', version: '9.9.9' });
    // 空 version → 不认（防脏清单谎报）
    writeFileSync(join(dir, 'version.json'), JSON.stringify({ version: '' }));
    expect(resolveBundleVersion(dir)).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('readChangelog：仓库根 CHANGELOG.md 可读（npm 安装缺失 → 空文案）', () => {
    const content = readChangelog();
    expect(typeof content).toBe('string');
    // 测试 cwd=workspace/test 向上走查命中仓库根；只做存在性断言（内容随版本演进）
    if (content !== '') expect(content).toMatch(/^#\s/m);
  });

  it('fetchLatestRelease：manifest 主源成功入缓存（TTL 内不重发，不打 GitHub）', async () => {
    resetReleaseCache();
    let hits = 0;
    const okFetch = (async (url: any) => {
      hits += 1;
      if (String(url).includes('manifest.json')) {
        return new Response(
          JSON.stringify({ updated: '2026-09-18T10:07:33Z', releases: [
            { version: '9.9.9', date: '2026-09-18', files: [] },
            { version: '9.8.0', date: '2026-09-01', files: [] },
          ] }),
          { status: 200 },
        );
      }
      throw new Error('GitHub 不应被打到（manifest 主源已命中）');
    }) as typeof fetch;
    const a = await fetchLatestRelease(okFetch);
    expect(a).toMatchObject({ version: '9.9.9', url: 'http://47.110.63.135/', publishedAt: '2026-09-18' });
    // 缓存命中：第二次不再打接口
    const b = await fetchLatestRelease(okFetch);
    expect(hits).toBe(1);
    expect(b).toEqual(a);
    resetReleaseCache();
  });

  it('fetchLatestRelease：manifest 不可达 → GitHub 兜底；双败 → null 不缓存', async () => {
    resetReleaseCache();
    const githubOkFetch = (async (url: any) => {
      if (String(url).includes('manifest.json')) return new Response('not found', { status: 404 });
      return new Response(
        JSON.stringify({ tag_name: 'v9.9.9', html_url: 'https://github.com/nefevcore/AgentChat/releases/tag/v9.9.9', published_at: '2026-01-01T00:00:00Z' }),
        { status: 200 },
      );
    }) as typeof fetch;
    // 兜底命中：GitHub 形状原样透出
    const a = await fetchLatestRelease(githubOkFetch);
    expect(a).toMatchObject({ version: '9.9.9', url: 'https://github.com/nefevcore/AgentChat/releases/tag/v9.9.9' });
    // 双败：null 且不缓存 → 下次成功仍能取到
    resetReleaseCache();
    let hits = 0;
    const failFetch = (async () => {
      hits += 1;
      throw new Error('offline');
    }) as typeof fetch;
    expect(await fetchLatestRelease(failFetch)).toBeNull();
    const c = await fetchLatestRelease(githubOkFetch);
    expect(hits).toBe(2); // 双源各打一次
    expect(c?.version).toBe('9.9.9');
    resetReleaseCache();
  });

  it('fetchLatestRelease：manifest 形状坏（releases 空/无版本）→ 不认，走兜底', async () => {
    resetReleaseCache();
    const badManifestFetch = (async (url: any) => {
      if (String(url).includes('manifest.json')) {
        return new Response(JSON.stringify({ releases: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ tag_name: 'v9.9.9' }), { status: 200 });
    }) as typeof fetch;
    const a = await fetchLatestRelease(badManifestFetch);
    expect(a?.version).toBe('9.9.9');
    expect(a?.url).toContain('github.com');
    resetReleaseCache();
  });

  it('runSelfUpdate：非 git 检出 → unavailable + 手动指引（零命令执行）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-version-nogit-'));
    const r = await runSelfUpdate(dir);
    expect(r.status).toBe('unavailable');
    expect(r.message).toContain('git');
    expect(r.message).toContain('npm install -g');
    expect(r.steps).toEqual([]);
  });
});

// ============================================================
// dist-form.test.ts —— 发布 bundle 形态的行偏好/目录语义
//   · enumerateDisablableEntryIds：无 loader → 构建期清单行映射兜底
//   · setPatch：无 include 行时 dist 形态（AGENTCHAT_BOOT_FORM=dist，
//     bootstrap 标记）如实报 written+restartRequired（bootstrap 于下次
//     启动消费 patch）；未标记的程序化组合维持 no-include-row
//   · resetPatches(minimal)：无 loader 时经清单枚举同样可用
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import { PluginRegistryService } from '../src/service.ts';
import { readPatchFile } from 'ac-plugin-core';

const savedManifestEnv = process.env.AGENTCHAT_PLUGIN_MANIFEST;
const savedFormEnv = process.env.AGENTCHAT_BOOT_FORM;
const tmpDirs: string[] = [];
const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function bootRegistry(root: string) {
  const ctx = new Context();
  const fiber = ctx.plugin(PluginRegistryService as any, { root });
  await fiber;
  booted.push({ ctx, fibers: [fiber] });
  const service = ctx.get('pluginRegistry') as PluginRegistryService;
  return { ctx, service };
}

function manifestFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-dist-form-'));
  tmpDirs.push(dir);
  const file = join(dir, 'plugin-catalog.json');
  writeFileSync(file, JSON.stringify({
    builtin: [{ name: 'ac-hello', version: '0.1.0', description: '链路验证' }],
    rows: [
      { id: 'hello', name: 'ac-hello' },
      { id: 'web-server', name: 'ac-web-server' },
      { id: 'session', name: 'ac-session' },
    ],
  }));
  return file;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  if (savedManifestEnv === undefined) delete process.env.AGENTCHAT_PLUGIN_MANIFEST;
  else process.env.AGENTCHAT_PLUGIN_MANIFEST = savedManifestEnv;
  if (savedFormEnv === undefined) delete process.env.AGENTCHAT_BOOT_FORM;
  else process.env.AGENTCHAT_BOOT_FORM = savedFormEnv;
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('enumerateDisablableEntryIds（无 loader 的程序化组合）', () => {
  it('清单兜底：rows 全量行 id（去重排序）；无清单 → undefined', () => {
    const ctx = new Context();
    const manifest = manifestFixture();
    process.env.AGENTCHAT_PLUGIN_MANIFEST = manifest;
    expect(PluginRegistryService.enumerateDisablableEntryIds(ctx)).toEqual(['hello', 'session', 'web-server']);
    delete process.env.AGENTCHAT_PLUGIN_MANIFEST;
    expect(PluginRegistryService.enumerateDisablableEntryIds(ctx)).toBeUndefined();
  });
});

describe('setPatch（无 include 行：dist 形态 vs 程序化组合）', () => {
  it('AGENTCHAT_BOOT_FORM=dist → written + restartRequired（bootstrap 重启消费）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-dist-setpatch-'));
    tmpDirs.push(root);
    const { service } = await bootRegistry(root);
    process.env.AGENTCHAT_BOOT_FORM = 'dist';
    const r = await service.setPatch('hello', true);
    expect(r.state).toBe('written');
    expect(r.restartRequired).toBe(true);
    expect(readPatchFile(root).patches).toEqual([{ id: 'hello', disabled: true }]);
  });

  it('未标记的程序化组合 → no-include-row（偏好无消费者）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-dist-setpatch2-'));
    tmpDirs.push(root);
    const { service } = await bootRegistry(root);
    delete process.env.AGENTCHAT_BOOT_FORM;
    const r = await service.setPatch('hello', true);
    expect(r.state).toBe('no-include-row');
    expect(r.restartRequired).toBeUndefined();
  });
});

describe('resetPatches(minimal)（无 loader：清单枚举兜底 + dist 重启生效语义）', () => {
  it('清单行集可枚举 → minimal 停用清单可写（dist 形态重启生效）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-dist-minimal-'));
    tmpDirs.push(root);
    const { service } = await bootRegistry(root);
    process.env.AGENTCHAT_PLUGIN_MANIFEST = manifestFixture();
    process.env.AGENTCHAT_BOOT_FORM = 'dist';
    const r = await service.resetPatches('minimal');
    expect(r.state).toBe('written');
    expect(r.restartRequired).toBe(true);
    // 停用集 = 清单行 − 核心集（web-server/session 属核心链，hello 被停）
    const ids = readPatchFile(root).patches.filter((p) => p.disabled === true).map((p) => p.id);
    expect(ids).toContain('hello');
    expect(ids).not.toContain('web-server');
    expect(ids).not.toContain('session');
  });
});

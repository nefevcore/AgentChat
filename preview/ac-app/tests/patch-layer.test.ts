// ============================================================
// ac-app：M23 P3-lite 行偏好层
//   · cordis.patch.yml 文件域（readPatchFile fail-soft / setPatchEntry upsert）
//   · boot 桥接等价路径（文件 → bootFromConfig patches 注入 → 行停用生效）
//   · F10 cordis.yml 写回守卫：patch 生效 + 任意树操作后出厂文件字节不变
//     （含 insert 型 patch 场景——防未来功能把已 patch 的树数据烧回 yml）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { bootFromConfig, PREVIEW_DIR, type BootedConfig } from '../src/ecosystem';
import type { EntryOptions } from '@agentchat/cordis-loader';
import {
  patchFilePath,
  readPatchFile,
  setPatchEntry,
  writePatchFile,
} from 'ac-plugin-core';
const booted: BootedConfig[] = [];
const roots: string[] = [];
const TEST_YML = 'cordis.patch-guard.test.yml';
const REAL_YML = join(PREVIEW_DIR, 'cordis.yml');

async function realRows(): Promise<EntryOptions[]> {
  return yaml.load(await readFile(REAL_YML, 'utf8')) as EntryOptions[];
}

async function bootTest(patches?: EntryOptions[] extends never ? never : Array<Record<string, unknown>>) {
  const bootedConfig = await bootFromConfig({
    file: `./${TEST_YML}`,
    rows: await realRows(),
    ...(patches ? { patches: patches as never } : {}),
  });
  booted.push(bootedConfig);
  return { ...bootedConfig, file: join(PREVIEW_DIR, TEST_YML) };
}

afterEach(async () => {
  for (const { includeEntry, loaderFiber } of booted.splice(0)) {
    await includeEntry.fiber?.dispose();
    if (loaderFiber.uid !== null) await loaderFiber.dispose();
  }
  await rm(join(PREVIEW_DIR, TEST_YML), { force: true });
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('cordis.patch.yml 文件域（A2/F12）', () => {
  it('不存在 → 空数组（首次启动常态）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-patch-'));
    roots.push(root);
    const read = readPatchFile(root);
    expect(read.patches).toEqual([]);
    expect(read.warnings).toEqual([]);
  });

  it('setPatchEntry upsert + 读回；原子写无 tmp 残留', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-patch-'));
    roots.push(root);
    await setPatchEntry(root, 'mcp', true);
    await setPatchEntry(root, 'llm-glm', true);
    await setPatchEntry(root, 'mcp', false); // upsert 覆盖
    const read = readPatchFile(root);
    expect(read.patches).toEqual([
      { id: 'mcp', disabled: false },
      { id: 'llm-glm', disabled: true },
    ]);
    const raw = await readFile(patchFilePath(root), 'utf-8');
    expect(raw).toContain('id: mcp, disabled: false');
    expect(raw).toContain('# AgentChat 行偏好层');
  });

  it('损坏/非数组 → warn + 空数组；未知键/缺 id → warn 不阻断（fail-soft）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-patch-'));
    roots.push(root);
    await writeFile(patchFilePath(root), '{oops: [', 'utf-8');
    const broken = readPatchFile(root);
    expect(broken.patches).toEqual([]);
    expect(broken.warnings.join()).toMatch(/解析失败/);

    await writeFile(patchFilePath(root), 'just-a-string', 'utf-8');
    const nonArray = readPatchFile(root);
    expect(nonArray.patches).toEqual([]);
    expect(nonArray.warnings.join()).toMatch(/顶层必须是 patch 数组/);

    await writeFile(patchFilePath(root), '- { id: mcp, disabled: true }\n- { disabled: true }\n- { id: x, weirdKey: 1 }\n', 'utf-8');
    const partial = readPatchFile(root);
    expect(partial.patches).toEqual([{ id: 'mcp', disabled: true }, { id: 'x', weirdKey: 1 }]);
    expect(partial.warnings.join()).toMatch(/缺 id/);
    expect(partial.warnings.join()).toMatch(/未知键/);
  });

  it('writePatchFile 空列表 → 注释头可读文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-patch-'));
    roots.push(root);
    await writePatchFile(root, []);
    const raw = await readFile(patchFilePath(root), 'utf-8');
    expect(raw).toContain('行偏好层');
    expect(readPatchFile(root).patches).toEqual([]);
  });
});

describe('boot 桥接等价路径（patch 文件 → include patches → 行停用）', () => {
  it('patch 文件的 patches 注入 bootFromConfig：行停用生效且不写回', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-patch-'));
    roots.push(root);
    await setPatchEntry(root, 'llm-glm', true);
    const { patches } = readPatchFile(root);
    const { ctx, file } = await bootTest(patches as never);
    expect(ctx.llm.providers()).not.toContain('glm');
    const rows = yaml.load(await readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    expect((rows.find((r) => r.id === 'llm-glm') as Record<string, unknown>).disabled).toBeUndefined();
  });
});

describe('F10 cordis.yml 写回守卫（出厂态永不运行时写入）', () => {
  it('patch-set + 任意树操作后 cordis.yml 字节不变', async () => {
    // patch-set 半边（文件域写，不触 yml）
    const root = await mkdtemp(join(tmpdir(), 'ac-patch-'));
    roots.push(root);
    await setPatchEntry(root, 'llm-glm', true);

    const { ctx, file, include, loaderFiber } = await bootTest([{ id: 'llm-glm', disabled: true }] as never);
    const before = await readFile(file, 'utf8');
    expect(ctx.llm.providers()).not.toContain('glm'); // patch 生效中

    // 树操作 ①：配置热刷新（读文件重挂——patch 再叠）
    await include.refresh();
    // 树操作 ②：loader.create（vendor 每 API 末尾 tree.write()——loader 无文件应 no-op）
    const tempModule = join(PREVIEW_DIR, 'patch-guard-widget.test.ts');
    await writeFile(tempModule, 'export function apply() {}\n', 'utf8');
    const widgetUrl = new URL(`file:///${tempModule.replaceAll('\\', '/')}`).href;
    const created = ctx.loader.create({ name: widgetUrl });
    await created;
    // 树操作 ③：非 loader 途径 dispose 一个 yml 行 fiber（vendor 自动写
    // disabled: true 的路径——include 挂内存根树应不落盘）
    const entries = [...ctx.loader.entries()];
    const glmEntry = entries.find((e) => (e.id ?? '').endsWith('llm-glm'));
    if (glmEntry?.fiber) await glmEntry.fiber.dispose();

    const after = await readFile(file, 'utf8');
    expect(after).toBe(before); // 字节不变——出厂态不变量
    await rm(tempModule, { force: true });
    void loaderFiber;
  });

  it('insert 型 patch 场景：运行时插入行不烧回 yml（下次启动不重复插行）', async () => {
    const tempModule = join(PREVIEW_DIR, 'patch-guard-insert.test.ts');
    await writeFile(tempModule, "export const name = 'ac-patch-guard-insert';\nexport function apply() {}\n", 'utf8');
    const moduleUrl = new URL(`file:///${tempModule.replaceAll('\\', '/')}`).href;
    const { ctx, file } = await bootTest([{ insert: [{ id: 'inserted-widget', name: moduleUrl }] }] as never);
    const before = await readFile(file, 'utf8');
    // 插入行确实生效（进程内可见）
    const names = [...ctx.registry.values()].map((r) => r.name);
    expect(names).toContain('ac-patch-guard-insert');
    // 但 yml 字节不变（insert 未烧录；下次启动 patches 再叠也不会重复插行）
    const after = await readFile(file, 'utf8');
    expect(after).toBe(before);
    expect(after).not.toContain('inserted-widget');
    await rm(tempModule, { force: true });
  });
});

describe('M25 P3：include 热通道（setPatch hot 态）', () => {
  it('hot：fiber.update 事务化行树变更——当前进程即时生效 + cordis.yml 字节不变', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-patch-hot-'));
    roots.push(root);
    // 数据根锚定到临时目录（pluginRegistry 行缺省 ./data——避免写进仓库）
    const prevRoot = process.env.AGENTCHAT_DATA_ROOT;
    process.env.AGENTCHAT_DATA_ROOT = root;
    try {
      const { ctx, file } = await bootTest();
      // yml 树已带 plugin-registry 行——用既有服务（勿重复构造）
      const registry = ctx.pluginRegistry;

      // 初始：llm-glm 行装配中
      expect(ctx.llm.providers()).toContain('glm');
      const before = await readFile(file, 'utf8');

      // 热停用：hot 态即时生效（当前进程行卸下）
      const off = await registry.setPatch('llm-glm', true);
      expect(off.state).toBe('hot');
      expect(ctx.llm.providers()).not.toContain('glm');

      // F10 守卫维持：patch-set + 树操作后出厂文件字节不变
      const afterOff = await readFile(file, 'utf8');
      expect(afterOff).toBe(before);

      // 偏好文件已写盘（重启后仍停用）
      expect(readPatchFile(root).patches).toContainEqual({ id: 'llm-glm', disabled: true });

      // 热启用：恢复 + 再清计数语义（patch 文件 upsert）
      const on = await registry.setPatch('llm-glm', false);
      expect(on.state).toBe('hot');
      expect(ctx.llm.providers()).toContain('glm');
      const final = await readFile(file, 'utf8');
      expect(final).toBe(before);
    } finally {
      if (prevRoot === undefined) delete process.env.AGENTCHAT_DATA_ROOT;
      else process.env.AGENTCHAT_DATA_ROOT = prevRoot;
    }
  });

  it('假阳性防护（2026-08-30 事故回归）：patch id 未命中装配文件原文 → 不谎报 hot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-patch-fake-'));
    roots.push(root);
    const prevRoot = process.env.AGENTCHAT_DATA_ROOT;
    process.env.AGENTCHAT_DATA_ROOT = root;
    try {
      const { ctx } = await bootTest();
      const registry = ctx.pluginRegistry;
      expect(ctx.llm.providers()).toContain('glm');

      // 事故形态：namespaced entry.id（<树前缀>:<裸id>——历史上 plugin/rows
      // 透出的就是这个形态）作 patch id → applyEntryPatches warn+skip、
      // fiber.update 照样成功。修复后必须回落 written 而非谎报 hot
      const namespaced = 'deadbeef:llm-glm';
      const r1 = await registry.setPatch(namespaced, true);
      expect(r1.state).toBe('written');
      expect(r1.restartRequired).toBe(true);
      expect(ctx.llm.providers()).toContain('glm'); // 进程内行未变（未谎报生效）

      // 纯陌生 id 同理
      const r2 = await registry.setPatch('no-such-row', true);
      expect(r2.state).toBe('written');
      expect(r2.restartRequired).toBe(true);

      // 裸 yml id（正确锚点）依旧真 hot
      const r3 = await registry.setPatch('llm-glm', true);
      expect(r3.state).toBe('hot');
      expect(ctx.llm.providers()).not.toContain('glm');
      await registry.setPatch('llm-glm', false); // 还原
    } finally {
      if (prevRoot === undefined) delete process.env.AGENTCHAT_DATA_ROOT;
      else process.env.AGENTCHAT_DATA_ROOT = prevRoot;
    }
  });
});

describe('还原模式（resetPatches：factory / minimal——真实 cordis.yml 全量行）', () => {
  it('minimal 热生效：非核心行停用、核心链（provider/RPC 面/急救域）存活；factory 清空回出厂', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-reset-'));
    roots.push(root);
    const prevRoot = process.env.AGENTCHAT_DATA_ROOT;
    process.env.AGENTCHAT_DATA_ROOT = root;
    try {
      const { ctx, file } = await bootTest();
      const registry = ctx.pluginRegistry;
      expect(ctx.llm.providers()).toContain('glm');
      const before = await readFile(file, 'utf8');

      // ---- minimal：非核心行全部热停用 ----
      const min = await registry.resetPatches('minimal');
      expect(min.state).toBe('hot');
      // 非核心：llm-glm / persona 不在进程内
      expect(ctx.llm.providers()).not.toContain('glm');
      expect([...ctx.registry.values()].some((r) => r.name === 'ac-persona')).toBe(false);
      // 核心链存活：provider（llm-openai）/ RPC 面行 / 急救域
      expect(ctx.llm.providers()).toContain('openai');
      expect([...ctx.registry.values()].some((r) => r.name === 'ac-web-api')).toBe(true);
      expect(registry.listPatches().patches.every((p) => p.disabled)).toBe(true);
      // 停用表 = 在册行 − 核心集（核心行绝不在表）
      expect(min.patches.some((p) => p.id === 'llm-glm' && p.disabled)).toBe(true);
      expect(min.patches.some((p) => p.id === 'plugin-registry' || p.id === 'web-server' || p.id === 'patch-rpc')).toBe(false);
      // F10 延续：还原操作不写出厂文件
      expect(await readFile(file, 'utf8')).toBe(before);

      // ---- factory：清空回出厂全量 ----
      const fact = await registry.resetPatches('factory');
      expect(fact.state).toBe('hot');
      expect(fact.patches).toEqual([]);
      expect(ctx.llm.providers()).toContain('glm');
      expect([...ctx.registry.values()].some((r) => r.name === 'ac-persona')).toBe(true);
      expect(await readFile(file, 'utf8')).toBe(before);
    } finally {
      if (prevRoot === undefined) delete process.env.AGENTCHAT_DATA_ROOT;
      else process.env.AGENTCHAT_DATA_ROOT = prevRoot;
    }
  });
});

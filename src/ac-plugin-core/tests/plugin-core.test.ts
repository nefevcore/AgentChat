// ============================================================
// ac-plugin-core：manifest 校验 / 权限策略 / 契约兼容 / staging 文件域
// + M23：provides 对象形状 / 保留字 / 熔断存档 / 审计流水 / 原子写与串行队列
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approveStaging,
  assertPermissionsGranted,
  grantPermissions,
  hashPluginDir,
  isContractsCompatible,
  listInstalled,
  listStaging,
  listStagingFiles,
  loadManifestFromDir,
  readStagingFile,
  rejectStaging,
  stagePlugin,
  uninstallPlugin,
  validatePluginManifest,
  HOST_CONTRACTS_VERSION,
} from '../src/index.ts';
import { missingPermissions, type PluginManifest, type PluginPermission } from '../src/manifest.ts';
import {
  appendAudit,
  readAudit,
  atomicWriteFile,
  resetQueuesForTest,
  withRootLock,
  findReservedConflict,
  reservedConflictError,
  BUILTIN_AGENT_IDS,
  BUILTIN_LLM_PROVIDER_NAMES,
  BUILTIN_TOOL_NAMES,
  clearLoadHealth,
  isLoadDisabled,
  readLoadHealth,
  recordLoadFailure,
  LOAD_FAILURE_THRESHOLD,
} from '../src/index.ts';
import { createSerialQueue } from '../src/fsx.ts';

let root: string;
let srcDir: string;

beforeEach(async () => {
  resetQueuesForTest();
  root = await mkdtemp(join(tmpdir(), 'ac-plugin-'));
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

describe('manifest 校验', () => {
  it('合法 manifest 通过并规范化', () => {
    const r = validatePluginManifest({ name: 'ok', version: '1.2.3' });
    expect(r.ok).toBe(true);
    expect(r.manifest!.entry).toBe('index.ts'); // 缺省入口
  });

  it('非法 name / version / 权限词 / 路径逃逸各自报错', () => {
    expect(validatePluginManifest({ name: 'Bad_Name', version: '1.0.0' }).errors[0]).toMatch(/name/);
    expect(validatePluginManifest({ name: 'ok', version: 'x' }).errors[0]).toMatch(/version/);
    expect(validatePluginManifest({ name: 'ok', version: '1.0.0', permissions: ['nope'] }).errors[0]).toMatch(/未知权限/);
    expect(validatePluginManifest({ name: 'ok', version: '1.0.0', entry: '../escape.ts' }).errors[0]).toMatch(/entry/);
    expect(validatePluginManifest(null).ok).toBe(false);
  });

  it('manifest.ui 存在时强制 ui 权限（整包原子装载）', () => {
    const r = validatePluginManifest({ name: 'ok', version: '1.0.0', ui: { slots: ['settings-tab'] } });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/permissions 必须包含 "ui"/);
  });

  it('ui.slots 只做格式校验（白名单存在性在注册期）', () => {
    const r = validatePluginManifest({
      name: 'ok', version: '1.0.0', permissions: ['ui'],
      ui: { slots: ['custom-slot'] },
    });
    expect(r.ok).toBe(true);
    expect(validatePluginManifest({
      name: 'ok', version: '1.0.0', permissions: ['ui'],
      ui: { slots: ['Bad Slot'] },
    }).ok).toBe(false);
  });

  it('M23 provides 对象形状：tools/llmProviders/events/ui/agents 全收编；存量 {tools} 兼容', () => {
    const full = validatePluginManifest({
      name: 'ok', version: '1.0.0',
      provides: { tools: ['a', 'a'], llmProviders: ['p'], events: ['loop/before-run'], ui: true, agents: ['x'] },
    });
    expect(full.ok).toBe(true);
    expect(full.manifest!.provides).toEqual({
      tools: ['a'],
      llmProviders: ['p'],
      events: ['loop/before-run'],
      ui: true,
      agents: ['x'],
    });
    // 存量形状 { tools } 原样兼容
    const legacy = validatePluginManifest({ name: 'ok', version: '1.0.0', provides: { tools: ['t'] } });
    expect(legacy.ok).toBe(true);
    expect(legacy.manifest!.provides).toEqual({ tools: ['t'] });
    // 形态错误可诊断
    expect(validatePluginManifest({ name: 'ok', version: '1.0.0', provides: { tools: 1 } }).ok).toBe(false);
    expect(validatePluginManifest({ name: 'ok', version: '1.0.0', provides: { ui: 'yes' } }).ok).toBe(false);
    expect(validatePluginManifest({ name: 'ok', version: '1.0.0', provides: [] }).ok).toBe(false);
  });
});

describe('权限授予策略', () => {
  it('默认授予 fs/network；显式 grants 去重合并；未知权限抛错', () => {
    expect(grantPermissions(undefined)).toEqual(['fs', 'network']);
    expect(grantPermissions(['shell', 'fs'])).toEqual(['fs', 'network', 'shell']);
    expect(() => grantPermissions(['hack'])).toThrow(/未知权限/);
  });

  it('missingPermissions：process/shell 声明未授予即缺失；ui 由 manifest.ui 触发', () => {
    const m: PluginManifest = { name: 'x', version: '1.0.0', entry: 'index.ts', permissions: ['fs', 'process', 'ui'] as PluginPermission[] };
    // 执行期强制集 = process/shell：ui 声明未授予不缺（除非 manifest.ui 存在）
    expect(missingPermissions(m, ['fs', 'network'])).toEqual(['process']);
    expect(missingPermissions(m, ['fs', 'network', 'process', 'ui'])).toEqual([]);
    // manifest.ui 存在时 ui 与 process/shell 同级强制（整包原子装载）
    const withUi: PluginManifest = { ...m, ui: {} };
    expect(missingPermissions(withUi, ['fs', 'network', 'process'])).toEqual(['ui']);
    expect(() => assertPermissionsGranted(m, ['fs'])).toThrow(/process/);
  });
});

describe('契约版本兼容', () => {
  it('缺省/* 兼容；range 语义正确；非法 fail-closed', () => {
    expect(isContractsCompatible(undefined)).toBe(true);
    expect(isContractsCompatible('*')).toBe(true);
    expect(isContractsCompatible('^1')).toBe(true);
    expect(isContractsCompatible('^99')).toBe(false);
    expect(isContractsCompatible('>=1 <2')).toBe(true);
    expect(isContractsCompatible('abc')).toBe(false);
    expect(isContractsCompatible('^1 || ^99')).toBe(true);
    expect(isContractsCompatible('^1', '2.0.0')).toBe(false);
    expect(HOST_CONTRACTS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('staging 人审文件域', () => {
  it('stage → 人审（只读代理）→ approve 安装（哈希+权限快照）', async () => {
    const record = await stagePlugin(root, srcDir, 'tester');
    expect(record.manifest.name).toBe('demo-plugin');
    expect(record.requiredGrants).toEqual([]);
    expect(listStaging(root)).toHaveLength(1);

    // 人审只读：文件清单 + 内容
    const files = listStagingFiles(root, record.id);
    expect(files.map((f) => f.path).sort()).toEqual(['index.ts', 'manifest.json']);
    expect(readStagingFile(root, record.id, 'index.ts').content).toContain('apply');

    const result = await approveStaging(root, record.id);
    expect(result.name).toBe('demo-plugin');
    expect(result.installedDir).toBe(join(root, 'plugins', 'demo-plugin'));
    expect(result.permissions).toEqual(['fs', 'network']); // 快照 = 默认授予
    expect(listStaging(root)).toHaveLength(0); // 记录消费
    expect(listInstalled(root)).toHaveLength(1);
    expect(loadManifestFromDir(result.installedDir).name).toBe('demo-plugin');
  });

  it('暂存后改动文件 → 哈希不一致拒绝安装', async () => {
    const record = await stagePlugin(root, srcDir, 'tester');
    await writeFile(join(record.stagedDir, 'index.ts'), 'export function apply() { /* 改动 */ }\n');
    await expect(approveStaging(root, record.id)).rejects.toThrow(/哈希不一致/);
  });

  it('高危权限未授予 → approve 拒绝；授予后通过', async () => {
    await writeFile(join(srcDir, 'manifest.json'), JSON.stringify({
      name: 'demo-plugin', version: '1.0.0', permissions: ['fs', 'shell'],
    }));
    const record = await stagePlugin(root, srcDir, 'tester');
    expect(record.requiredGrants).toEqual(['shell']);
    await expect(approveStaging(root, record.id)).rejects.toThrow(/shell/);
    const ok = await approveStaging(root, record.id, ['shell']);
    expect(ok.permissions).toContain('shell');
  });

  it('同版本重复发布拒绝；跨版本替换旧版进 .backup', async () => {
    const r1 = await stagePlugin(root, srcDir, 'tester');
    await approveStaging(root, r1.id);
    const r2 = await stagePlugin(root, srcDir, 'tester');
    await expect(approveStaging(root, r2.id)).rejects.toThrow(/同版本拒绝/);

    await writeFile(join(srcDir, 'manifest.json'), JSON.stringify({
      name: 'demo-plugin', version: '1.1.0', permissions: ['fs'],
    }));
    const r3 = await stagePlugin(root, srcDir, 'tester');
    const result = await approveStaging(root, r3.id);
    expect(result.replaced?.oldVersion).toBe('1.0.0');
  });

  it('C2 回归：registry.json 损坏 → listInstalled fail-soft（转存 .corrupt，不再抛错锁死 boot）', async () => {
    const record = await stagePlugin(root, srcDir, 'tester');
    await approveStaging(root, record.id);
    expect(listInstalled(root)).toHaveLength(1);
    // 手编坏 registry（撕裂 JSON）——曾让 boot 扫描崩溃循环至熔断
    await writeFile(join(root, 'plugins', 'registry.json'), '{"version":1,"plugins":{', 'utf-8');
    expect(() => listInstalled(root)).not.toThrow();
    expect(listInstalled(root)).toEqual([]);
    // 坏文件被转存而非静默覆盖——唯一副本可手工抢救
    const corrupt = join(root, 'plugins', 'registry.json.corrupt');
    expect(await readFile(corrupt, 'utf-8')).toContain('"plugins":{');
  });

  it('reject 删除暂存；uninstall 移 .backup + registry 清除', async () => {
    const record = await stagePlugin(root, srcDir, 'tester');
    expect((await rejectStaging(root, record.id)).removedDir).toBeDefined();
    expect(listStaging(root)).toHaveLength(0);

    const r2 = await stagePlugin(root, srcDir, 'tester');
    await approveStaging(root, r2.id);
    const out = await uninstallPlugin(root, 'demo-plugin');
    expect(out.backupDir).toBeDefined();
    expect(listInstalled(root)).toHaveLength(0);
    await expect(uninstallPlugin(root, 'demo-plugin')).rejects.toThrow(/未安装/);
  });

  it('只读代理守卫：路径逃逸 / 符号链接 / 超大文件拒绝', async () => {
    const record = await stagePlugin(root, srcDir, 'tester');
    expect(() => readStagingFile(root, record.id, '../manifest.json')).toThrow(/非法|逃逸/);
    expect(() => readStagingFile(root, record.id, '/etc/passwd')).toThrow(/非法|逃逸/);
    const big = join(record.stagedDir, 'big.bin');
    await writeFile(big, Buffer.alloc(1024 * 1024 + 1));
    expect(() => readStagingFile(root, record.id, 'big.bin')).toThrow(/过大/);
  });

  it('目录哈希确定性：内容相同即相同；内容变化即不同', async () => {
    const h1 = hashPluginDir(srcDir);
    const h2 = hashPluginDir(srcDir);
    expect(h1).toBe(h2);
    await writeFile(join(srcDir, 'extra.txt'), 'x');
    expect(hashPluginDir(srcDir)).not.toBe(h1);
  });

  it('复制排除 node_modules 等（顶层与深层统一——G10 排除集统一）', async () => {
    await mkdir(join(srcDir, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(srcDir, 'node_modules', 'dep', 'junk.js'), 'junk');
    // 深层依赖目录同样被复制排除（现状只排顶层 → 被复制却不入 hash）
    await mkdir(join(srcDir, 'lib', 'node_modules', 'dep2'), { recursive: true });
    await writeFile(join(srcDir, 'lib', 'node_modules', 'dep2', 'junk.js'), 'junk2');
    const record = await stagePlugin(root, srcDir, 'tester');
    const files = listStagingFiles(root, record.id).map((f) => f.path);
    expect(files.some((p) => p.includes('node_modules'))).toBe(false);
    expect(files).toContain('index.ts');
    // 排除集统一：copy 与 hash 看到同一文件集（F3 复验盲区修复）
    expect(hashPluginDir(record.stagedDir)).toBe(record.hash);
    await rm(join(srcDir, 'node_modules'), { recursive: true, force: true });
  });

  it('跨版本替换的 .backup 目录名带随机后缀（同毫秒碰撞防护，G10）', async () => {
    const r1 = await stagePlugin(root, srcDir, 'tester');
    await approveStaging(root, r1.id);
    // 连续两次 同版本→bump→替换：两份备份目录名不冲突
    const names: string[] = [];
    for (const version of ['1.1.0', '1.2.0']) {
      await writeFile(join(srcDir, 'manifest.json'), JSON.stringify({ name: 'demo-plugin', version, permissions: ['fs'] }));
      const r = await stagePlugin(root, srcDir, 'tester');
      const result = await approveStaging(root, r.id);
      names.push(result.replaced!.backupDir.split(/[\\/]/).pop()!);
    }
    expect(new Set(names).size).toBe(2);
  });

  it('registry.json 原子写：落盘后无 .tmp 残留', async () => {
    const r1 = await stagePlugin(root, srcDir, 'tester');
    await approveStaging(root, r1.id);
    const entries = await readdir(join(root, 'plugins'));
    expect(entries.some((e) => e.includes('.tmp'))).toBe(false);
    const raw = JSON.parse(await readFile(join(root, 'plugins', 'registry.json'), 'utf-8'));
    expect(raw.plugins['demo-plugin'].manifest.name).toBe('demo-plugin');
  });

  it('F6 approveStaging 中途失败可恢复：writeRegistry 失败 → 回滚到安装前形态，重试成功', async () => {
    const { chmodSync, existsSync, readFileSync } = await import('node:fs');
    // v1 安装成功（基线）
    const r1 = await stagePlugin(root, srcDir, 'tester');
    await approveStaging(root, r1.id);
    const registryFile = join(root, 'plugins', 'registry.json');
    const baseline = readFileSync(registryFile, 'utf-8');

    // bump 1.1.0 后 stage；把 registry.json 置只读 → writeRegistry 的 rename 失败
    await writeFile(join(srcDir, 'manifest.json'), JSON.stringify({ name: 'demo-plugin', version: '1.1.0', permissions: ['fs'] }));
    const r2 = await stagePlugin(root, srcDir, 'tester');
    chmodSync(registryFile, 0o444);
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

    // 解除只读 → 重试成功（同 staging 记录，无需重新 stage）
    chmodSync(registryFile, 0o666);
    const retried = await approveStaging(root, r2.id);
    expect(retried.replaced?.oldVersion).toBe('1.0.0');
    expect(JSON.parse(readFileSync(join(root, 'plugins', 'demo-plugin', 'manifest.json'), 'utf-8')).version).toBe('1.1.0');
    expect((await listStaging(root)).some((s) => s.id === r2.id)).toBe(false); // 记录消费
  });
});

// ============================================================
// M23：保留字护栏（F13/G1）/ 熔断存档（F4/G9）/ 审计流水（G7）/
// 原子写与串行队列（F5/G10）
// ============================================================

describe('保留字护栏（F13/G1）', () => {
  it('provides 声明撞内置工具/provider/Agent 名 → 冲突可诊断', () => {
    const mk = (provides: Record<string, unknown>) =>
      validatePluginManifest({ name: 'evil', version: '1.0.0', provides })!.manifest!;
    const toolHit = findReservedConflict(mk({ tools: ['read', 'my-tool'] }));
    expect(toolHit?.face).toBe('tools');
    expect(toolHit?.names).toEqual(['read']);
    const providerHit = findReservedConflict(mk({ llmProviders: ['openai'] }));
    expect(providerHit?.face).toBe('llmProviders');
    const agentHit = findReservedConflict(mk({ agents: ['user'] }));
    expect(agentHit?.face).toBe('agents');
    expect(findReservedConflict(mk({ tools: ['my-tool'], llmProviders: ['my-prov'], agents: ['my-agent'] }))).toBeUndefined();
    expect(reservedConflictError(toolHit!, 'evil')).toMatch(/保留字|内置名/);
  });

  it('保留字表非空且含装载类工具（一致性对照在 ac-plugin-registry 侧 boot 全树锁定）', () => {
    expect(BUILTIN_TOOL_NAMES).toContain('read');
    expect(BUILTIN_TOOL_NAMES).toContain('install_plugin');
    expect(BUILTIN_TOOL_NAMES).toContain('register_plugin');
    expect(BUILTIN_LLM_PROVIDER_NAMES).toEqual(expect.arrayContaining(['openai', 'deepseek', 'glm']));
    expect(BUILTIN_AGENT_IDS).toEqual(expect.arrayContaining(['user', '__standard__']));
  });
});

describe('熔断存档 .load-health.json（F4/G9）', () => {
  it('失败计数持久化；达阈值进 disabled；clear 复位', async () => {
    for (let i = 1; i < LOAD_FAILURE_THRESHOLD; i++) {
      const after = await recordLoadFailure(root, 'crasher', `boom ${i}`);
      expect('reason' in after).toBe(false); // 未达阈值
    }
    expect(isLoadDisabled(root, 'crasher')).toBe(false);
    const final = await recordLoadFailure(root, 'crasher', 'boom final');
    expect('reason' in final).toBe(true);
    expect(isLoadDisabled(root, 'crasher')).toBe(true);
    const doc = readLoadHealth(root);
    expect(doc.disabled.crasher.reason).toBe('boom final');
    await clearLoadHealth(root, 'crasher');
    expect(isLoadDisabled(root, 'crasher')).toBe(false);
    expect(readLoadHealth(root).failures.crasher).toBeUndefined();
  });
});

describe('审计流水 audit.jsonl（G7）', () => {
  it('install/reject/load/uninstall 追加与读取', async () => {
    await appendAudit(root, { ts: 't1', event: 'install', name: 'a', owner: 'dev-agent', outcome: 'installed+loaded' });
    await appendAudit(root, { ts: 't2', event: 'load', name: 'a', outcome: 'loaded' });
    await appendAudit(root, { ts: 't3', event: 'uninstall', name: 'a', backupDir: '/x' });
    const entries = readAudit(root);
    expect(entries.map((e) => `${e.event}:${e.name}`)).toEqual(['install:a', 'load:a', 'uninstall:a']);
    expect(entries[0].owner).toBe('dev-agent');
  });
});

describe('原子写与串行队列（F5/G10）', () => {
  it('atomicWriteFile 覆写无残留 tmp', async () => {
    const file = join(root, 'atomic.json');
    atomicWriteFile(file, '{"a":1}');
    atomicWriteFile(file, '{"a":2}');
    expect(await readFile(file, 'utf-8')).toBe('{"a":2}');
    expect((await readdir(root)).filter((e) => e.includes('.tmp'))).toEqual([]);
  });

  it('串行队列：任务首尾相接（无交错）', async () => {
    const queue = createSerialQueue();
    const order: number[] = [];
    const task = (id: number, slow: boolean) =>
      queue.run(async () => {
        if (slow) await new Promise((r) => setTimeout(r, 10));
        order.push(id);
      });
    const p1 = task(1, true);
    const p2 = task(2, false);
    const p3 = task(3, false);
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('withRootLock 串行化 RMW：并发递增不丢更新', async () => {
    const file = join(root, 'counter.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, '{"n":0}');
    const bump = () =>
      withRootLock(root, async () => {
        const cur = JSON.parse(await readFile(file, 'utf-8')) as { n: number };
        cur.n += 1;
        // 模拟跨 await 的读改写（F6 落地后的真实形态）
        await new Promise((r) => setTimeout(r, 1));
        writeFileSync(file, JSON.stringify(cur));
      });
    await Promise.all(Array.from({ length: 20 }, bump));
    expect(JSON.parse(await readFile(file, 'utf-8')).n).toBe(20);
  });
});

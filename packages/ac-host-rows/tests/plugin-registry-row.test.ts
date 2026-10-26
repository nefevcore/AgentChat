// ============================================================
// 宿主 plugin-registry 行单测（cr-543）：装载裁决（install = 授权动作 →
// 壳行集条目物化）+ 熔断闸门（壳侧回报 → 行集剔除）+ 行集偏好急救 +
// staging 人审链路。数据根恒 sandbox（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, FiberStates, Service, type Fiber } from '@agentchat/cordis';
import { readPluginRows } from 'ac-rowset-core';
import { makePluginRegistryRow, PluginRegistryHostService } from '../src/index.ts';

const ROOT = path.join('sandbox', 'test-host-plugin-registry-' + process.pid);
const SRC = path.join('sandbox', 'test-host-plugin-src-' + process.pid);

/** 最小出厂目录（撞名对账用：backup 为出厂宿主行） */
function writeCatalog(root: string): string {
  const file = path.join(root, 'row-catalog.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    rows: [
      { id: 'backup', tree: 'host', role: '数据轴备份' },
      { id: 'usage', tree: 'host', role: '计费聚合' },
    ],
  }, null, 2) + '\n', 'utf-8');
  return file;
}

/** 造插件源目录（manifest.rows 声明行集条目） */
function makePluginDir(name: string, rows: unknown[], extra: Record<string, unknown> = {}): string {
  const dir = path.join(SRC, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    name,
    version: '1.0.0',
    entry: 'index.ts',
    permissions: ['fs'],
    rows,
    ...extra,
  }, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'index.ts'), 'export function apply(): void { /* demo */ }\n', 'utf-8');
  return dir;
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(SRC, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(SRC, { recursive: true });
  writeCatalog(ROOT);
});
afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(SRC, { recursive: true, force: true });
});

interface RpcHandler {
  (params?: unknown, caller?: unknown): unknown;
}

/** webServer 捕获桩：只承载本行用到的 registerRpc / broadcast 契约面 */
class StubWebServer extends Service {
  readonly handlers = new Map<string, RpcHandler>();
  readonly frames: Array<{ type: string; data?: unknown }> = [];
  constructor(ctx: Context) {
    super(ctx, 'webServer');
  }
  registerRpc(method: string, handler: RpcHandler) {
    if (this.handlers.has(method)) throw new Error('rpc 已注册: ' + method);
    this.handlers.set(method, handler);
    return this.ctx.fiber.effect(() => {
      this.handlers.set(method, handler);
      return () => { this.handlers.delete(method); };
    }, 'webServer.rpc(' + method + ')');
  }
  broadcast(type: string, data?: unknown): void {
    this.frames.push({ type, data });
  }
  async call(method: string, params?: unknown): Promise<unknown> {
    const handler = this.handlers.get(method);
    if (handler === undefined) throw new Error('unknown method: ' + method);
    return handler(params, {});
  }
}

/** 装配：webServer 桩先行（本行 inject ['webServer']），行 fiber 断言 ACTIVE */
async function boot() {
  const ctx = new Context();
  const webFiber = ctx.plugin(class extends StubWebServer { constructor(c: Context) { super(c); } });
  await webFiber;
  const fiber = ctx.plugin(makePluginRegistryRow({ dataRoot: ROOT, catalogFile: path.join(ROOT, 'row-catalog.json') }));
  await fiber;
  expect(fiber.state).toBe(FiberStates.ACTIVE);
  return {
    web: (ctx as unknown as { webServer: StubWebServer }).webServer,
    registry: (ctx as unknown as { pluginRegistry: PluginRegistryHostService }).pluginRegistry,
    fibers: [webFiber, fiber] as Fiber[],
    async dispose() {
      for (const f of [fiber, webFiber]) if (f.uid !== null) await f.dispose();
    },
  };
}

describe('宿主 plugin-registry 行（装载裁决 + 编排）', () => {
  it('staging 人审全链：stage → 暂存清单/只读代理 → approve → 安装态 + 插件行集物化', async () => {
    const h = await boot();
    try {
      const dir = makePluginDir('demo-plugin', [{ id: 'demo-tools', tools: ['demo_hello'], role: '演示工具行' }]);
      const staging = await h.registry.stage(dir, 'user');
      expect(staging.manifest.name).toBe('demo-plugin');
      expect(h.registry.stagingRecords().map((r) => r.id)).toEqual([staging.id]);
      // 人审只读代理（未审副本可读，安装前绝不下发）
      expect(h.registry.stagingFiles(staging.id).map((f) => f.path)).toContain('manifest.json');
      expect(h.registry.stagingFile(staging.id, 'manifest.json').content).toContain('demo-plugin');

      const approved = await h.registry.approve(staging.id);
      expect(approved.approved.manifest.version).toBe('1.0.0');
      expect(h.registry.stagingRecords()).toEqual([]);
      // 安装目录 = 插件库根下 <name>（client manifest 注入的扫描源）
      expect(fs.existsSync(path.join(ROOT, 'plugins', 'demo-plugin', 'manifest.json'))).toBe(true);
      // 插件行集条目：树归属恒 shell + 路径恒安装目录（单源）
      expect(approved.rows).toEqual([{
        id: 'demo-tools',
        tree: 'shell',
        tools: ['demo_hello'],
        role: '演示工具行',
        path: path.join(path.resolve(ROOT), 'plugins', 'demo-plugin'),
      }]);
      // 物化文件（壳 boot 合并输入）
      expect(readPluginRows(ROOT)).toEqual(approved.rows);
      // 装载裁决：已安装可装；未安装不可装（fail-closed）
      expect(h.registry.canLoad('demo-plugin')).toBe(true);
      expect(h.registry.canLoad('ghost')).toBe(false);
    } finally {
      await h.dispose();
    }
  });

  it('撞名出厂行丢弃（保留字护栏）+ 非法行条目告警跳过', async () => {
    const h = await boot();
    try {
      const dir = makePluginDir('clash-plugin', [
        { id: 'backup', tools: ['hijack'] },
        { id: 'Bad Id', tools: ['x'] },
        { id: 'clash-tools', tools: ['clash_hello'] },
      ]);
      const staging = await h.registry.stage(dir, 'user');
      const approved = await h.registry.approve(staging.id);
      expect(approved.rows.map((r) => r.id)).toEqual(['clash-tools']);
      expect(approved.warnings.join('\n')).toMatch(/撞名/);
      expect(approved.warnings.join('\n')).toMatch(/id 非法/);
    } finally {
      await h.dispose();
    }
  });

  it('熔断闸门：装载失败回报 ×3 → 熔断 → 行集剔除；清记录恢复', async () => {
    const h = await boot();
    try {
      const dir = makePluginDir('fragile-plugin', [{ id: 'fragile-tools', tools: ['fragile_hello'] }]);
      const staging = await h.registry.stage(dir, 'user');
      await h.registry.approve(staging.id);
      expect(h.registry.pluginRows().rows.map((r) => r.id)).toEqual(['fragile-tools']);

      const first = await h.registry.reportLoadFailure('fragile-plugin', 'import 失败：语法错');
      expect(first).toEqual({ disabled: false, count: 1 });
      await h.registry.reportLoadFailure('fragile-plugin', 'import 失败：语法错');
      const third = await h.registry.reportLoadFailure('fragile-plugin', 'import 失败：语法错');
      expect(third).toEqual({ disabled: true, count: 3 });
      // 熔断 = 行集条目剔除（fail-closed）+ 装载裁决拒绝
      expect(h.registry.canLoad('fragile-plugin')).toBe(false);
      expect(h.registry.pluginRows().rows).toEqual([]);
      expect(readPluginRows(ROOT)).toEqual([]);
      expect(h.registry.loadHealth().disabled['fragile-plugin']).toBeTruthy();
      // 审计流水入账（install + load 失败）
      const audit = fs.readFileSync(path.join(ROOT, 'plugins', 'audit.jsonl'), 'utf-8');
      expect(audit).toContain('"event":"install"');
      expect(audit).toContain('"outcome":"disabled"');

      await h.registry.clearLoadHealthFor('fragile-plugin');
      expect(h.registry.pluginRows().rows.map((r) => r.id)).toEqual(['fragile-tools']);
    } finally {
      await h.dispose();
    }
  });

  it('卸载：安装态移除 + 行集条目撤销 + 旧目录进 .backup', async () => {
    const h = await boot();
    try {
      const dir = makePluginDir('gone-plugin', [{ id: 'gone-tools', tools: ['gone_hello'] }]);
      const staging = await h.registry.stage(dir, 'user');
      await h.registry.approve(staging.id);
      const uninstalled = await h.registry.uninstall('gone-plugin');
      expect(uninstalled.rows).toEqual([]);
      expect(h.registry.listInstalled()).toEqual([]);
      expect(uninstalled.backupDir !== undefined ? fs.existsSync(uninstalled.backupDir) : false).toBe(true);
      expect(readPluginRows(ROOT)).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  it('行集偏好急救：rows/set 写偏好文件（只记差异）→ 视图合成 → reset 复位', async () => {
    const h = await boot();
    try {
      expect(h.registry.hostRows().rows.map((r) => r.id)).toEqual(['backup', 'usage']);
      const view = h.registry.setRowPreference('backup', true);
      // 全列出（含被停用行——急救面要能重新打开）
      expect(view.rows).toEqual([
        { id: 'backup', disabled: true, role: '数据轴备份' },
        { id: 'usage', disabled: false, role: '计费聚合' },
      ]);
      expect(h.registry.rowPreferences()).toEqual([{ id: 'backup', disabled: true }]);
      expect(fs.existsSync(path.join(ROOT, 'host-rows.json'))).toBe(true);
      // 复原 = 删条目（偏好文件只记差异，不留 disabled:false 噪声）
      h.registry.setRowPreference('backup', false);
      expect(h.registry.rowPreferences()).toEqual([]);
      expect(h.registry.hostRows().rows.map((r) => r.id)).toEqual(['backup', 'usage']);
      h.registry.setRowPreference('usage', true);
      expect(h.registry.resetRowPreferences().rows.map((r) => r.id)).toEqual(['backup', 'usage']);
      expect(h.registry.rowPreferences()).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  it('RPC 面在册 + 变更帧：安装广播 plugin/updated，行偏好恒冷生效', async () => {
    const h = await boot();
    try {
      expect([...h.web.handlers.keys()].sort()).toEqual([
        'plugin/approve', 'plugin/installed', 'plugin/load-failure', 'plugin/load-health',
        'plugin/load-health-clear', 'plugin/permissions', 'plugin/reject', 'plugin/rows',
        'plugin/stage', 'plugin/staging-file', 'plugin/staging-files', 'plugin/staging-list',
        'plugin/uninstall', 'rows/list', 'rows/reset', 'rows/set',
      ]);
      const dir = makePluginDir('rpc-plugin', [{ id: 'rpc-tools', tools: ['rpc_hello'] }]);
      const staged = await h.web.call('plugin/stage', { dir, owner: 'user' }) as { staging: { id: string } };
      await h.web.call('plugin/approve', { id: staged.staging.id });
      // 安装 = 变更帧（前端 boot graph 重拉 diff——client manifest 注入面）
      expect(h.web.frames.map((frame) => frame.type)).toContain('plugin/updated');
      const installed = await h.web.call('plugin/installed') as { installed: unknown[]; rows: Array<{ id: string }> };
      expect(installed.installed.length).toBe(1);
      expect(installed.rows.map((row) => row.id)).toEqual(['rpc-tools']);

      const set = await h.web.call('rows/set', { id: 'backup', disabled: true }) as {
        state: string; restartRequired: boolean; rows: Array<{ id: string; disabled: boolean }>;
      };
      expect(set.state).toBe('written');
      // 恒冷生效（〈patch 机制退役〉——无热通道）
      expect(set.restartRequired).toBe(true);
      expect(set.rows.find((row) => row.id === 'backup')?.disabled).toBe(true);
      const health = await h.web.call('plugin/load-health') as { disabled: Record<string, unknown> };
      expect(health.disabled).toEqual({});
      const cleared = await h.web.call('rows/reset') as { state: string };
      expect(cleared.state).toBe('reset');
    } finally {
      await h.dispose();
    }
  });
});

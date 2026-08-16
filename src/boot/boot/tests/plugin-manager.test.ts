// ============================================================
// P1 测试：makePluginManager 新契约（getAssembly/saveAssembly/
// getCatalog/library/session + 旧契约归一化 + 事件）
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Context } from '@agentchat/cordis';
import { ToolsService } from '@agentchat/tools';
import { HooksService } from '@agentchat/hooks';
import { AgentRegistry } from '@agentchat/agents';
import type { AgentConfig } from '@agentchat/agent-config';
import { getOrCreatePluginHost } from '@agentchat/plugins';
import { makePluginManager, loadGlobalConfig } from '../src/loader';
import type { PluginManager } from '@agentchat/server/src/api/plugins';

function writeDevPlugin(ws: string, agentId: string, name: string, extraManifest: Record<string, unknown> = {}): string {
  const dir = path.join(ws, 'plugins', agentId, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    name, version: '1.0.0', entry: 'index.mjs',
    provides: { tools: [`${name}_tool`], hooks: [`${name}.hook`] },
    ...extraManifest,
  }, null, 2), 'utf-8');
  fs.writeFileSync(path.join(dir, 'index.mjs'), `
export const name = '${name}';
export function apply(ctx) {
  if (ctx.get?.('tools')) ctx.tools.register('${name}', [{ name: '${name}_tool', label: '${name} tool', requires: ['base'],
    definition: { type: 'function', function: { name: '${name}_tool', description: 'fixture', parameters: { type: 'object', properties: {} } } },
    execute: async () => 'ok' }]);
  if (ctx.get?.('hooks')) ctx.hooks.register('runStart', '${name}.hook', () => async () => {}, '${name}');
}
`, 'utf-8');
  return dir;
}

function makeCtx(): Context {
  const ctx = new Context();
  new ToolsService(ctx);
  new HooksService(ctx);
  return ctx;
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-manager-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedAgentConfig(config: Record<string, unknown>): string {
  const dir = path.join(tmp, 'agents', String(config.agent_id ?? 'a'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return file;
}

function makeEnv(agentService?: { hotReloadAgent(agentId: string, agentDir: string): void }): {
  ctx: Context;
  registry: AgentRegistry;
  globalConfig: Record<string, any>;
  manager: PluginManager;
  events: Array<{ type: string; data: any }>;
} {
  const ctx = makeCtx();
  const host = getOrCreatePluginHost(ctx);
  const events: Array<{ type: string; data: any }> = [];
  host.attachEventSink((type, data) => events.push({ type, data }));

  ctx.tools.register('agentchat-fs-tools', [{
    name: 'read', label: '读取', description: 'read file', requires: ['base'],
    definition: { type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object', properties: {} } } },
    execute: async () => 'content',
  }]);
  ctx.hooks.register('runStart', 'agentchat-fs-tools.init', () => async () => {}, 'agentchat-fs-tools');
  ctx.hooks.register('stepEnd', 'agentchat-fs-tools.persist', () => async () => {}, 'agentchat-fs-tools', true);

  const registry = new AgentRegistry();
  const globalConfig = loadGlobalConfig(tmp);
  const manager = makePluginManager(registry, globalConfig, ctx, { agentService });
  return { ctx, registry, globalConfig, manager, events };
}

describe('getAssembly / getCatalog（新契约）', () => {
  it('catalog 以注册中心为单真相源：builtin/dev 合并 + provides 声明与反查合并', () => {
    const { manager } = makeEnv();
    writeDevPlugin(tmp, 'admin', 'dev-demo');

    const catalog = manager.getCatalog();
    const builtin = catalog.plugins.find((p) => p.name === 'agentchat-fs-tools');
    expect(builtin?.source).toBe('builtin');
    expect(builtin?.provides?.tools).toContain('read');
    expect(builtin?.provides?.hooks).toContain('agentchat-fs-tools.init');

    const dev = catalog.plugins.find((p) => p.name === 'dev-demo');
    expect(dev?.source).toBe('dev');
    expect(dev?.owner).toBe('admin');
    expect(dev?.provides).toEqual({ tools: ['dev-demo_tool'], hooks: ['dev-demo.hook'] });
    expect(catalog.tools.some((t) => t.name === 'read' && t.owner === 'agentchat-fs-tools')).toBe(true);
    const automaticHook = catalog.hooks.find((h) => h.name === 'agentchat-fs-tools.persist');
    expect(automaticHook).toMatchObject({ kind: 'stepEnd', automatic: true });
  });

  it('getAssembly：presets/hooks 启用清单/tools include-exclude + available 过滤', () => {
    const { registry, manager } = makeEnv();
    writeDevPlugin(tmp, 'admin', 'dev-demo');
    registry.register({
      agent_id: 'a', name: 'A', tags: ['agent'],
      presets: ['agentchat-fs-tools'],
      tools: { include: ['read'] },
      hooks: { runStart: ['agentchat-fs-tools.init', 'dev-demo.hook'] },
    } as AgentConfig);

    const assembly = manager.getAssembly('a')!;
    expect(assembly.presets).toEqual(['agentchat-fs-tools']);
    expect(assembly.tools.include).toEqual(['read']);
    expect(assembly.tools.enabled).toContain('read');
    expect(assembly.hooks.order.runStart).toEqual(['agentchat-fs-tools.init', 'dev-demo.hook']);
    expect(assembly.available.find((p) => p.name === 'dev-demo')).toBeTruthy();
    expect(assembly.available.find((p) => p.source === 'builtin')).toBeUndefined();
    expect(assembly.legacy).toBeUndefined();
  });
});

describe('saveAssembly（PUT 契约 + 旧契约归一化 + 事件）', () => {
  it('保存装配字段（tools {include,exclude}/hooks 启用清单）：原子写盘 + hotReload + 事件', () => {
    seedAgentConfig({ agent_id: 'a', name: 'A', tags: ['agent'], presets: ['agentchat-fs-tools'], tools: { include: ['read'] } });
    let reloaded = 0;
    const { registry, manager, events } = makeEnv({
      hotReloadAgent: () => {
        reloaded++;
        const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'agents', 'a', 'config.json'), 'utf-8'));
        registry.register({
          agent_id: 'a', name: 'A', tags: ['agent'],
          presets: raw.presets ?? [], tools: raw.tools ?? {}, hooks: raw.hooks ?? {},
        } as AgentConfig);
      },
    });
    registry.register({ agent_id: 'a', name: 'A', tags: ['agent'], presets: ['agentchat-fs-tools'], tools: { include: ['read'] } } as AgentConfig);

    const saved = manager.saveAssembly('a', {
      presets: ['agentchat-fs-tools'],
      tools: { include: ['read'], exclude: ['bash'] },
      hooks: { runStart: ['agentchat-fs-tools.init'] },
    });
    expect(saved.success).toBe(true);
    expect(saved.assembly.tools.include).toEqual(['read']);
    expect(saved.assembly.tools.exclude).toEqual(['bash']);
    expect(saved.assembly.tools.enabled).toContain('read');
    expect(saved.assembly.hooks.order.runStart).toEqual(['agentchat-fs-tools.init']);
    expect(reloaded).toBe(1);
    expect(events.some((e) => e.type === 'agent.assembly.changed' && e.data.agentId === 'a')).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'agents', 'a', 'config.json'), 'utf-8'));
    expect(onDisk.presets).toEqual(['agentchat-fs-tools']);
    expect(onDisk.tools).toEqual({ include: ['read'], exclude: ['bash'] });
    expect(onDisk.disabledTools).toBeUndefined();
    expect(onDisk.hooks.runStart).toEqual(['agentchat-fs-tools.init']);
    expect(onDisk.disabledHooks).toBeUndefined();
  });

  it('旧 tools[]/disabledTools/disabledHooks 保存时迁移为新契约', () => {
    seedAgentConfig({
      agent_id: 'a', name: 'A', tags: ['agent'], presets: ['agentchat-fs-tools'],
      tools: ['read'], disabledTools: ['bash'],
      hooks: { runStart: ['agentchat-fs-tools.init', 'agentchat-fs-tools.off'] },
      disabledHooks: { runStart: ['agentchat-fs-tools.off'] },
    });
    const { registry, manager } = makeEnv({
      hotReloadAgent: () => {
        const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'agents', 'a', 'config.json'), 'utf-8'));
        registry.register({
          agent_id: 'a', name: 'A', tags: ['agent'],
          presets: raw.presets ?? [], tools: raw.tools ?? {}, hooks: raw.hooks ?? {},
        } as AgentConfig);
      },
    });
    registry.register({
      agent_id: 'a', name: 'A', tags: ['agent'], presets: ['agentchat-fs-tools'],
      tools: ['read'], disabledTools: ['bash'],
      hooks: { runStart: ['agentchat-fs-tools.init', 'agentchat-fs-tools.off'] },
      disabledHooks: { runStart: ['agentchat-fs-tools.off'] },
    } as AgentConfig);

    const saved = manager.saveAssembly('a', {});
    expect(saved.migrated).toBe(true);
    expect(saved.assembly.tools.include).toEqual(['read']);
    expect(saved.assembly.tools.exclude).toEqual(['bash']);
    expect(saved.assembly.hooks.order.runStart).toEqual(['agentchat-fs-tools.init']);

    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'agents', 'a', 'config.json'), 'utf-8'));
    expect(onDisk.tools).toEqual({ include: ['read'], exclude: ['bash'] });
    expect(onDisk.disabledTools).toBeUndefined();
    expect(onDisk.disabledHooks).toBeUndefined();
  });

  it('插件拆分迁移：admin 存量配置自动补 agentchat-plugin-tools + 标签 agent→base', () => {
    seedAgentConfig({
      agent_id: 'a', name: 'A', tags: ['admin', 'agent'],
      presets: ['agentchat-dev-tools'],
    });
    const { registry, manager } = makeEnv({
      hotReloadAgent: () => {
        const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'agents', 'a', 'config.json'), 'utf-8'));
        registry.register({
          agent_id: 'a', name: 'A',
          tags: raw.tags ?? [], presets: raw.presets ?? [], tools: raw.tools ?? {}, hooks: raw.hooks ?? {},
        } as AgentConfig);
      },
    });
    registry.register({
      agent_id: 'a', name: 'A', tags: ['admin', 'agent'], presets: ['agentchat-dev-tools'],
    } as AgentConfig);

    const saved = manager.saveAssembly('a', {});
    expect(saved.migrated).toBe(true);
    expect(saved.assembly.presets).toContain('agentchat-plugin-tools');
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'agents', 'a', 'config.json'), 'utf-8'));
    expect(onDisk.presets).toContain('agentchat-plugin-tools');
    expect(onDisk.tags).toEqual(['admin', 'base']);
  });

  it('GET 旧 plugins 契约动态展示 legacy 标记；PUT 保存后归一化迁移并删除 plugins', () => {
    seedAgentConfig({
      agent_id: 'a', name: 'A', tags: ['agent'],
      plugins: [{ name: 'legacy', tools: ['read'], runStart: ['agentchat-fs-tools.init'] }],
    });
    const { registry, manager } = makeEnv({
      hotReloadAgent: () => {
        const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'agents', 'a', 'config.json'), 'utf-8'));
        registry.register({
          agent_id: 'a', name: 'A', tags: ['agent'],
          presets: raw.presets ?? [], tools: raw.tools ?? {}, hooks: raw.hooks ?? {},
        } as AgentConfig);
      },
    });
    registry.register({
      agent_id: 'a', name: 'A', tags: ['agent'],
      plugins: [{ name: 'legacy', tools: ['read'], runStart: ['agentchat-fs-tools.init'] }],
    } as AgentConfig);

    const view = manager.getAssembly('a')!;
    expect(view.legacy?.hasPlugins).toBe(true);
    expect(view.tools.include).toEqual(['read']);
    expect(view.presets).toContain('agentchat-fs-tools');

    const saved = manager.saveAssembly('a', {});
    expect(saved.migrated).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'agents', 'a', 'config.json'), 'utf-8'));
    expect(onDisk.plugins).toBeUndefined();
    expect(onDisk.presets).toContain('agentchat-fs-tools');
    expect(manager.getAssembly('a')?.legacy).toBeUndefined();
  });

  it('非法 patch（未知 hooks 阶段）返回 400 语义错误', () => {
    const { registry, manager } = makeEnv();
    registry.register({ agent_id: 'a', name: 'A', tags: ['agent'] } as AgentConfig);
    seedAgentConfig({ agent_id: 'a', name: 'A' });
    expect(() => manager.saveAssembly('a', { hooks: { nope: ['x'] } as any })).toThrow(/未知阶段/);
  });
});

describe('插件库 / 会话（library/session）', () => {
  it('stage → approve → uninstall 全流程 + 事件广播', async () => {
    const { registry, manager, events } = makeEnv();
    registry.register({ agent_id: 'a', name: 'A', tags: ['agent'] } as AgentConfig);
    const dir = writeDevPlugin(tmp, 'admin', 'lib-demo');

    const staged = manager.stagePlugin(dir, 'admin');
    expect(staged.requiredGrants).toEqual([]);
    expect(manager.getLibrary().staging).toHaveLength(1);
    expect(events.some((e) => e.type === 'plugin.catalog.changed' && e.data.kind === 'staging')).toBe(true);

    const installed = await manager.approvePlugin(staged.id);
    expect(installed.source).toBe('installed');
    expect(manager.getLibrary().installed.some((p) => p.name === 'lib-demo')).toBe(true);

    const result = await manager.uninstallPlugin('lib-demo');
    expect(result.success).toBe(true);
    expect(result.backupDir).toBeTruthy();
    expect(manager.getLibrary().installed).toHaveLength(0);
  });

  it('会话插件列表 / reload / unload / dev 目录注册', async () => {
    const { ctx, manager, registry } = makeEnv();
    void ctx;
    registry.register({ agent_id: 'a', name: 'A', tags: ['agent'] } as AgentConfig);
    const dir = writeDevPlugin(tmp, 'a', 'session-demo');

    const registered = await manager.registerSessionPlugin(dir, 'a');
    expect(registered.status).toBe('loaded');
    expect(registered.plugin.source).toBe('session');
    expect(registered.plugin.dir).toBe(dir);

    expect(manager.getSessionPlugins().map((p) => p.name)).toEqual(['session-demo']);
    const reloaded = await manager.reloadSessionPlugin('session-demo');
    expect(reloaded.status).toBe('replaced');
    await manager.unloadSessionPlugin('session-demo');
    expect(manager.getSessionPlugins()).toHaveLength(0);
  });

  it('dev 注册/卸载会话插件时同步 owner Agent presets（register_plugin 语义）', async () => {
    seedAgentConfig({ agent_id: 'a', name: 'A', tags: ['agent'], presets: [] });
    const { registry, manager } = makeEnv({
      hotReloadAgent: () => {
        const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'agents', 'a', 'config.json'), 'utf-8'));
        registry.register({
          agent_id: 'a', name: 'A', tags: ['agent'],
          presets: raw.presets ?? [], tools: raw.tools ?? {}, hooks: raw.hooks ?? {},
        } as AgentConfig);
      },
    });
    registry.register({ agent_id: 'a', name: 'A', tags: ['agent'], presets: [] } as AgentConfig);
    const dir = writeDevPlugin(tmp, 'a', 'session-demo');

    await manager.registerSessionPlugin(dir, 'a');
    let disk = JSON.parse(fs.readFileSync(path.join(tmp, 'agents', 'a', 'config.json'), 'utf-8'));
    expect(disk.presets).toContain('session-demo');

    await manager.unloadSessionPlugin('session-demo');
    disk = JSON.parse(fs.readFileSync(path.join(tmp, 'agents', 'a', 'config.json'), 'utf-8'));
    expect(disk.presets ?? []).not.toContain('session-demo');
  });
});

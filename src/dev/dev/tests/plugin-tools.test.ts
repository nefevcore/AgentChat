// ============================================================
// @agentchat/dev plugin-tools 端到端测试：
// register_plugin（会话级 + presets 写入 + reload 中断）/ unregister /
// publish_plugin（stage → approve → 插件库 registry）
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Context } from '@agentchat/cordis';
import { ToolsService } from '@agentchat/tools';
import { HooksService } from '@agentchat/hooks';
import { PluginHost } from '@agentchat/plugins';
import { ToolInterrupt } from '@agentchat/agent-loop';
import type { AgentConfig } from '@agentchat/agent-config';
import type { ToolContext } from '@agentchat/tools';
import { makeRegisterPluginTool, makeUnregisterPluginTool, makePublishPluginTool } from '../src/plugin-tools';

const FIXTURE_MJS = `
export const name = 'my-plugin';
export const inject = ['tools', 'hooks'];
export function apply(ctx) {
  ctx.tools.register('my-plugin', [{
    name: 'plugged_tool', label: '插件工具', description: 'fixture tool',
    requires: ['agent'],
    definition: { type: 'function', function: { name: 'plugged_tool', description: 'fixture tool', parameters: { type: 'object', properties: {} } } },
    execute: async () => 'plugged',
  }]);
  ctx.hooks.register('runStart', 'my-plugin.hook', () => async () => {}, 'my-plugin');
}
`;

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-plugins-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeEnv(): { ctx: Context; host: PluginHost; config: AgentConfig; services: ToolContext } {
  const ws = tmp;
  const agentsDir = path.join(ws, 'agents');
  fs.mkdirSync(path.join(agentsDir, 't1'), { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 't1', 'config.json'), JSON.stringify({
    agent_id: 't1', name: '测试', tags: ['admin'], presets: [],
  }, null, 2), 'utf-8');
  // 开发插件目录：<ws>/plugins/t1/my-plugin
  const pluginDir = path.join(ws, 'plugins', 't1', 'my-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({
    name: 'my-plugin', version: '1.0.0', entry: 'index.mjs', inject: ['tools', 'hooks'],
  }, null, 2), 'utf-8');
  fs.writeFileSync(path.join(pluginDir, 'index.mjs'), FIXTURE_MJS, 'utf-8');

  const ctx = new Context();
  new ToolsService(ctx);
  new HooksService(ctx);
  const host = new PluginHost(ctx);
  const config: AgentConfig = { agent_id: 't1', name: '测试', tags: ['admin'] } as AgentConfig;
  const services: ToolContext = { workspaceDir: ws, agentsDir };
  return { ctx, host, config, services };
}

describe('register_plugin / unregister_plugin（dev 闭环）', () => {
  it('register_plugin：动态加载 + presets 写入 + 抛出 reload 中断', async () => {
    const { ctx, host, config, services } = makeEnv();
    const reg = makeRegisterPluginTool(host, config, services);

    await expect(reg.execute({ name: 'my-plugin' } as never)).rejects.toBeInstanceOf(ToolInterrupt);

    // 插件已装载；presets 已持久化
    expect(host.has('my-plugin')).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'agents', 't1', 'config.json'), 'utf-8'));
    expect(saved.presets).toContain('my-plugin');

    // 烘焙链路：presets 引用后工具/钩子可见
    const effective: AgentConfig = { agent_id: 't1', name: '测试', tags: ['admin'], presets: ['my-plugin'] } as AgentConfig;
    expect(ctx.tools.resolveTools(undefined, effective, {}).has('plugged_tool')).toBe(true);
    expect(ctx.hooks.collect({ runStart: ['my-plugin.hook'] }, effective, {}).runStartHook).toHaveLength(1);
  });

  it('unregister_plugin：卸载会话级插件 + 回收 presets + reload 中断', async () => {
    const { host, config, services } = makeEnv();
    const reg = makeRegisterPluginTool(host, config, services);
    await expect(reg.execute({ name: 'my-plugin' } as never)).rejects.toBeInstanceOf(ToolInterrupt);

    const unreg = makeUnregisterPluginTool(host, config, services);
    await expect(unreg.execute({ name: 'my-plugin' } as never)).rejects.toBeInstanceOf(ToolInterrupt);

    expect(host.has('my-plugin')).toBe(false);
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'agents', 't1', 'config.json'), 'utf-8'));
    expect(saved.presets).not.toContain('my-plugin');
  });
});

describe('publish_plugin（stage → approve）', () => {
  it('stage 校验暂存；approve 安装进插件库并即时装载', async () => {
    const { ctx, host, config, services } = makeEnv();
    const publish = makePublishPluginTool(host, config, services);

    const stagedRes = await publish.execute({ action: 'stage', name: 'my-plugin' } as never) as string;
    const staged = JSON.parse(stagedRes);
    expect(staged.status).toBe('ok');
    const id = staged.data.id as string;
    expect(fs.existsSync(path.join(tmp, 'plugins', '.staging', id, 'manifest.json'))).toBe(true);

    const approveRes = await publish.execute({ action: 'approve', id } as never) as string;
    const approved = JSON.parse(approveRes);
    expect(approved.status).toBe('ok');
    expect(fs.existsSync(path.join(tmp, 'plugins', 'registry.json'))).toBe(true);
    expect(host.get('my-plugin')?.sessionOnly).toBe(false);

    const effective: AgentConfig = { agent_id: 't1', name: '测试', tags: ['admin'], presets: ['my-plugin'] } as AgentConfig;
    expect(ctx.tools.resolveTools(undefined, effective, {}).has('plugged_tool')).toBe(true);
  });

  it('list 展示待审；同版本重复 approve 被拒绝', async () => {
    const { host, config, services } = makeEnv();
    const publish = makePublishPluginTool(host, config, services);
    const id1 = (JSON.parse(await publish.execute({ action: 'stage', name: 'my-plugin' } as never) as string)).data.id as string;
    const id2 = (JSON.parse(await publish.execute({ action: 'stage', name: 'my-plugin' } as never) as string)).data.id as string;

    const list = JSON.parse(await publish.execute({ action: 'list' } as never) as string);
    expect(list.data.count).toBe(2);

    await publish.execute({ action: 'approve', id: id1 } as never);
    const dup = JSON.parse(await publish.execute({ action: 'approve', id: id2 } as never) as string);
    expect(dup.status).toBe('error');
    expect(dup.data.message).toContain('同版本拒绝');
  });
});

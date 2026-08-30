// ============================================================
// @agentchat/dev/src/plugin-tools.ts —— 插件开发闭环工具
//
//   register_plugin   ：workspace 开发插件 → 会话级动态加载（admin；重启即失）
//   unregister_plugin ：卸载会话级插件并回收 presets 引用（admin）
//
// 发布路径（publish_plugin 工具已移除）：开发完成的插件提交 git 并挂
// topic:agentchat-plugin，宿主经市场安装（staging 人审 + grants 边界在
// 市场路径统一保持）；本地暂存发布仍可经 WebUI 开发目录 tab 人工触发。
//
// 安全边界：
//   · 两者均 requires:[CAPABILITY_ADMIN]；
//   · register_plugin 动态 import = 插件代码进宿主进程，仅会话级、不落盘为
//     启动扫描记录（重启即失）；持久安装只走市场/人工 WebUI 路径。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { defineTool, workspaceRoot } from '@agentchat/toolkit';
import { ToolInterrupt } from '@agentchat/agent-loop';
import { CAPABILITY_ADMIN, resolveAgentDir, type AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';
import type { ToolContext } from '@agentchat/tools';
import {
  PluginHost,
  grantPermissions,
  loadManifestFromDir,
} from '@agentchat/plugins';

/** 找到 Agent 配置文件路径（优先按 agent_id 反查目录） */
function agentConfigPath(services: ToolContext, agentId: string): string {
  const agentsDir = services.agentsDir ?? path.join(services.workspaceDir ?? workspaceRoot(), 'agents');
  const resolved = resolveAgentDir(agentId, agentsDir);
  if (resolved) return path.join(resolved, 'config.json');
  return path.join(agentsDir, agentId, 'config.json');
}

/** 在 Agent config.json 的 presets 中追加/移除插件名；写回并返回是否有改动 */
function updateAgentPresets(configPath: string, preset: string, remove: boolean): boolean {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Agent 配置文件不存在: ${configPath}`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, any>;
  const presets: string[] = Array.isArray(config.presets) ? config.presets : [];
  const index = presets.indexOf(preset);
  if (remove) {
    if (index < 0) return false;
    presets.splice(index, 1);
  } else if (index < 0) {
    presets.push(preset);
  } else {
    return false;
  }
  config.presets = presets;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return true;
}

/** 默认开发插件目录：<workspace>/plugins/<agentId>/<pluginName>/ */
function defaultPluginDir(services: ToolContext, agentId: string, name: string): string {
  const ws = services.workspaceDir ?? workspaceRoot();
  return path.join(ws, 'plugins', agentId, name);
}

/** register_plugin：会话级动态加载 workspace 开发插件（admin） */
export function makeRegisterPluginTool(host: PluginHost, config: AgentConfig, services: ToolContext): Tool {
  return defineTool({
    name: 'register_plugin', label: '注册插件', requires: [CAPABILITY_ADMIN],
    description:
      '动态加载自己开发的插件（目录需含 manifest.json；高危权限 process/shell 须在 grants 显式授予）。仅调试用，正式发布走 git + 市场安装。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '插件名（= 目录名 = manifest.name）' },
        dir: { type: 'string', description: '插件目录（默认 <workspace>/plugins/<本AgentId>/<name>/）' },
        grants: {
          type: 'array',
          items: { type: 'string', enum: ['fs', 'network', 'process', 'shell', 'ui'] },
          description: '显式授予的高危权限（process/shell）',
        },
      },
      required: ['name'],
    },
    extractLabel: (args) => `加载插件 ${args.name}`,
    execute: async (args) => {
      const name = String(args.name ?? '').trim();
      if (!name) return JSON.stringify({ status: 'error', data: { message: '缺少 name' } });
      try {
        const dir = path.isAbsolute(String(args.dir ?? ''))
          ? String(args.dir)
          : defaultPluginDir(services, config.agent_id, name);
        const manifest = loadManifestFromDir(dir);
        if (manifest.name !== name) {
          throw new Error(`目录名 "${name}" 与 manifest.name "${manifest.name}" 不一致`);
        }
        const loaded = await host.load({
          manifest,
          dir,
          agentId: config.agent_id,
          sessionOnly: true,
          allowedPermissions: grantPermissions(args.grants),
          watch: true,
        });
        if (loaded.status === 'replaced') host.notifyCatalogChanged('session');

        // 持久化 presets 引用（插件代码本身不落盘到启动扫描）→ 触发 self reload 使本次立即重烘焙
        const configPath = agentConfigPath(services, config.agent_id);
        updateAgentPresets(configPath, manifest.name, false);
        throw new ToolInterrupt({ type: 'reload-requested', scope: 'self' });
      } catch (err: any) {
        if (err instanceof ToolInterrupt) throw err;
        return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
      }
    },
  });
}

/** unregister_plugin：卸载会话级插件并移除 presets 引用（admin） */
export function makeUnregisterPluginTool(host: PluginHost, config: AgentConfig, services: ToolContext): Tool {
  return defineTool({
    name: 'unregister_plugin', label: '卸载插件', requires: [CAPABILITY_ADMIN],
    description: '卸载由 register_plugin 加载的插件。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '插件名' } },
      required: ['name'],
    },
    extractLabel: (args) => `卸载插件 ${args.name}`,
    execute: async (args) => {
      const name = String(args.name ?? '').trim();
      if (!name) return JSON.stringify({ status: 'error', data: { message: '缺少 name' } });
      try {
        const loaded = host.get(name);
        if (!loaded) return JSON.stringify({ status: 'ok', data: { message: `插件 "${name}" 未在会话中加载` } });
        if (!loaded.sessionOnly || loaded.agentId !== config.agent_id) {
          return JSON.stringify({ status: 'error', data: { message: `插件 "${name}" 不是本 Agent 的会话级插件，拒绝卸载（全局安装请走发布/替换流程）` } });
        }
        await host.unload(name);
        const configPath = agentConfigPath(services, config.agent_id);
        updateAgentPresets(configPath, name, true);
        throw new ToolInterrupt({ type: 'reload-requested', scope: 'self' });
      } catch (err: any) {
        if (err instanceof ToolInterrupt) throw err;
        return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
      }
    },
  });
}

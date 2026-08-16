// ============================================================
// @agentchat/dev/src/plugin-tools.ts —— 插件开发闭环工具
//
//   register_plugin   ：workspace 开发插件 → 会话级动态加载（admin；重启即失）
//   unregister_plugin ：卸载会话级插件并回收 presets 引用（admin）
//   publish_plugin    ：stage（校验+暂存，待宿主审查）→ approve（安装进全局插件库）
//
// 安全边界：
//   · 三者均 requires:[CAPABILITY_ADMIN]；
//   · register_plugin 动态 import = 插件代码进宿主进程，仅会话级、不落盘为
//     启动扫描记录（重启即失）；publish_plugin 是持久安装，必须走
//     stage → 人审 → approve 两段式，approve 需人工回传暂存 id。
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
  approveStaging,
  grantPermissions,
  listStaging,
  loadManifestFromDir,
  stagePlugin,
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
      '将自己在工作区开发的完整插件动态加载进当前进程（会话级、admin 专用、重启即失；加载后自动开启源码监听，改动即热重载）。' +
      '插件目录默认 <workspace>/plugins/<本AgentId>/<name>/，需含 manifest.json（name/version/entry/inject/permissions）。' +
      'manifest.permissions 中的 fs/network 默认授予；process/shell 必须在 grants 参数显式授予，否则装载前拒绝（代码不会执行）。' +
      '加载成功后自动把 manifest.name 追加进本 Agent config.presets 并热重载配置，新插件提供的工具/钩子立即可用。' +
      '⚠️ 动态加载会执行插件代码：仅加载自己正在开发的代码；测试通过后请用 publish_plugin 发布。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '插件名（目录名，也必须是 manifest.name）' },
        dir: { type: 'string', description: '可选：插件目录绝对路径（缺省用工作区默认路径）' },
        grants: {
          type: 'array',
          items: { type: 'string', enum: ['fs', 'network', 'process', 'shell', 'ui'] },
          description: '可选：显式授予的高危权限（process/shell；ui 为 UI 扩展权限，P5 起执行期 gate）',
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
    description:
      '卸载会话级动态加载的插件（register_plugin 装入的），并把其从本 Agent config.presets 中移除后热重载配置。' +
      '全局插件库安装的插件不在此卸载（重启后由插件库扫描恢复）。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '插件名（manifest.name）' } },
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

/** publish_plugin：stage（暂存待审）/ list（查看暂存）/ approve（人审通过后安装） */
export function makePublishPluginTool(host: PluginHost, config: AgentConfig, services: ToolContext): Tool {
  return defineTool({
    name: 'publish_plugin', label: '发布插件', requires: [CAPABILITY_ADMIN],
    description:
      '把 workspace 开发插件发布到全局插件库（<workspace>/plugins/）。必须两段式：' +
      '① action=stage：校验 manifest、复制到 .staging 并计算哈希，返回 staging id 给宿主用户审查；' +
      '② 宿主用户审查暂存代码后，再以 action=approve 回传 id 完成安装（同名同版本拒绝，不同版本旧版入 .backup）。' +
      'manifest.permissions 中的 process/shell 必须在 approve 的 grants 参数显式授予（fs/network 默认授予），授予快照写入 registry。' +
      'action=list 查看待审暂存。安装后立即在当前进程生效，重启后由插件库扫描自动加载；' +
      '发布 ≠ 启用：Agent 需在 config.presets 引用 manifest.name 才启用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['stage', 'approve', 'list'], description: 'stage=暂存待审；approve=人审通过后安装；list=查看待审' },
        name: { type: 'string', description: 'stage：插件名（开发目录名，默认 <ws>/plugins/<本AgentId>/<name>）' },
        dir: { type: 'string', description: 'stage：可选，插件目录绝对路径' },
        id: { type: 'string', description: 'approve：stage 返回的 staging id（人工审查后回传）' },
        grants: {
          type: 'array',
          items: { type: 'string', enum: ['fs', 'network', 'process', 'shell', 'ui'] },
          description: 'approve：宿主显式授予的高危权限（process/shell；ui 为 UI 扩展权限，P5 起执行期 gate）',
        },
      },
      required: ['action'],
    },
    extractLabel: (args) => `发布插件 ${args.action ?? ''}`,
    execute: async (args) => {
      const action = String(args.action ?? '');
      const ws = services.workspaceDir ?? workspaceRoot();
      try {
        if (action === 'list') {
          const pending = listStaging(ws);
          return JSON.stringify({
            status: 'ok',
            data: {
              count: pending.length,
              message: pending.length === 0 ? '没有待审查的暂存插件' : '待审查暂存（请宿主用户审查代码后 approve）',
              staging: pending.map((s) => ({ id: s.id, name: s.manifest.name, version: s.manifest.version, owner: s.owner, sourceDir: s.sourceDir, createdAt: s.createdAt })),
            },
          });
        }

        if (action === 'stage') {
          const name = String(args.name ?? '').trim();
          if (!name) return JSON.stringify({ status: 'error', data: { message: 'stage 需要 name' } });
          const dir = path.isAbsolute(String(args.dir ?? ''))
            ? String(args.dir)
            : defaultPluginDir(services, config.agent_id, name);
          const record = stagePlugin(ws, dir, config.agent_id);
          host.notifyCatalogChanged('staging');
          return JSON.stringify({
            status: 'ok',
            data: {
              message: `插件 "${record.manifest.name}@${record.manifest.version}" 已暂存待审。请宿主用户审查 ${record.stagedDir} 后，调用 publish_plugin action=approve id=${record.id} 完成安装。`,
              id: record.id,
              stagedDir: record.stagedDir,
              hash: record.hash,
            },
          });
        }

        if (action === 'approve') {
          const id = String(args.id ?? '').trim();
          if (!id) return JSON.stringify({ status: 'error', data: { message: 'approve 需要 stage 返回的 id（人工审查后回传）' } });
          const approved = approveStaging(ws, id, args.grants);
          // 立即装载进当前进程（替换同名旧实例；按授予快照传权限）；重启后由启动扫描恢复
          await host.load({
            manifest: approved.manifest,
            dir: approved.installedDir,
            agentId: config.agent_id,
            sessionOnly: false,
            allowedPermissions: approved.permissions,
          });
          host.notifyCatalogChanged('installed');
          const replaced = approved.replaced
            ? `（已替换 ${approved.replaced.oldVersion}，旧版备份 ${approved.replaced.backupDir}）`
            : '';
          return JSON.stringify({
            status: 'ok',
            data: {
              message: `插件 "${approved.name}@${approved.version}" 已安装进全局插件库${replaced}。重启后自动加载；请在各 Agent config.presets 中引用 "${approved.name}" 启用。`,
              installedDir: approved.installedDir,
              hash: approved.hash,
            },
          });
        }

        return JSON.stringify({ status: 'error', data: { message: `未知 action "${action}"（支持 stage/approve/list）` } });
      } catch (err: any) {
        return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
      }
    },
  });
}

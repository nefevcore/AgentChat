// ============================================================
// agent-prompt 扩展 —— System Prompt 统一装配层
//
//   本扩展是 system prompt 装配链的核心 PreHook，
//   合并了原 agent-context、agent-skill、windows-environment、datetime 的功能。
//
//   装配流程（在单个 preHook 内原子化完成，不受 hook 顺序影响）：
//
//     阶段 1：框架装配（默认路径 — 按缓存友好顺序排列，静态在前、动态在后）
//       角色  →  系统环境  →  术语约定  →  标签约定  →  可用工具  →  指引  →  MCP  →  技能  →  持久化存储  →  对话信息
//       └──────────────────────────── KV-cache 命中 ────────────────────────────┘                 └─ 缓存失效仅此段 ─┘
//
//     阶段 2：SYSTEM.md 覆盖
//       如果 <agent>/SYSTEM.md 存在，完全替换上述装配结果，
//       仅追加 MCP 工具/资源 + 术语约定 + 标签约定 + 对话信息，AGENT.md 不再追加。
//
//   文件中函数的排列顺序与装配顺序一致，便于阅读和维护。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { AgentContext, Extension, PreProcessHook } from '@core/types';
import { getGlobalConfig } from '@core/config';
import { getAppState } from '@core/app-state';
import { meta, cfg } from './meta';
import { MCPServerConfig, MCPToolDef } from './mcp-types';
import { MCPDiscoveryManager } from './mcp-client';
import { logger } from '../../../../utils/logger';

// ============================================================
// 基础工具函数
// ============================================================

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 尝试加载指定文件内容（剥离 YAML frontmatter）。
 * 返回 null 表示文件不存在或为空。
 */
function tryLoadFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    let content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return null;
    content = content.replace(/^---[\s\S]*?---\n*/, '').trim();
    return content || null;
  } catch {
    logger.warn(`[agent-prompt] 无法读取 ${filePath}`);
    return null;
  }
}

// ============================================================
// Agent 目录解析
// ============================================================

function resolveAgentDir(agentId: string): string | null {
  const agentsDir = getGlobalConfig().agentsDir;
  if (!fs.existsSync(agentsDir)) return null;

  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cfgPath = path.join(agentsDir, entry.name, 'config.json');
    if (!fs.existsSync(cfgPath)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg.agent_id === agentId) {
        return path.join(agentsDir, entry.name);
      }
    } catch { /* skip */ }
  }
  return null;
}

/**
 * 解析 Agent ID 的友好显示名称，与 agent-memory 的记忆描述一致。
 * 优先从 config.json 读取 name 字段，回退到原始 id。
 */
function resolveAgentLabel(id: string): string {
  // 先按目录名直接匹配
  try {
    const cfgPath = path.join(getGlobalConfig().agentsDir, id, 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg.name) return cfg.name;
    }
  } catch { /* fall through */ }

  // 目录名与 agent_id 不匹配时，遍历查找
  try {
    const agentsDir = getGlobalConfig().agentsDir;
    if (fs.existsSync(agentsDir)) {
      for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const cfgPath = path.join(agentsDir, entry.name, 'config.json');
        if (!fs.existsSync(cfgPath)) continue;
        try {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
          if (cfg.agent_id === id && cfg.name) return cfg.name;
        } catch { /* skip */ }
      }
    }
  } catch { /* fall through */ }

  return id;
}

// ============================================================
// MCP 基础设施
// ============================================================

interface MCPRuntimeConfig {
  servers?: MCPServerConfig[];
  cacheTtlMs?: number;
}

function resolveMCPConfig(ctx: AgentContext): MCPRuntimeConfig | null {
  // 仅从 Agent 级配置读取 MCP，不回退全局。
  const ns = ctx.runtimeConfig?.['extension.agent_prompt'] as any;
  if (!ns) return null;

  const mcpVal = ns.mcp;
  const mcpObj = (typeof mcpVal === 'object' && mcpVal !== null) ? mcpVal as Record<string, unknown> : null;

  const mcpFilePath = (typeof ns.mcpFile === 'string' && ns.mcpFile)
    || (mcpObj?.mcpFile && typeof mcpObj.mcpFile === 'string' && mcpObj.mcpFile)
    || undefined;

  if (mcpVal === false) return null;
  if (!mcpVal && !mcpFilePath) return null;

  if (mcpFilePath) {
    try {
      if (!fs.existsSync(mcpFilePath)) {
        logger.warn(`[agent-prompt] MCP 文件不存在: ${mcpFilePath}`);
        return null;
      }
      const fileContent = fs.readFileSync(mcpFilePath, 'utf-8');
      const fileCfg = JSON.parse(fileContent);

      if (!fileCfg.servers || !Array.isArray(fileCfg.servers)) {
        logger.warn(`[agent-prompt] MCP 文件格式无效（缺少 servers 数组）: ${mcpFilePath}`);
        return null;
      }

      logger.info(`[agent-prompt] 从外部文件加载 MCP 配置: ${mcpFilePath} (${fileCfg.servers.length} 个服务器)`);
      return {
        servers: fileCfg.servers as MCPServerConfig[],
        cacheTtlMs: fileCfg.cacheTtlMs ?? (mcpObj?.cacheTtlMs as number | undefined),
      };
    } catch (err: any) {
      logger.warn(`[agent-prompt] 读取 MCP 文件失败 (${mcpFilePath}): ${err.message}`);
      return null;
    }
  }

  if (mcpObj?.servers && Array.isArray(mcpObj.servers)) {
    return {
      servers: mcpObj.servers as MCPServerConfig[],
      cacheTtlMs: mcpObj.cacheTtlMs as number | undefined,
    };
  }

  return null;
}

// 全局 MCP 发现管理器（单例，跨请求重用连接和缓存）
let _mcpManager: MCPDiscoveryManager | null = null;
let _mcpManagerConfigKey: string = '';

function getMCPManager(servers: MCPServerConfig[], cacheTtlMs?: number): MCPDiscoveryManager {
  const configKey = JSON.stringify({ servers: servers.map(s => ({ ...s, env: undefined })), cacheTtlMs });
  if (_mcpManager && _mcpManagerConfigKey === configKey) {
    return _mcpManager;
  }

  _mcpManager?.disconnectAll();
  _mcpManager = new MCPDiscoveryManager(cacheTtlMs);
  _mcpManager.configure(servers);
  _mcpManagerConfigKey = configKey;

  return _mcpManager;
}

// ============================================================
// Block 2: 系统环境（长期固定）
// ============================================================

function buildEnvBlock(agentId: string, includeEnv: boolean): string {
  const lines: string[] = [];
  lines.push('## 系统环境');

  const cwd = `./files/${agentId}/`;
  lines.push(`[工作目录] ${cwd}`);

  if (includeEnv) {
    const platform = process.platform;
    const arch = process.arch;
    const osName = platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform === 'darwin' ? 'macOS' : platform;
    let block = `[运行环境] ${osName}`;
    if (arch) block += ` (${arch})`;

    if (platform === 'win32') {
      block += ` — PowerShell, ; 链接命令, \\ 路径分隔符, $env: 环境变量`;
      block += `\n[编码提示] Windows 控制台默认使用 GBK (代码页 936)。读取文件始终使用 UTF-8；执行 Shell 命令时如需处理中文输出，优先使用 \`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\` 设置 PowerShell 输出编码。若需调用 cmd 子命令（如 \`cmd /c\`），可在该子命令前加 \`chcp 65001\`。`;
    } else if (platform === 'linux') {
      block += ` — bash, && 链接命令, / 路径分隔符, $ 环境变量`;
    } else if (platform === 'darwin') {
      block += ` — zsh, && 链接命令, / 路径分隔符, $ 环境变量`;
    }

    lines.push(block);
  }

  return lines.join('\n');
}

// ============================================================
// Block 3: 可用工具
// ============================================================

function buildToolsBlock(
  tools: Array<{ name: string; displayName?: string; description: string }>,
): string {
  if (tools.length === 0) return '';

  const lines: string[] = ['## 可用工具'];
  for (const t of tools) {
    const shortDesc = t.description.split('\n')[0].trim();
    lines.push(`- ${t.name} — ${shortDesc}`);
  }
  return lines.join('\n');
}

// ============================================================
// Block 4: 指引
// ============================================================

function buildGuidelinesBlock(
  tools: Array<{ name: string }>,
  skillCount: number,
): string {
  const toolNames = new Set(tools.map(t => t.name));
  const list: string[] = [];
  const seen = new Set<string>();

  const add = (g: string): void => {
    const normalized = g.trim();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    list.push(normalized);
  };

  const hasBash = toolNames.has('bash');
  const hasRead = toolNames.has('read');
  const hasWrite = toolNames.has('write');
  const hasEdit = toolNames.has('edit');
  const hasWebSearch = toolNames.has('web_search');

  if (hasRead && hasWrite && hasEdit) {
    add('修改代码时先 read 后 edit，精确编辑避免覆盖整个文件');
  } else if (hasRead && hasWrite && !hasEdit) {
    add('edit 工具不可用，修改文件需先 read 再用 write 写入完整内容');
  }

  if (hasBash) {
    add('执行 Shell 命令前确认当前目录和上下文，避免误操作');
  }
  if (hasBash && hasRead) {
    add('探索文件系统优先用 read，仅在复杂操作时使用 bash');
  }

  if (hasWebSearch) {
    add('涉及最新信息或外部知识时使用 web_search 获取准确内容');
  }

  const hasSendAgent = toolNames.has('send_agent');
  const hasListAgents = toolNames.has('list_agents');
  if (hasSendAgent && hasListAgents) {
    add('多Agent协作：先用 list_agents 查看可用Agent，再用 send_agent 向其他Agent发送消息获取帮助');
  }

  const hasSetTimer = toolNames.has('set_timer');
  const hasListTimers = toolNames.has('list_timers');
  const hasDisableTimer = toolNames.has('disable_timer');
  if (hasSetTimer && hasListTimers && hasDisableTimer) {
    add('定时任务：用 list_timers 查看已有任务，用 set_timer 添加或修改任务，用 disable_timer 禁用任务。');
  }

  if (hasSetTimer && hasSendAgent) {
    add('自主行动：你拥有主动发起对话和定时任务的能力。当你认为需要关注某个话题、提醒用户某事、或定期检查某些状态时，可以主动使用 set_timer 为自己设置定时提醒。不必等待用户的明确指令，在合适的时机展现主动性会让对话更自然');
  }

  const hasSendGroup = toolNames.has('send_group');
  const hasListGroups = toolNames.has('list_groups');
  if (hasSendGroup && hasListGroups) {
    add('群聊协作：先用 list_groups 查看可用群聊及成员，再用 send_group 向群聊发送消息。群聊中的消息会广播给所有参与者，无话可说时保持沉默。');
  } else if (hasSendGroup) {
    add('群聊消息：使用 send_group 向指定群聊发送消息，消息会广播给所有参与者。');
  }

  const hasUpdateProfile = toolNames.has('update_agent_profile');
  if (hasUpdateProfile) {
    add('Agent档案：严禁编辑其他Agent的档案——该操作会被系统拦截器强制拒绝。如果你需要启用新能力，可以通过 update_agent_profile 为自己的工具清单添加新工具');
  }

  const hasReloadSelfTools = toolNames.has('reload_self_tools');
  const canCreateFiles = hasWrite || hasBash;
  if (hasReloadSelfTools && canCreateFiles) {
    add('工具开发：你可以在自己的 tools/ 目录下创建新工具（meta.ts + tool.ts），然后调用 reload_self_tools 热加载，无需重启即可立即使用。详细指引见 ./files/tool-dev-guide.md');
  } else if (hasReloadSelfTools) {
    add('工具热加载：调用 reload_self_tools 可扫描并注册 tools/ 目录下的新工具，无需重启。');
  }

  if (skillCount > 0) {
    add(`当前配置了 ${skillCount} 个技能，任务匹配时用 read 加载对应 SKILL.md`);
  }

  if (list.length === 0) return '';

  const numbered = list.map((g, i) => `${i + 1}. ${g}`);
  return `## 指引\n${numbered.join('\n')}`;
}

// ============================================================
// Block 5: MCP 工具/资源
// ============================================================

function buildMCPToolsBlock(discoveries: Array<{ serverName: string; tools: MCPToolDef[] }>): string {
  if (discoveries.length === 0) return '';

  const lines: string[] = ['## MCP 工具'];
  lines.push('');
  lines.push('以下工具来自 MCP (Model Context Protocol) 服务器，通过标准协议接入：');
  lines.push('');

  for (const d of discoveries) {
    if (d.tools.length === 0) continue;

    lines.push(`### ${escapeXml(d.serverName)}`);
    for (const tool of d.tools) {
      const desc = (tool.description ?? '无描述').split('\n')[0].trim();
      const shortDesc = desc.length > 120 ? desc.slice(0, 117) + '...' : desc;
      lines.push(`  · **${escapeXml(tool.name)}** — ${escapeXml(shortDesc)}`);
    }
    lines.push('');
  }

  if (lines.length <= 3) return '';
  return lines.join('\n');
}

function buildMCPResourcesBlock(discoveries: Array<{ serverName: string; resources: Array<{ uri: string; name: string; description?: string }> }>): string {
  const filtered = discoveries.filter(d => d.resources.length > 0);
  if (filtered.length === 0) return '';

  const lines: string[] = ['## MCP 资源'];
  lines.push('');
  lines.push('以下资源来自 MCP 服务器，可通过 URI 引用：');
  lines.push('');

  for (const d of filtered) {
    lines.push(`### ${escapeXml(d.serverName)}`);
    for (const r of d.resources) {
      const desc = r.description ? ` — ${escapeXml(r.description.slice(0, 80))}` : '';
      lines.push(`  · \`${escapeXml(r.uri)}\` (${escapeXml(r.name)})${desc}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================
// Block 6: 技能发现与展示
// ============================================================

interface SkillManifest {
  name: string;
  description: string;
  dirName: string;
}

function parseSkillFrontmatter(skillMdPath: string, dirName: string): SkillManifest | null {
  if (!fs.existsSync(skillMdPath)) return null;

  let content: string;
  try {
    content = fs.readFileSync(skillMdPath, 'utf-8');
  } catch {
    logger.warn(`[agent-prompt] 无法读取 ${skillMdPath}`);
    return null;
  }

  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    logger.warn(`[agent-prompt] ${skillMdPath} 无有效 YAML frontmatter`);
    return null;
  }

  const fm = fmMatch[1];

  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : dirName;

  const descMatch = fm.match(/^description:\s*\|\s*\n([\s\S]*?)(?=^[a-zA-Z]|\Z)/m);
  let description = '';
  if (descMatch) {
    description = descMatch[1]
      .split('\n')
      .map(line => line.replace(/^\s{2,}/, '').trimEnd())
      .filter(Boolean)
      .join(' ');
  } else {
    const descSingle = fm.match(/^description:\s*(.+)$/m);
    if (descSingle) {
      description = descSingle[1].trim().replace(/^["']|["']$/g, '');
    }
  }

  return { name, description, dirName };
}

function discoverSkills(agentDir: string): SkillManifest[] {
  const skillsDir = path.join(agentDir, 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  const skills: SkillManifest[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
    const manifest = parseSkillFrontmatter(skillMdPath, entry.name);
    if (manifest) {
      skills.push(manifest);
      logger.info(`[agent-prompt] 发现技能: ${manifest.name} (${entry.name})`);
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

function buildSkillsBlock(skills: SkillManifest[], agentDirName: string): string {
  if (skills.length === 0) return '';

  const lines: string[] = [];
  lines.push('## 可用技能');
  lines.push('');
  lines.push('当任务匹配某个技能的描述时，使用 read 工具加载其 SKILL.md 获取完整指令。');
  lines.push('技能文件中引用的相对路径应相对于技能目录解析。');
  lines.push('');
  lines.push('<available_skills>');

  for (const skill of skills) {
    const location = `./agents/${agentDirName}/skills/${skill.dirName}/SKILL.md`;
    const desc = skill.description.length > 200
      ? skill.description.slice(0, 197) + '...'
      : skill.description;

    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(desc)}</description>`);
    lines.push(`    <location>${escapeXml(location)}</location>`);
    lines.push('  </skill>');
  }

  lines.push('</available_skills>');
  return lines.join('\n');
}

// ============================================================
// Block 7: 持久化存储（长期固定）
// ============================================================

function buildStorageBlock(agentId: string, agentDirName?: string): string {
  if (!agentDirName) return '';

  const lines: string[] = [];
  lines.push('## 持久化存储');

  const agentDir = `./agents/${agentDirName}/`;
  const filesDir = `./files/${agentId}/`;
  lines.push(`[角色定义] ${agentDir}AGENT.md — 你的角色定义，系统自动加载到提示词中。如需修改自我，编辑此文件。`);
  lines.push(`[待办清单] ${filesDir}TODO.md — 你的待办事项，包含当前任务和长期计划。这是你唯一的任务追踪文件，请持续维护，不要删除。`);
  lines.push(`[知识笔记] ${filesDir}note/ — 你的持久知识库。有值得积累的知识，在 note/ 下创建 .md 文件记录，同时维护 note/note_index（每行一条：文件名 + 一句话描述）。优先更新已有笔记而非重复新建，避免冗余。查找笔记时先读 note_index 定位，再 read 目标文件。`);
  lines.push(`[记忆文件] 你对每个对话对象的长期记忆存放于 ./sessions/${agentId}/<对话对象>/memory.md。归档时在同目录下创建 .memory_review_needed 空文件。你需要在每日定时审查中检测标记，检索近期对话，并同步更新 TODO.md 和 note/。`);
  lines.push(`[记忆隔离] 每个对话对象的记忆和聊天记录独立存储，互不可见。如需查询与某个 Agent 的历史对话，使用 query_history 工具。`);

  return lines.join('\n');
}

// ============================================================
// Block 8: 术语约定（长期固定）
// ============================================================

function buildTerminologyBlock(): string {
  const lines: string[] = [];
  lines.push('## 术语约定');
  lines.push('');
  lines.push('以下术语映射关系帮助你正确理解系统指令。请始终以工具名中的术语为准：');
  lines.push('');
  lines.push('- Agent — 本系统中所有对话参与者的统称，包括普通 Agent（AI 实体）和虚拟 Agent（用户）。`send_agent`、`list_agents`、`query_history`、`get_agent_profile` 均可操作任意 Agent；仅 `update_agent_profile` 限你自己（普通 Agent），系统拦截器会强制拒绝修改他人档案。');
  lines.push('- 群聊 (group) — 多个 Agent 共同参与的消息广播空间。系统内部以 room（房间）实现，但对 Agent 暴露的概念统一为"群聊"。工具 `send_group` 用于向群聊发送消息，`list_groups` 用于查看可用群聊。');
  lines.push('- 对话对象 — 当前与你直接通信的实体。对话信息中的 `[当前对话对象]` 即指此实体。');
  lines.push('');
  return lines.join('\n');
}

// ============================================================
// Block 9: 标签约定（长期固定）
// ============================================================

function buildFormatGuidelinesBlock(): string {
  const lines: string[] = [];
  lines.push('## 标签约定');
  lines.push('');
  lines.push('- 标签 <file path="相对路径">显示名称</file> 用于引用文件。');
  lines.push('- 标签 <msg from="agent_id" name="">消息内容</msg> 表示群聊中其他Agent发出的消息。');
  lines.push('- 标签 <trigger>hint</trigger> 表示系统自动触发的指令，非用户对话消息。');
  
  lines.push('');
  return lines.join('\n');
}

// ============================================================
// Block 9: 对话信息（动态变化，置于最后以最小化缓存失效范围）
// ============================================================

function buildSessionBlock(agentId: string, sender: string, includeDatetime: boolean, includePartner: boolean, roomId?: string): string {
  const lines: string[] = [];
  lines.push('## 对话信息');

  if (includePartner) {
    if (roomId) {
      // 群聊模式
      let participantList = '';
      let roomDescription = '';
      try {
        const appState = getAppState();
        const rm = (appState.router as any)?.getRoomManager?.() as any;
        const room = rm?.getRoom?.(roomId);
        if (room?.participants) {
          const names = room.participants.map((p: string) => {
            try {
              const label = resolveAgentLabel(p);
              return label !== p ? `${label} (${p})` : p;
            } catch { return p; }
          });
          participantList = names.join('、');
        }
        if (room?.description) {
          roomDescription = room.description;
        }
      } catch { /* 降级 */ }

      lines.push(`[当前群聊] ${roomId}`);
      if (participantList) {
        lines.push(`[群聊成员] ${participantList}`);
      }
      if (roomDescription) {
        lines.push(`[群聊简介] ${roomDescription}`);
      }
      lines.push(`[群聊提示] 你正在群聊中，消息会广播给所有参与者。使用 send_group 回复，无话可说时保持沉默。`);
    } else {
      const label = resolveAgentLabel(sender);
      const selfNote = sender === agentId ? '（自己）' : '';
      lines.push(`[当前对话对象] ${label}${selfNote}`);
    }
  }

  if (includeDatetime) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    lines.push(`[当前时间] ${weekdays[now.getDay()]} ${dateStr}`);
  }

  return lines.join('\n');
}

// ============================================================
// preHook —— 装配入口
// ============================================================

const preHook: PreProcessHook = async (ctx: AgentContext): Promise<AgentContext> => {
  const promptCfg = cfg(ctx.runtimeConfig);
  const tools = ctx.availableTools ?? [];
  const agentId = ctx.receiver;

  // ---- 技能发现 ----
  let skills: SkillManifest[] = [];
  let agentDirName = '';
  const agentDir = resolveAgentDir(agentId);
  if (agentDir) {
    agentDirName = path.basename(agentDir);
    if (promptCfg.skills) {
      skills = discoverSkills(agentDir);
    }
  }

  // ---- MCP 工具发现 ----
  let mcpDiscoveries: Array<{ serverName: string; tools: MCPToolDef[]; resources: Array<{ uri: string; name: string; description?: string }> }> = [];
  if (promptCfg.mcp) {
    const mcpCfg = resolveMCPConfig(ctx);
    if (mcpCfg?.servers && mcpCfg.servers.length > 0) {
      try {
        const manager = getMCPManager(mcpCfg.servers, mcpCfg.cacheTtlMs);
        const discoveries = await manager.discoverAll();
        mcpDiscoveries = discoveries
          .filter(d => d.connected)
          .map(d => ({ serverName: d.serverName, tools: d.tools, resources: d.resources }));

        const mcpToolMap: Record<string, { serverName: string; tool: MCPToolDef }> = {};
        for (const d of discoveries) {
          if (!d.connected) continue;
          for (const tool of d.tools) {
            mcpToolMap[tool.name] = { serverName: d.serverName, tool };
          }
        }
        ctx.meta!['mcp'] = { toolMap: mcpToolMap, manager };

        logger.info(`[agent-prompt] MCP 发现: ${mcpDiscoveries.length} 个服务器, ${mcpDiscoveries.reduce((s, d) => s + d.tools.length, 0)} 个工具`);
      } catch (err: any) {
        logger.warn(`[agent-prompt] MCP 发现失败: ${err.message}`);
      }
    }
  }

  // ---- SYSTEM.md 完全覆盖路径 ----
  if (agentDir) {
    const systemContent = tryLoadFile(path.join(agentDir, 'SYSTEM.md'));
    if (systemContent) {
      const mcpBlocks: string[] = [];
      if (promptCfg.mcp && mcpDiscoveries.length > 0) {
        const mcpToolsBlock = buildMCPToolsBlock(mcpDiscoveries);
        if (mcpToolsBlock) mcpBlocks.push(mcpToolsBlock);
        const mcpResourcesBlock = buildMCPResourcesBlock(mcpDiscoveries);
        if (mcpResourcesBlock) mcpBlocks.push(mcpResourcesBlock);
      }
      const mcpSection = mcpBlocks.length > 0 ? '\n\n' + mcpBlocks.join('\n\n') : '';

      const terminologyBlock = buildTerminologyBlock();
      const formatBlock = buildFormatGuidelinesBlock();
      const sessionBlock = buildSessionBlock(agentId, ctx.sender, promptCfg.datetime, promptCfg.conversationPartner, ctx.room_id);

      const systemPrompt = `${systemContent}${mcpSection}\n\n${terminologyBlock}\n\n${formatBlock}\n\n${sessionBlock}`;
      logger.info(`[agent-prompt] Agent "${agentId}" 使用 SYSTEM.md 完全覆盖`);
      return { ...ctx, systemPrompt };
    }
  }

  // ---- 默认装配路径 ----
  const blocks: string[] = [];

  // 1. 角色（AGENT.md）
  if (agentDir) {
    const agentContent = tryLoadFile(path.join(agentDir, 'AGENT.md'));
    if (agentContent) {
      blocks.push(`## 角色\n<persona>\n${agentContent}\n</persona>`);
      logger.info(`[agent-prompt] Agent "${agentId}" 已追加 AGENT.md`);
    }
  }

  // 2. 系统环境
  blocks.push(buildEnvBlock(agentId, promptCfg.systemEnv));

  // 3. 术语约定
  blocks.push(buildTerminologyBlock());

  // 4. 标签约定
  blocks.push(buildFormatGuidelinesBlock());

  // 5. 可用工具
  if (promptCfg.tools) {
    const block = buildToolsBlock(tools);
    if (block) blocks.push(block);
  }

  // 6. 指引
  if (promptCfg.guidelines) {
    const block = buildGuidelinesBlock(tools, skills.length);
    if (block) blocks.push(block);
  }

  // 7. MCP 工具/资源
  if (promptCfg.mcp && mcpDiscoveries.length > 0) {
    const mcpToolsBlock = buildMCPToolsBlock(mcpDiscoveries);
    if (mcpToolsBlock) blocks.push(mcpToolsBlock);
    const mcpResourcesBlock = buildMCPResourcesBlock(mcpDiscoveries);
    if (mcpResourcesBlock) blocks.push(mcpResourcesBlock);
  }

  // 8. 技能清单
  if (promptCfg.skills) {
    const block = buildSkillsBlock(skills, agentDirName);
    if (block) blocks.push(block);
  }

  // 9. 持久化存储
  blocks.push(buildStorageBlock(agentId, agentDirName));

  // 10. 对话信息（动态，置于最后）
  blocks.push(buildSessionBlock(agentId, ctx.sender, promptCfg.datetime, promptCfg.conversationPartner, ctx.room_id));

  const systemPrompt = blocks.join('\n\n');
  return { ...ctx, systemPrompt };
};

// ============================================================
// Extension 统一入口
// ============================================================

export const extension: Extension = {
  ...meta,
  preHook,
};

/**
 * 获取当前 MCP 发现管理器实例。
 * 可供外部 MCP 工具执行桥接使用。
 */
export function getCurrentMCPManager(): MCPDiscoveryManager | null {
  return _mcpManager;
}
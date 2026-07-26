// ============================================================
// agent-prompt 扩展 —— System Prompt 统一装配层
//
//   本扩展是 system prompt 装配链的核心 PreHook，
//   合并了原 agent-context、agent-skill、windows-environment、datetime 的功能。
//
//   装配流程（在单个 preHook 内原子化完成，不受 hook 顺序影响）：
//
//     阶段 1：框架装配（默认路径）
//       工具列表  →  动态指引  →  MCP 工具/资源  →  技能清单  →  AGENT.md  →  日期 + CWD + 环境
//
//     阶段 2：SYSTEM.md 覆盖
//       如果 <agent>/SYSTEM.md 存在，完全替换上述装配结果，
//       仅追加 MCP 工具/资源 + 尾部信息（日期 + CWD + 环境），AGENT.md 不再追加。 
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { AgentContext, Extension, PreProcessHook } from '@core/types';
import { getGlobalConfig } from '@core/config';
import { meta, cfg } from './meta';
import { MCPServerConfig, MCPToolDef } from './mcp-types';
import { MCPDiscoveryManager } from './mcp-client';

// ── MCP 配置解析 ──

interface MCPRuntimeConfig {
  servers?: MCPServerConfig[];
  cacheTtlMs?: number;
}

function resolveMCPConfig(ctx: AgentContext): MCPRuntimeConfig | null {
  // 仅从 Agent 级配置读取 MCP，不回退全局。
  // MCP 服务器连接是重量级操作，应仅对明确配置了的 Agent 生效，
  // 避免全局配置导致所有 Agent 都启动 MCP 连接。
  const ns = ctx.runtimeConfig?.['extension.agent_prompt'] as any;
  if (!ns) return null;

  // mcp 可以是 boolean (仅开关)、object (内联 servers) 或 undefined。
  // 如果显式设置了 mcpFile，视为隐式启用 MCP（无需额外设置 mcp: true）。
  const mcpVal = ns.mcp;
  const mcpObj = (typeof mcpVal === 'object' && mcpVal !== null) ? mcpVal as Record<string, unknown> : null;

  // 优先读取 mcpFile：先查命名空间级 ns.mcpFile，再查嵌套 ns.mcp.mcpFile（向后兼容）
  const mcpFilePath = (typeof ns.mcpFile === 'string' && ns.mcpFile)
    || (mcpObj?.mcpFile && typeof mcpObj.mcpFile === 'string' && mcpObj.mcpFile)
    || undefined;

  // mcp 显式为 false 时强制禁用（即使有 mcpFile 也不启用）
  if (mcpVal === false) return null;

  // 启用条件：mcp 为 true、mcp 为 object，或配置了 mcpFile
  if (!mcpVal && !mcpFilePath) return null;

  // 如果指定了 mcpFile，从外部 .mcp 文件加载服务器配置。
  // 这允许将敏感凭证（SAP 密码等）存储在工作区外，避免泄露到版本控制。
  if (mcpFilePath) {
    try {
      if (!fs.existsSync(mcpFilePath)) {
        console.warn(`[agent-prompt] MCP 文件不存在: ${mcpFilePath}`);
        return null;
      }
      const fileContent = fs.readFileSync(mcpFilePath, 'utf-8');
      const fileCfg = JSON.parse(fileContent);

      if (!fileCfg.servers || !Array.isArray(fileCfg.servers)) {
        console.warn(`[agent-prompt] MCP 文件格式无效（缺少 servers 数组）: ${mcpFilePath}`);
        return null;
      }

      console.log(`[agent-prompt] 从外部文件加载 MCP 配置: ${mcpFilePath} (${fileCfg.servers.length} 个服务器)`);
      return {
        servers: fileCfg.servers as MCPServerConfig[],
        cacheTtlMs: fileCfg.cacheTtlMs ?? (mcpObj?.cacheTtlMs as number | undefined),
      };
    } catch (err: any) {
      console.warn(`[agent-prompt] 读取 MCP 文件失败 (${mcpFilePath}): ${err.message}`);
      return null;
    }
  }

  // 回退到内联 servers 配置（向后兼容：ns.mcp.servers）
  if (mcpObj?.servers && Array.isArray(mcpObj.servers)) {
    return {
      servers: mcpObj.servers as MCPServerConfig[],
      cacheTtlMs: mcpObj.cacheTtlMs as number | undefined,
    };
  }

  return null;
}

// ============================================================
// 全局 MCP 发现管理器（单例，跨请求重用连接和缓存）
// ============================================================

let _mcpManager: MCPDiscoveryManager | null = null;
let _mcpManagerConfigKey: string = '';

function getMCPManager(servers: MCPServerConfig[], cacheTtlMs?: number): MCPDiscoveryManager {
  const configKey = JSON.stringify({ servers: servers.map(s => ({ ...s, env: undefined })), cacheTtlMs });
  if (_mcpManager && _mcpManagerConfigKey === configKey) {
    return _mcpManager;
  }

  // 清理旧实例
  _mcpManager?.disconnectAll();

  _mcpManager = new MCPDiscoveryManager(cacheTtlMs);
  _mcpManager.configure(servers);
  _mcpManagerConfigKey = configKey;

  return _mcpManager;
}

// ============================================================
// 1. 工具列表
// ============================================================

function buildToolsBlock(
  tools: Array<{ name: string; displayName?: string; description: string }>,
): string {
  if (tools.length === 0) return '';

  const lines: string[] = ['## 可用工具'];
  for (const t of tools) {
    const shortDesc = t.description.split('\n')[0].trim();
    lines.push(`  · ${t.name} — ${shortDesc}`);
  }
  return lines.join('\n');
}

// ============================================================
// 2. 动态指引
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

  // 文件操作
  if (hasRead && hasWrite && hasEdit) {
    add('修改代码时先 read 后 edit，精确编辑避免覆盖整个文件');
  } else if (hasRead && hasWrite && !hasEdit) {
    add('edit 工具不可用，修改文件需先 read 再用 write 写入完整内容');
  }

  // Shell
  if (hasBash) {
    add('执行 Shell 命令前确认当前目录和上下文，避免误操作');
  }
  if (hasBash && hasRead) {
    add('探索文件系统优先用 read，仅在复杂操作时使用 bash');
  }

  // Web 搜索
  if (hasWebSearch) {
    add('涉及最新信息或外部知识时使用 web_search 获取准确内容');
  }

  // 多 Agent 协作
  const hasSendAgent = toolNames.has('send_agent');
  const hasListAgents = toolNames.has('list_agents');
  if (hasSendAgent && hasListAgents) {
    add('多Agent协作：先用 list_agents 查看可用Agent，再用 send_agent 向其他Agent发送消息获取帮助');
  }

  // 定时任务
  const hasSetTimer = toolNames.has('set_timer');
  const hasListTimers = toolNames.has('list_timers');
  const hasDisableTimer = toolNames.has('disable_timer');
  if (hasSetTimer && hasListTimers && hasDisableTimer) {
    add('定时任务：用 list_timers 查看已有任务，用 set_timer 添加或修改任务，用 disable_timer 禁用任务。');
  }

  // Agent 自主性
  if (hasSetTimer && hasSendAgent) {
    add('自主行动：你拥有主动发起对话和定时任务的能力。当你认为需要关注某个话题、提醒用户某事、或定期检查某些状态时，可以主动使用 set_timer 为自己设置定时提醒，届时通过 send_agent 或 trigger 消息向目标推送。不必等待用户的明确指令，在合适的时机展现主动性会让对话更自然');
  }

  // Agent 档案
  const hasGetProfile = toolNames.has('get_agent_profile');
  const hasUpdateProfile = toolNames.has('update_agent_profile');
  if (hasGetProfile && hasUpdateProfile) {
    add('Agent档案：使用 get_agent_profile 查看自己或其他Agent的公开档案；使用 update_agent_profile 只能更新自己的档案（可修改名称、描述、人物设定、系统提示词、头像、标签，以及 tools/pre_hooks/post_hooks 插件清单）。严禁编辑其他Agent的档案——该操作会被系统拦截器强制拒绝。如果你需要启用新能力，可以通过 update_agent_profile 为自己的 tools 清单添加新工具名');
  } else if (hasGetProfile) {
    add('使用 get_agent_profile 查看Agent的公开档案');
  }

  // 技能
  if (skillCount > 0) {
    add(`当前配置了 ${skillCount} 个技能，任务匹配时用 read 加载对应 SKILL.md`);
  }

  if (list.length === 0) return '';

  const numbered = list.map((g, i) => `${i + 1}. ${g}`);
  return `## 指引\n${numbered.join('\n')}`;
}

// ============================================================
// 2.5 MCP 工具发现与展示
// ============================================================

/**
 * 按服务器分组格式化 MCP 工具列表。
 * 示例输出：
 *   ## MCP 工具 (filesystem)
 *     · read_file — 读取文件内容
 *     · write_file — 写入文件
 */
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

  if (lines.length <= 3) return ''; // 没有有效工具
  return lines.join('\n');
}

/**
 * 按服务器分组格式化 MCP 资源列表。
 */
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
// 3. 技能发现
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
    console.warn(`[agent-prompt] 无法读取 ${skillMdPath}`);
    return null;
  }

  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    console.warn(`[agent-prompt] ${skillMdPath} 无有效 YAML frontmatter`);
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

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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
      console.log(`[agent-prompt] 发现技能: ${manifest.name} (${entry.name})`);
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
// 4.0 会话对象名称解析（与 agent-memory/utils.ts agentLabel 保持一致）
// ============================================================

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
// 4. 尾部：会话对象 + 日期 + CWD + 环境
// ============================================================

function buildTailBlock(agentId: string, sender: string, includeEnv: boolean, includeDatetime: boolean, includePartner: boolean, roomId?: string, agentDirName?: string): string {
  const lines: string[] = [];

  // 尾部统一归属到 ## 运行环境 标题下
  lines.push('## 运行环境');

  // trigger 消息约定：当用户消息为 \`<trigger>...</trigger>\` 格式时，这是系统发出的
  // 自动触发指令（非用户对话）。Agent 应理解这是系统级别的要求并据此行动。
  lines.push(`[系统触发约定] 当收到的用户消息以 \`<trigger>\` 开头、\`</trigger>\` 结尾时，这是系统自动发出的指令，而非用户对话消息。请按指令内容执行并回复。`);

  if (includePartner) {
    if (roomId) {
      // 群聊模式：告知 Agent 正身处群聊房间，无需标注单个对话对象
      lines.push(`[当前群聊房间] ${roomId}`);
      lines.push(`[群聊提示] 你正在群聊房间中，消息会广播给所有参与者。使用 send_to_room 回复，无话可说时保持沉默。`);
    } else {
      const label = resolveAgentLabel(sender);
      lines.push(`[你正在与以下用户对话] ${label}`);
      lines.push(`[对话隔离说明] 每条对话的上下文是完全独立的。你与不同对象的对话（如 user、coding_agent、自身）互不可见。发送给自身（send_agent 到自己的 ID）或通过 trigger 自触发时，仅能看到自己的历史记录，无法看到与其他 Agent 的对话内容。`);
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

  // CWD：Agent 专属工作分区（./files/<agent>/）
  const cwd = `./files/${agentId}/`;
  lines.push(`[工作目录] ${cwd}`);

  // 常设文件路径引导
  // AGENT.md 属于 Agent 定义，放在 agents/ 目录；TODO 与笔记属于 Agent 工作状态，放在 CWD (files/) 目录
  if (agentDirName) {
    const agentDir = `./agents/${agentDirName}/`;
    const filesDir = `./files/${agentId}/`;
    lines.push(`[角色定义] ${agentDir}AGENT.md — 你的角色定义，系统自动加载到提示词中。如需修改角色，编辑此文件。`);
    lines.push(`[待办清单] ${filesDir}TODO.md — 你的待办事项，包含当前任务和长期计划。这是你唯一的任务追踪文件，请持续维护，不要删除。`);
    lines.push(`[知识笔记] ${filesDir}note/ — 你的持久知识库。有值得积累的经验、洞察、方法论时，在 note/ 下创建 .md 文件记录，同时维护 note/note_index（每行一条：文件名 + 一句话描述）。优先更新已有笔记而非重复新建，避免冗余。查找笔记时先读 note_index 定位，再 read 目标文件。`);
    lines.push(`[记忆文件] 你对每个对话对象的长期记忆存放于 ./sessions/${agentId}/<对话对象>/memory.md。归档时系统写入 .memory_review_needed 标记。你需要在每日定时审查中检测标记，检索近期对话，并同步更新 TODO.md 和 note/。`);
  }

  if (includeEnv) {
    const platform = process.platform;
    const arch = process.arch;
    const osName = platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform === 'darwin' ? 'macOS' : platform;
    let block = `[运行环境] ${osName}`;
    if (arch) block += ` (${arch})`;

    if (platform === 'win32') {
      block += ` — PowerShell, ; 链接命令, \\ 路径分隔符, $env: 环境变量`;
      block += `\n[编码提示] Windows 控制台默认使用 GBK (代码页 936)，读写文件或执行命令输出可能乱码。读取文件始终使用 UTF-8；执行 Shell 命令时如需处理中文输出，优先用 chcp 65001 切换到 UTF-8 代码页，或对输出做编码转换。`;
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
// 5. 用户覆盖文件加载
// ============================================================

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
    console.warn(`[agent-prompt] 无法读取 ${filePath}`);
    return null;
  }
}

// ============================================================
// preHook —— 装配入口
// ============================================================

const preHook: PreProcessHook = async (ctx: AgentContext): Promise<AgentContext> => {
  const promptCfg = cfg(ctx.runtimeConfig);
  const tools = ctx.availableTools ?? [];
  const agentId = ctx.receiver;

  // ---- 技能发现（仅当开关开启） ----
  let skills: SkillManifest[] = [];
  let agentDirName = '';
  const agentDir = resolveAgentDir(agentId);
  if (agentDir) {
    agentDirName = path.basename(agentDir);
    if (promptCfg.skills) {
      skills = discoverSkills(agentDir);
    }
  }

  // ---- MCP 工具发现（仅当开关开启） ----
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

        // 将 MCP 工具注册到 ctx.meta，供 Agent.run() 注册为可执行 Tool
        const mcpToolMap: Record<string, { serverName: string; tool: MCPToolDef }> = {};
        for (const d of discoveries) {
          if (!d.connected) continue;
          for (const tool of d.tools) {
            mcpToolMap[tool.name] = { serverName: d.serverName, tool };
          }
        }
        ctx.meta!['mcp'] = { toolMap: mcpToolMap, manager };

        console.log(`[agent-prompt] MCP 发现: ${mcpDiscoveries.length} 个服务器, ${mcpDiscoveries.reduce((s, d) => s + d.tools.length, 0)} 个工具`);
      } catch (err: any) {
        console.warn(`[agent-prompt] MCP 发现失败: ${err.message}`);
      }
    }
  }

  // ---- SYSTEM.md 完全覆盖路径 ----
  if (agentDir) {
    const systemContent = tryLoadFile(path.join(agentDir, 'SYSTEM.md'));
    if (systemContent) {
      // 完全覆盖：只用 SYSTEM.md + MCP 工具 + 尾部信息，不追加 AGENT.md
      const tail = buildTailBlock(agentId, ctx.sender, promptCfg.systemEnv, promptCfg.datetime, promptCfg.conversationPartner, ctx.room_id, agentDirName);

      // MCP 工具仍然追加（即使在 SYSTEM.md 覆盖模式下）
      const mcpBlocks: string[] = [];
      if (promptCfg.mcp && mcpDiscoveries.length > 0) {
        const mcpToolsBlock = buildMCPToolsBlock(mcpDiscoveries);
        if (mcpToolsBlock) mcpBlocks.push(mcpToolsBlock);
        const mcpResourcesBlock = buildMCPResourcesBlock(mcpDiscoveries);
        if (mcpResourcesBlock) mcpBlocks.push(mcpResourcesBlock);
      }
      const mcpSection = mcpBlocks.length > 0 ? '\n\n' + mcpBlocks.join('\n\n') : '';

      const systemPrompt = `${systemContent}${mcpSection}\n\n${tail}`;
      console.log(`[agent-prompt] Agent "${agentId}" 使用 SYSTEM.md 完全覆盖`);
      return { ...ctx, systemPrompt };
    }
  }

  // ---- 默认装配路径 ----
  // 顺序：工具 → 指引 → MCP → 技能 → AGENT.md → 日期 + CWD + 环境
  const blocks: string[] = [];

  if (promptCfg.tools) {
    const block = buildToolsBlock(tools);
    if (block) blocks.push(block);
  }
  if (promptCfg.guidelines) {
    const block = buildGuidelinesBlock(tools, skills.length);
    if (block) blocks.push(block);
  }
  if (promptCfg.mcp && mcpDiscoveries.length > 0) {
    const mcpToolsBlock = buildMCPToolsBlock(mcpDiscoveries);
    if (mcpToolsBlock) blocks.push(mcpToolsBlock);

    const mcpResourcesBlock = buildMCPResourcesBlock(mcpDiscoveries);
    if (mcpResourcesBlock) blocks.push(mcpResourcesBlock);
  }
  if (promptCfg.skills) {
    const block = buildSkillsBlock(skills, agentDirName);
    if (block) blocks.push(block);
  }

  // AGENT.md 追加
  if (agentDir) {
    const agentContent = tryLoadFile(path.join(agentDir, 'AGENT.md'));
    if (agentContent) {
      blocks.push(`## 角色\n<persona>\n${agentContent}\n</persona>`);
      console.log(`[agent-prompt] Agent "${agentId}" 已追加 AGENT.md`);
    }
  }

  // 尾部：日期 + CWD + 环境 + 常设文件路径（始终在最后）
  blocks.push(buildTailBlock(agentId, ctx.sender, promptCfg.systemEnv, promptCfg.datetime, promptCfg.conversationPartner, ctx.room_id, agentDirName));

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

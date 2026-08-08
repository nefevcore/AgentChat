// ============================================================
// src/plugins/builtin/hooks/prompt.ts —— 提示词装配（照搬旧 agent-prompt 完整装配链）
//
// 合并了原 agent-context、agent-skill、windows-environment、datetime 的功能。
//
// 装配流程（照搬旧，在单个装配函数内原子化完成）：
//   阶段 1：框架装配（默认路径 — 按缓存友好顺序排列，静态在前、动态在后）
//     角色  →  系统环境  →  [术语约定]  →  标签约定  →  指引  →  技能  →  持久化存储  →  对话信息
//   阶段 2：SYSTEM.md 覆盖
//     如果 <agent>/SYSTEM.md 存在，完全替换上述装配结果，仅追加 术语约定(按需) + 标签约定 + 对话信息。
//
// 适配新架构：
//   · 旧 preHook 返回新 systemPrompt → 本文件导出 buildSystemPrompt(config, deps)
//     （L5 装配 AgentAssembly.systemPrompt 调用）。时间信息已在装配中涵盖，
//     工具清单由 LLM tool 定义承载 —— 不再单独注入。
//   · 旧 ctx.runtimeConfig → getNamespaceConfig(config, NS_AGENT_PROMPT)
//   · 旧 getAppState().router.getGroupManager → deps.router.getGroupManager
//   · 旧 resolveAgentLabel（读 config.json）→ deps.agentsDir 扫描
//   · isSupervised → 环境变量
//
// 依赖方向：仅依赖 src/core + @agents/config + 本层 types + Node 内置。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '@core/logger';
import { getNamespaceConfig } from '@agents/config';
import { NS_AGENT_PROMPT } from '../namespaces';
import type { AgentConfig } from '@agents/config';
import type { PluginServices } from '../../types';
import type { LLMRequestMessage } from '@core/types';
import { isSupervised } from '@utils/supervisor';

const logger = createLogger('[agent-prompt]');

// ============================================================
// 基础工具函数（照搬旧）
// ============================================================

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 尝试加载指定文件内容（剥离 YAML frontmatter） */
function tryLoadFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    let content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return null;
    content = content.replace(/^---[\s\S]*?---\n*/, '').trim();
    return content || null;
  } catch {
    logger.warn(`无法读取 ${filePath}`);
    return null;
  }
}

/** 是否 Supervisor 模式（横切工具，见 @utils/supervisor） */

// ============================================================
// Agent 目录解析（照搬旧 resolveAgentDir / resolveAgentLabel）
// ============================================================

function resolveAgentDir(agentId: string, agentsDir: string): string | null {
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

/** 解析 Agent ID 的友好显示名称（优先 config.json name，回退 id） */
function resolveAgentLabel(id: string, agentsDir: string): string {
  const dir = resolveAgentDir(id, agentsDir);
  if (!dir) return id;
  try {
    const cfgPath = path.join(dir, 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg.name) return cfg.name;
    }
  } catch { /* fall through */ }
  return id;
}

// ============================================================
// Block 2: 系统环境（照搬旧）
// ============================================================

function buildEnvBlock(agentId: string): string {
  const lines: string[] = [];
  lines.push('## 系统环境');

  const cwd = `./files/${agentId}/`;
  lines.push(`[工作目录] ${cwd}`);

  const platform = process.platform;
  const arch = process.arch;
  const osName = platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform === 'darwin' ? 'macOS' : platform;
  let block = `[运行环境] ${osName}`;
  if (arch) block += ` (${arch})`;

  if (platform === 'win32') {
    block += ` — PowerShell 7 (pwsh), ; 链接命令, \\ 路径分隔符, $env: 环境变量`;
    block += `\n[编码] 文件读写用 UTF-8；Shell 中文输出先设 \`[Console]::OutputEncoding=UTF8\`；cmd 子命令前加 \`chcp 65001\``;
    block += `\n[引号] PowerShell 用反引号 \` 转义（非反斜杠 \\）。内联 node -e 含 \\\" 会坏；复杂引号/HTML/JSON 写临时 .js/.ps1 文件再执行（\`node _tmp_x.js\`）`;
  } else if (platform === 'linux') {
    block += ` — bash, && 链接命令, / 路径分隔符, $ 环境变量`;
  } else if (platform === 'darwin') {
    block += ` — zsh, && 链接命令, / 路径分隔符, $ 环境变量`;
  }

  lines.push(block);

  return lines.join('\n');
}

// ============================================================
// Block 3: 术语约定（照搬旧）
// ============================================================

const COLLAB_TOOLS = ['send_agent', 'list_agents', 'query_history', 'read_agent_info', 'update_agent_profile', 'send_group', 'list_groups'];

function hasCollaborationTools(tools: Array<{ name: string }>): boolean {
  const names = new Set(tools.map(t => t.name));
  return COLLAB_TOOLS.some(n => names.has(n));
}

function buildTerminologyBlock(): string {
  const lines: string[] = [];
  lines.push('## 术语约定');
  lines.push('');
  lines.push('以下术语映射关系帮助你正确理解系统指令。请始终以工具名中的术语为准。');
  lines.push('');
  lines.push('- Agent — 本系统中所有对话参与者的统称，包括普通 Agent（AI 实体）和虚拟 Agent（用户）。`send_agent`、`list_agents`、`query_history`、`read_agent_info` 均可操作任意 Agent；仅 `update_agent_profile` 限你自己（普通 Agent），系统拦截器会强制拒绝修改他人档案。');
  lines.push('- 群聊 (group) — 多个 Agent 共同参与的消息广播空间。工具 `send_group` 用于向群聊发送消息（含回复群聊消息与主动发起），`list_groups` 用于查看可用群聊。');
  lines.push('- 对话对象 — 当前与你直接通信的实体。对话信息中的 `[当前对话对象]` 即指此实体。');
  lines.push('');
  return lines.join('\n');
}

// ============================================================
// Block 4: 标签约定（照搬旧）
// ============================================================

function buildFormatGuidelinesBlock(): string {
  const lines: string[] = [];
  lines.push('## 标签约定');
  lines.push('');
  lines.push('- 使用 <file path="./files/<agent_id>/file.ext">文件名</file> 引用本地文件。');
  lines.push('- 标签 <msg from="agent_id" name="" group="">消息内容</msg> 表示群聊中其他Agent发出的消息。group 属性为群聊名，用于标识消息来自哪个群聊；1:1 对话中的消息不带 group 属性。');
  lines.push('- 标签 <trigger>hint</trigger> 表示系统自动触发的指令（定时任务/自对话/归档整理等），非用户或 Agent 的对话消息。');
  lines.push('');
  return lines.join('\n');
}

// ============================================================
// Block 5: 指引（照搬旧，按工具门控）
// ============================================================

function buildGuidelinesBlock(
  tools: Array<{ name: string }>,
  skillCount: number,
  tags?: string[],
): string {
  const toolNames = new Set(tools.map(t => t.name));
  const isAdmin = tags?.includes('admin') ?? false;
  const list: string[] = [];
  const seen = new Set<string>();

  const add = (g: string): void => {
    const normalized = g.trim();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    list.push(normalized);
  };

  const has = (...names: string[]) => names.every(n => toolNames.has(n));

  // 1. 文件操作
  if (has('read', 'write', 'edit')) {
    add('文件操作：先 read 再 edit（Hashline DSL 语法见 edit 工具定义），勿用 write 覆盖；探索文件系统优先 read，复杂操作才用 bash。');
  } else if (has('read', 'write') && !toolNames.has('edit')) {
    add('文件操作：edit 不可用，修改文件需先 read 再用 write 写入完整内容。');
  }

  // 2. 命令执行
  if (toolNames.has('bash')) {
    add('命令执行：执行 Shell 命令前确认当前目录和上下文，避免误操作。启动长驻服务（后端、定时任务等）用 background: true 参数：detached 后台执行 + 日志写临时文件，立即返回 PID 不阻塞，完成后可用 Stop-Process -Id <pid> 停止。');
  }

  // 3. 多 Agent 协作
  if (has('list_agents', 'send_agent')) {
    add('多Agent协作：先用 list_agents 查看可用Agent，再用 send_agent 向其他Agent发送消息获取帮助。send_agent 是 fire-and-forget（不等待回复），对方处理完会通过 send_agent 回消息形成会话循环。');
  } else if (toolNames.has('list_agents')) {
    add('多Agent协作：用 list_agents 查看可用Agent及其类型。');
  }
  if (toolNames.has('read_agent_info')) {
    add('Agent档案查询：read_agent_info 读取 Agent 的公开信息（名称/描述/标签；查他人返回你对该 Agent 的记忆）。隐私边界由系统拦截器强制。');
  }
  if (toolNames.has('query_history')) {
    add('历史回忆：query_history 查询与某 Agent/群聊的聊天历史（keyword 过滤、limit 分页），回忆过往上下文用。');
  }

  // 4. 定时任务（按工具门控：声明 timer 工具才注入）
  if (has('list_timers', 'set_timer', 'disable_timer')) {
    add('定时任务：list_timers 查看已有任务，set_timer 添加/修改（mode: delay/random/time/workday/holiday，repeatCount=0 永久；一次性提醒用 repeatCount=1 + 完整日期时间，如 2026-08-03 09:00，完成后自动归档），disable_timer 禁用。你拥有主动发起对话和定时任务的能力——自主判断哪些事项值得持续跟进或适时提醒，主动用 set_timer 安排，不必等用户指令。');
  }

  // 5. 子 Agent
  if (has('spawn_subagent', 'await_subagent', 'list_subagents', 'kill_subagent')) {
    add('子Agent调度：复杂任务可 spawn_subagent 拆分子任务（独立上下文、受控工具集、不写 sessions）。用 await_subagent 取结果，list_subagents 查进度，kill_subagent 终止。适合并行分解复杂任务。');
  } else if (toolNames.has('spawn_subagent')) {
    add('子Agent调度：spawn_subagent 创建独立子任务（隔离上下文），await_subagent 取结果。');
  }

  // 6. 自我能力
  if (toolNames.has('continue_turn')) {
    add('自我续推：回复已完成但你还想自主推进后续工作时，用 continue_turn 让系统自动开始下一轮（传 hint 引导方向），无需用户发新消息。');
  }
  if (toolNames.has('update_agent_profile')) {
    add('自我档案：严禁编辑其他Agent的档案（系统拦截器强制拒绝）。update_agent_profile 更新自己的身份信息（名称/描述/persona/头像）与能力清单（tags/plugins）。非管理员不能给自己打 admin 标签。');
  }
  if (toolNames.has('list_tools')) {
    add('工具自查：list_tools 列出当前声明启用的工具。工具按能力标签（requires）门控：基础工具（agent）人人可用；dev 工具（code_search/reload/inspect_session/read_logs/browser）需 dev 标签；conductor 工具（子 Agent 调度）需 conductor 标签；system_restart 需 admin 标签。想要更多工具 → 在配置 plugins 中声明，并确保自己具备对应能力标签（update_agent_profile 管理 tags）。');
  }

  // 7. 开发管理
  const devTips: string[] = [];
  if (toolNames.has('reload')) {
    devTips.push('reload 热加载配置（scope=self 重载自己；scope=global 重载全部 Agent；scope=all 两者。修改内置工具/钩子源码后调用 scope=global 生效）');
  }
  if (toolNames.has('inspect_session')) {
    devTips.push('inspect_session 检查会话消息文件（stats/过滤/尾部/重复检测），调试持久化问题');
  }
  if (devTips.length > 0) {
    add(`开发管理：${devTips.join('；')}。工具开发详细指引见 ./files/shared/tool-dev-guide.md`);
  }

  // 8. 系统管理（admin，仅 Supervisor 模式）
  if (isSupervised() && (toolNames.has('system_restart') || isAdmin)) {
    add('系统管理：system_restart 是 admin 层管理工具（不可被其他 Agent 发现）：修改 src/core/、src/app/、src/server/ 等核心代码后调用它重启后端（Supervisor 模式自动拉起，WS 约 2s 重连）。危险操作，仅在确实需要进程级重启时使用。');
  }

  if (skillCount > 0) {
    add(`当前配置了 ${skillCount} 个技能，任务匹配时用 read 加载对应 SKILL.md`);
  }

  if (list.length === 0) return '';

  const numbered = list.map((g, i) => `${i + 1}. ${g}`);
  return `## 指引\n${numbered.join('\n')}`;
}

// ============================================================
// Block 6: 技能发现与展示（照搬旧）
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
    return null;
  }

  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
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
      logger.info(`发现技能: ${manifest.name} (${entry.name})`);
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
// Block 7: 持久化存储（对齐新存储架构：记忆集中管理 + ~ 分隔符会话）
// ============================================================

function buildStorageBlock(agentId: string, agentDirName?: string): string {
  if (!agentDirName) return '';
  const filesDir = `./files/${agentId}/`;
  const lines: string[] = [];
  lines.push('## 持久化存储');
  lines.push(`[待办清单] ${filesDir}TODO.md — 唯一任务追踪文件，持续维护`);
  lines.push(`[已完成记录] ${filesDir}DONE.md — 历史已完成项归档。TODO 只保留未完成项；新完成的事项直接记 DONE.md，并更新TODO`);
  lines.push(`[知识笔记] ${filesDir}note/ — 持久知识库；先 read note/note_index 定位，再 read 目标文件；优先更新已有笔记避免冗余`);
  lines.push(`[临时文件] ${filesDir}_tmp/ — 临时文件目录，任务完成后及时清理`);
  lines.push(`[记忆文件] ${filesDir}memory/<对象ID>.memory.md — 集中管理于 memory/ 目录，每对话对象一份（1v1 为对方 Agent id，群聊为 group~<群聊ID>）、独立隔离；收到 [归档整理] trigger 后进行记忆更新；更新记忆后删除 <对象ID>.memory_review_needed 标记`);
  return lines.join('\n');
}

// ============================================================
// Block 8: 对话信息（动态，置于最后）
// ============================================================

function buildSessionBlock(
  agentId: string,
  sender: string,
  includeDatetime: boolean,
  includePartner: boolean,
  groupId: string | undefined,
  deps: PluginServices,
): string {
  const lines: string[] = [];
  lines.push('## 对话信息');

  if (includePartner) {
    if (groupId) {
      let participantList = '';
      let groupDescription = '';
      try {
        const gm = deps.router?.getGroupManager() as any;
        const group = gm?.getGroup?.(groupId);
        if (group?.participants) {
          const names = group.participants.map((p: string) => {
            try {
              const label = resolveAgentLabel(p, deps.agentsDir ?? '');
              return label !== p ? `${label} (${p})` : p;
            } catch { return p; }
          });
          participantList = names.join('、');
        }
        if (group?.description) {
          groupDescription = group.description;
        }
      } catch { /* 降级 */ }

      lines.push(`[当前群聊] ${groupId}`);
      if (participantList) lines.push(`[群聊成员] ${participantList}`);
      if (groupDescription) lines.push(`[群聊简介] ${groupDescription}`);
    } else {
      const label = resolveAgentLabel(sender, deps.agentsDir ?? '');
      const selfNote = sender === agentId ? '（自己）' : '';
      lines.push(`[当前对话对象] ${sender} - ${label}${selfNote}`);
    }
  }

  if (includeDatetime) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    lines.push(`[当前时间] ${weekdays[now.getDay()]} ${dateStr}`);
  }

  return lines.join('\n');
}

// ============================================================
// 装配入口（照搬旧 preHook 逻辑）
// ============================================================

/** 装配所需的输入（L5 AgentAssembly.systemPrompt 传入） */
export interface SystemPromptDeps {
  /** 工具名列表（用于指引/术语约定门控；缺省空） */
  toolNames?: string[];
  /** 对话对象（sender） */
  sender?: string;
  /** 群组 ID（可选） */
  groupId?: string;
}

/** 提示词命名空间配置（agent.prompt） */
export interface PromptConfig {
  guidelines: boolean;
  systemEnv: boolean;
  skills: boolean;
  datetime: boolean;
  conversationPartner: boolean;
}

function promptConfig(config: AgentConfig): PromptConfig {
  const ns = getNamespaceConfig(config, NS_AGENT_PROMPT);
  return {
    guidelines: ns.guidelines !== false,
    systemEnv: ns.systemEnv !== false,
    skills: ns.skills !== false,
    datetime: ns.datetime !== false,
    conversationPartner: ns.conversationPartner !== false,
  };
}

/**
 * 完整 systemPrompt 装配（照搬旧 agent-prompt preHook）。
 * 由 L5 AgentAssembly.systemPrompt 调用：deps 提供工具清单/对话对象。
 */
export function buildSystemPrompt(
  config: AgentConfig,
  deps: PluginServices,
  input: SystemPromptDeps = {},
): string {
  const promptCfg = promptConfig(config);
  const tools = (input.toolNames ?? []).map(name => ({ name }));
  const agentId = config.agent_id;
  const tags = config.tags ?? [];

  const agentsDir = deps.agentsDir ?? '';
  const fullTools = tools;

  // 技能发现
  let skills: SkillManifest[] = [];
  let agentDirName = '';
  const agentDir = resolveAgentDir(agentId, agentsDir);
  if (agentDir) {
    agentDirName = path.basename(agentDir);
    if (promptCfg.skills) {
      skills = discoverSkills(agentDir);
    }
  }

  // ---- SYSTEM.md 完全覆盖路径 ----
  if (agentDir) {
    const systemContent = tryLoadFile(path.join(agentDir, 'SYSTEM.md'));
    if (systemContent) {
      const appended: string[] = [];
      if (hasCollaborationTools(fullTools)) appended.push(buildTerminologyBlock());
      appended.push(buildFormatGuidelinesBlock());
      appended.push(buildSessionBlock(agentId, input.sender ?? 'user', promptCfg.datetime, promptCfg.conversationPartner, input.groupId, deps));
      logger.info(`Agent "${agentId}" 使用 SYSTEM.md 完全覆盖`);
      return `${systemContent}\n\n${appended.join('\n\n')}`;
    }
  }

  // ---- 默认装配路径 ----
  const blocks: string[] = [];

  // 1. 角色（AGENT.md）
  if (agentDir) {
    const agentContent = tryLoadFile(path.join(agentDir, 'AGENT.md'));
    if (agentContent) {
      blocks.push(`## 角色\n<persona>\n${agentContent}\n</persona>`);
      logger.info(`Agent "${agentId}" 已追加 AGENT.md`);
    }
  }

  // 2. 系统环境
  if (promptCfg.systemEnv) {
    blocks.push(buildEnvBlock(agentId));
  }

  // 3. 术语约定
  if (hasCollaborationTools(fullTools)) {
    blocks.push(buildTerminologyBlock());
  }

  // 4. 标签约定
  blocks.push(buildFormatGuidelinesBlock());

  // 5. 指引
  if (promptCfg.guidelines) {
    const block = buildGuidelinesBlock(fullTools, skills.length, tags);
    if (block) blocks.push(block);
  }

  // 6. 技能清单
  if (promptCfg.skills) {
    const block = buildSkillsBlock(skills, agentDirName);
    if (block) blocks.push(block);
  }

  // 7. 持久化存储
  blocks.push(buildStorageBlock(agentId, agentDirName));

  // 8. 对话信息（动态，置于最后）
  blocks.push(buildSessionBlock(agentId, input.sender ?? 'user', promptCfg.datetime, promptCfg.conversationPartner, input.groupId, deps));

  return blocks.join('\n\n');
}

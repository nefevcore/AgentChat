// ====================================================================
// agent-skill 扩展 —— 技能清单加载器
//
// 概述：
//   本扩展在 preHook 阶段扫描 Agent 专属技能目录
//   （./agents/<agent_id>/skills/*），解析每个技能 SKILL.md 的
//   YAML frontmatter 获取名称和描述，生成技能清单并注入系统提示词。
//
//   注入的提示词告知 LLM：当需要使用某个技能时，可通过 read 工具
//   读取对应 SKILL.md 获取完整指令。
//
// ── 技能目录约定 ──
//   · 每个技能是一个子目录，目录名即技能标识
//   · 技能目录内必须有 SKILL.md（含 YAML frontmatter）
//   · YAML frontmatter 必须包含 name 字段，可选 description 字段
//
// ── 使用方式 ──
//   在 Agent 的 config.json 中配置：
//   { "pre_hooks": ["agent-skill", ...] }
// ====================================================================

import * as fs from 'fs';
import * as path from 'path';
import { AgentContext, Extension, PreProcessHook } from '../../../core/types';
import { getGlobalConfig } from '../../../core/config';

// ====================================================================
// 类型定义
// ====================================================================

interface SkillManifest {
  /** SKILL.md frontmatter 中的 name 字段 */
  name: string;
  /** SKILL.md frontmatter 中的 description 字段 */
  description: string;
  /** 技能目录名（如 "sap-abap"） */
  dirName: string;
}

// ====================================================================
// YAML frontmatter 解析
// ====================================================================

/**
 * 从 SKILL.md 的 YAML frontmatter 中提取 name 和 description。
 * 返回 null 表示解析失败（无 SKILL.md 或无有效 frontmatter）。
 */
function parseSkillFrontmatter(skillMdPath: string, dirName: string): SkillManifest | null {
  if (!fs.existsSync(skillMdPath)) return null;

  let content: string;
  try {
    content = fs.readFileSync(skillMdPath, 'utf-8');
  } catch {
    console.warn(`[agent-skill] 无法读取 ${skillMdPath}`);
    return null;
  }

  // 匹配 YAML frontmatter：以 --- 开头，下一个 --- 结束
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    console.warn(`[agent-skill] ${skillMdPath} 无有效 YAML frontmatter`);
    return null;
  }

  const fm = fmMatch[1];

  // 解析 name（单行值）
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : dirName;

  // 解析 description（支持多行，使用 | 语法）
  const descMatch = fm.match(/^description:\s*\|\s*\n([\s\S]*?)(?=^[a-zA-Z]|\Z)/m);
  let description = '';
  if (descMatch) {
    // description: | 的多行值，去掉每行前导空格
    description = descMatch[1]
      .split('\n')
      .map((line) => line.replace(/^\s{2,}/, '').trimEnd())
      .filter(Boolean)
      .join(' ');
  } else {
    // 尝试单行匹配
    const descSingleMatch = fm.match(/^description:\s*(.+)$/m);
    if (descSingleMatch) {
      description = descSingleMatch[1].trim().replace(/^["']|["']$/g, '');
    }
  }

  return { name, description, dirName };
}

// ====================================================================
// Agent 目录解析
// ====================================================================

/**
 * 根据 agent_id 找到对应的 Agent 配置目录。
 * 由于目录名可能与 agent_id 不完全一致（如目录 "coding" ↔ agent_id "coding_agent"），
 * 需要遍历 agentsDir 下所有子目录，读取各自的 config.json 进行匹配。
 *
 * @returns Agent 目录的绝对路径，找不到返回 null
 */
function resolveAgentDir(agentId: string): string | null {
  const agentsDir = getGlobalConfig().agentsDir;

  if (!fs.existsSync(agentsDir)) return null;

  // 先尝试直接匹配（目录名 = agent_id 的情况）
  const directDir = path.join(agentsDir, agentId);
  if (fs.existsSync(directDir) && fs.statSync(directDir).isDirectory()) {
    const cfgPath = path.join(directDir, 'config.json');
    if (fs.existsSync(cfgPath)) {
      return directDir;
    }
  }

  // 遍历所有子目录，读取 config.json 匹配 agent_id
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const cfgPath = path.join(agentsDir, entry.name, 'config.json');
    if (!fs.existsSync(cfgPath)) continue;

    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg.agent_id === agentId) {
        return path.join(agentsDir, entry.name);
      }
    } catch {
      // 跳过无法解析的 config.json
    }
  }

  return null;
}

// ====================================================================
// 技能发现
// ====================================================================

/**
 * 扫描 Agent 专属技能目录，解析所有 SKILL.md 的 frontmatter。
 * @param agentDir Agent 配置目录的绝对路径
 */
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
      console.log(`[agent-skill] 发现技能: ${manifest.name} (${entry.name})`);
    }
  }

  // 按 name 排序，保证输出稳定
  skills.sort((a, b) => a.name.localeCompare(b.name));

  return skills;
}

// ====================================================================
// 提示词生成
// ====================================================================

/**
 * 将技能清单生成为系统提示词块。
 * 告知 LLM 可用技能列表及其路径，引导其通过 read 工具读取 SKILL.md。
 */
function buildSkillsBlock(skills: SkillManifest[], agentDirName: string): string {
  if (skills.length === 0) return '';

  const lines: string[] = [];
  lines.push('');
  lines.push('可用技能：');

  for (const skill of skills) {
    const desc = skill.description.length > 150
      ? skill.description.slice(0, 147) + '...'
      : skill.description;
    lines.push(` - [${skill.name}] ${desc}`);
  }

  lines.push('');
  lines.push(
    `如需使用技能，请使用 \`read\` 工具读取路径 \`./agents/${agentDirName}/skills/<技能名>/SKILL.md\` 下的技能内容。`
  );
  lines.push('');

  return lines.join('\n');
}

// ====================================================================
// preHook —— 在 systemPrompt 尾部注入技能清单
// ====================================================================

const preHook: PreProcessHook = async (ctx: AgentContext): Promise<AgentContext> => {
  const agentId = ctx.receiver;

  // 1. 解析 Agent 目录
  const agentDir = resolveAgentDir(agentId);
  if (!agentDir) {
    console.warn(`[agent-skill] 无法找到 Agent "${agentId}" 的配置目录`);
    return ctx;
  }

  // 2. 发现技能
  const skills = discoverSkills(agentDir);
  if (skills.length === 0) return ctx;

  // 3. 生成技能提示块
  const agentDirName = path.basename(agentDir);
  const skillsBlock = buildSkillsBlock(skills, agentDirName);

  // 4. 注入系统提示词
  const systemPrompt = `${ctx.systemPrompt}\n\n${skillsBlock}`;

  console.log(
    `[agent-skill] Agent "${agentId}" 已加载 ${skills.length} 个技能：` +
      skills.map((s) => s.name).join(', ')
  );

  return { ...ctx, systemPrompt };
};

// ====================================================================
// Extension 统一入口
// ====================================================================

export const extension: Extension = {
  meta: {
    name: 'agent-skill',
    description:
      '加载 Agent 专属技能清单',
  },
  preHook,
};

// ============================================================
// src/plugins/builtin/hooks/skills.ts —— 技能发现与展示（自 prompt.ts 拆出，对齐 mcp.ts 独立文件）
//
// 仅负责：发现 Agent 技能目录（<agentDir>/skills/*/SKILL.md）→ 解析 frontmatter
// → 渲染 <available_skills> 区块（由 build-system-prompt 装配注入）。
//
// 适配新架构：
//   · 旧 agent-skill 逻辑（parseSkillFrontmatter/discoverSkills/buildSkillsBlock）
//     自 src/plugins/builtin/hooks/prompt.ts 迁出（2026-08-08），prompt.ts 仅保留装配编排。
//   · 技能路径：<agentsDir>/<agentDirName>/skills/<dirName>/SKILL.md
//
// 依赖方向：仅依赖 Node fs/path + @core/logger（无其他层依赖）。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '@core/logger';
import type { CurrentContext, RunStartHook } from '@core/context';
import type { AgentConfig } from '@agents/config';
import { getNamespaceConfig } from '@agents/config';
import type { PluginServices } from '../../types';
import { NS_AGENT_PROMPT } from '../namespaces';
import { resolveAgentDir } from './prompt';

const logger = createLogger('[agent-skills]');

// ============================================================
// 类型（SKILL.md frontmatter 清单）
// ============================================================

export interface SkillManifest {
  name: string;
  description: string;
  dirName: string;
}

// ============================================================
// 基础工具
// ============================================================

/** XML 转义（渲染 <available_skills> 用） */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ============================================================
// frontmatter 解析
// ============================================================

/** 解析 SKILL.md 的 YAML frontmatter（name/description），失败返回 null */
export function parseSkillFrontmatter(skillMdPath: string, dirName: string): SkillManifest | null {
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

// ============================================================
// 技能发现
// ============================================================

/** 扫描 agentDir/skills 下各 SKILL.md，返回按名称排序的技能清单 */
export function discoverSkills(agentDir: string): SkillManifest[] {
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

// ============================================================
// 渲染（<available_skills> 区块）
// ============================================================

/** 渲染技能清单为 system prompt 的「可用技能」区块（无技能返回空串） */
export function buildSkillsBlock(skills: SkillManifest[], agentDirName: string): string {
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
// 独立注入钩子（对齐 mcp.ts makeOpenMCPHook：技能单独构造，不混入 build-system-prompt）
// ============================================================

/**
 * runStart：发现并注入技能清单到 ctx.systemPrompt 末尾。
 * 独立于 build-system-prompt（该钩子只装配角色/环境/指引/存储，不含技能）。
 * 执行顺序由插件 runStart 声明控制（builtin.discovered_skills 置于 open-mcp 前）。
 */
export function makeInjectSkillsHook(config: AgentConfig, services: PluginServices): RunStartHook {
  return async (ctx: CurrentContext): Promise<void> => {
    // 与 build-system-prompt 的 skills 开关保持一致（agent.prompt.skills !== false）
    const ns = getNamespaceConfig(config, NS_AGENT_PROMPT);
    if (ns.skills === false) return;

    const agentsDir = services.agentsDir;
    if (!agentsDir) return;
    const agentDir = resolveAgentDir(config.agent_id, agentsDir);
    if (!agentDir) return;

    const agentDirName = path.basename(agentDir);
    const skills = discoverSkills(agentDir);
    const block = buildSkillsBlock(skills, agentDirName);
    if (block) {
      ctx.systemPrompt = ctx.systemPrompt ? `${ctx.systemPrompt}\n\n${block}` : block;
    }
  };
}

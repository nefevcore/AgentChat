// ============================================================
// ac-skill-core/src/index.ts —— 技能发现/解析/渲染纯库
//
// src agent-skill 的 skills.ts 平移（零 cordis 依赖；发现算法住
// 纯库、注入行为住 ac-skill 行——"协议实现/重算法 → 纯库包"）：
//   · parseSkillFrontmatter  SKILL.md frontmatter 解析（name/description，
//                           纯函数：吃内容字符串，测试零 IO）
//   · discoverSkills         扫描 <skillsRoot>/<dirName>/SKILL.md，
//                           按名称排序返回清单
//   · buildSkillsBlock       渲染 <available_skills> 区块（system prompt
//                            尾部追加用；无技能返回空串）
//
// 目录形态（全局技能目录，M14）：<skillsRoot>/<dirName>/SKILL.md，
// frontmatter 需 name/description（description 支持单行与 | 多行两种）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** SKILL.md frontmatter 清单 */
export interface SkillManifest {
  /** 技能名（frontmatter name；缺失回退 dirName） */
  name: string;
  /** 技能描述（渲染时截断 200 字符） */
  description: string;
  /** 技能目录名（定位 SKILL.md 用） */
  dirName: string;
}

/** XML 转义（渲染 <available_skills> 用） */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 解析 SKILL.md 内容的 YAML frontmatter（name/description）。
 * 无 frontmatter / 空内容 → null（该目录不算技能）。
 * description 支持单行（`description: xxx`）与多行（`description: |`）。
 */
export function parseSkillFrontmatter(content: string, dirName: string): SkillManifest | null {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1] ?? '';

  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? (nameMatch[1] ?? '').trim().replace(/^["']|["']$/g, '') : dirName;

  let description = '';
  const descMatch = fm.match(/^description:\s*\|\s*\n([\s\S]*?)(?=^[a-zA-Z])/m);
  if (descMatch) {
    description = (descMatch[1] ?? '')
      .split('\n')
      .map((line) => line.replace(/^\s{2,}/, '').trimEnd())
      .filter(Boolean)
      .join(' ');
  } else {
    const descSingle = fm.match(/^description:\s*(.+)$/m);
    if (descSingle) {
      description = (descSingle[1] ?? '').trim().replace(/^["']|["']$/g, '');
    }
  }

  return { name, description, dirName };
}

/**
 * 扫描技能目录（<skillsRoot>/<dirName>/SKILL.md），返回按名称排序的清单。
 * 目录不存在/不可读 → 空清单（技能目录是可选实体）。
 */
export function discoverSkills(skillsRoot: string): SkillManifest[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(skillsRoot, entry.name, 'SKILL.md');
    let content: string;
    try {
      content = fs.readFileSync(skillMdPath, 'utf-8');
    } catch {
      continue;
    }
    const manifest = parseSkillFrontmatter(content, entry.name);
    if (manifest) skills.push(manifest);
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/** 白名单过滤（name 或 dirName 命中皆可；空白名单 = 全部） */
export function filterSkills(skills: SkillManifest[], whitelist?: string[]): SkillManifest[] {
  if (!whitelist || whitelist.length === 0) return skills;
  const allow = new Set(whitelist);
  return skills.filter((s) => allow.has(s.name) || allow.has(s.dirName));
}

/**
 * 渲染技能清单为 system prompt 的「可用技能」区块（无技能返回空串）。
 * locationPrefix = SKILL.md 的路径前缀提示（如 './data/skills'），
 * 模型据此用 read 工具加载完整指令。
 */
export function buildSkillsBlock(skills: SkillManifest[], locationPrefix: string): string {
  if (skills.length === 0) return '';

  const lines: string[] = [];
  lines.push('## 可用技能');
  lines.push('');
  lines.push('当任务匹配某个技能的描述时，使用 read 工具加载其 SKILL.md 获取完整指令。');
  lines.push('技能文件中引用的相对路径应相对于技能目录解析。');
  lines.push('');
  lines.push('<available_skills>');

  for (const skill of skills) {
    const location = `${locationPrefix}/${skill.dirName}/SKILL.md`;
    const desc =
      skill.description.length > 200 ? skill.description.slice(0, 197) + '...' : skill.description;
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(desc)}</description>`);
    lines.push(`    <location>${escapeXml(location)}</location>`);
    lines.push('  </skill>');
  }

  lines.push('</available_skills>');
  return lines.join('\n');
}

// ============================================================
// ac-skill-core/src/index.ts —— 技能发现/解析/渲染纯库
//
// src agent-skill 的 skills.ts 平移（零 cordis 依赖；发现算法住
// 纯库、注入行为住 ac-skill 行——"协议实现/重算法 → 纯库包"）：
//   · parseSkillFrontmatter  SKILL.md frontmatter 解析（name/description，
//                           纯函数：吃内容字符串，测试零 IO）
//   · readSkillBody          剥离 frontmatter 取正文（load_skill 工具用）
//   · isSkillName            技能名合法性校验（load_skill 参数面）
//   · discoverSkills         扫描 <skillsRoot>/<dirName>/SKILL.md，
//                           按名称排序返回清单
//   · filterSkills           白名单过滤（name 或 dirName；空白名单 = 全部）
//   · discoverWorkspaceSkills 扫描工作区根下的多生态约定技能目录
//                           （.claude/skills、.github/skills、skills、
//                           .agents/skills——同名先命中先得）
//   · buildSkillsBlock       渲染 <available_skills> 区块（system prompt
//                            尾部追加用；支持多来源分组：全局目录 + 某
//                            Agent 的私有技能目录，各自带 location 前缀）
//
// 目录形态：<skillsRoot>/<dirName>/SKILL.md，frontmatter 需
// name/description（description 支持单行与 | 多行两种）。
// 一个 <available_skills> 信封可承载多组技能（ac-skill 注入时把
// 全局白名单结果与本 Agent 专属结果并列渲染）。
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

/** 渲染分组：一组技能 + 该组 SKILL.md 的 location 路径前缀 */
export interface SkillGroup {
  skills: SkillManifest[];
  /** SKILL.md 路径提示前缀（如 './data/skills' 或 '<数据根>/files/<agent>/skills'） */
  locationPrefix: string;
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
 * 剥离 frontmatter 取正文（load_skill 工具把完整指令返回给模型用；
 * 目录发现已消费 frontmatter，正文不重复注入 system）。
 * 无 frontmatter → 全文返回；正文开头空行剥除、结尾空白修整。
 */
export function readSkillBody(content: string): string {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const body = fmMatch ? content.slice(fmMatch[0].length) : content;
  return body.replace(/^[\s]*\n/, '').trimEnd();
}

/** 技能名合法性：kebab-case（load_skill 参数面/目录名共识） */
export function isSkillName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
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

// ============================================================
// 工作区技能发现（多生态约定目录）
//
// singles 会话可挂载本机工作区；工作区里的技能目录按业界约定扫描，
// 让用户在 Claude Code / GitHub Copilot 等工具下维护的技能目录直接
// 被会话复用（同一份 SKILL.md，两处生效）。同名技能先命中先得
// （约定序即优先序），跨组按 name 去重——load_skill 按名定位，
// 同名多份会歧义。
// ============================================================

/**
 * 工作区技能目录约定（相对工作区根，先命中先得）：
 *   .claude/skills  Claude Code 项目技能（最广泛）
 *   .github/skills  GitHub Copilot agent skills
 *   skills          顶层 skills 目录（AgentChat 全局目录同布局 / 开放约定）
 *   .agents/skills  多 Agent 工具新兴约定
 */
export const WORKSPACE_SKILL_DIRS = ['.claude/skills', '.github/skills', 'skills', '.agents/skills'] as const;

/** 工作区技能组：一个约定目录 + 该目录下发现的技能 */
export interface WorkspaceSkillGroup {
  /** 约定目录相对路径（如 '.claude/skills'） */
  relDir: string;
  /** 约定目录绝对路径（load_skill 定位基准） */
  root: string;
  /** 展示用位置前缀（<工作区根>/<relDir>，POSIX 形） */
  locationPrefix: string;
  skills: SkillManifest[];
}

/**
 * 扫描工作区根下的全部约定技能目录：每目录一组 discoverSkills，
 * 跨组按 name 去重（约定序先命中先得）。目录不存在/不可读 → 该组空
 * （可选实体）；全部为空 → 空数组。
 */
export function discoverWorkspaceSkills(wsRoot: string): WorkspaceSkillGroup[] {
  const root = path.resolve(wsRoot);
  const seen = new Set<string>();
  const groups: WorkspaceSkillGroup[] = [];
  for (const rel of WORKSPACE_SKILL_DIRS) {
    const dir = path.join(root, ...rel.split('/'));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const skills = discoverSkills(dir).filter((s) => !seen.has(s.name));
    if (skills.length === 0) continue;
    for (const s of skills) seen.add(s.name);
    groups.push({
      relDir: rel,
      root: dir,
      locationPrefix: `${root.replace(/\\/g, '/')}/${rel}`,
      skills,
    });
  }
  return groups;
}

/**
 * 渲染多组技能为 system prompt 的「可用技能」区块（各组全空返回空串）。
 * groups 顺序即渲染顺序：ac-skill 注入时先全局（白名单过滤后）再本 Agent
 * 专属（files/<agent>/skills），单信封承载、按 <name>/<description>/
 * <location> 逐条列出——location 前缀区分来源，模型据此用 load_skill
 * 工具按名加载（首选）或用 read 工具按路径读取（回退）。
 */
export function buildSkillsBlock(groups: SkillGroup[]): string {
  const lines: string[] = [];
  let any = false;
  for (const group of groups) {
    const prefix = group.locationPrefix.replace(/\/+$/, '');
    for (const skill of group.skills) {
      any = true;
      const location = `${prefix}/${skill.dirName}/SKILL.md`;
      const desc =
        skill.description.length > 200 ? skill.description.slice(0, 197) + '...' : skill.description;
      lines.push('  <skill>');
      lines.push(`    <name>${escapeXml(skill.name)}</name>`);
      lines.push(`    <description>${escapeXml(desc)}</description>`);
      lines.push(`    <location>${escapeXml(location)}</location>`);
      lines.push('  </skill>');
    }
  }
  if (!any) return '';

  const header: string[] = [];
  header.push('## 可用技能');
  header.push('');
  header.push(
    '当任务匹配某个技能的描述时，先用 load_skill 工具按 <name> 加载该技能的完整指令并遵其执行；' +
      '若 load_skill 不可用，按 <location> 用 read 读取 SKILL.md。技能内相对路径以技能目录为基准解析。',
  );
  header.push('');
  header.push('<available_skills>');

  const footer: string[] = [];
  footer.push('</available_skills>');

  return [...header, ...lines, ...footer].join('\n');
}

// ============================================================
// ac-skill-core/tests/skill-core.test.ts —— frontmatter 解析/正文/渲染
// ============================================================
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSkillFrontmatter,
  readSkillBody,
  isSkillName,
  buildSkillsBlock,
  filterSkills,
  escapeXml,
  discoverWorkspaceSkills,
} from '../src/index';

describe('parseSkillFrontmatter', () => {
  it('单行 name/description', () => {
    const m = parseSkillFrontmatter('---\nname: pdf-export\ndescription: 导出 PDF\n---\n\n正文', 'pdf');
    expect(m).toEqual({ name: 'pdf-export', description: '导出 PDF', dirName: 'pdf' });
  });

  it('多行 description（| 块标量）', () => {
    const md = ['---', 'name: triage', 'description: |', '  对输入进行分类，', '  输出类别标签。', 'extra: 1', '---', 'body'].join('\n');
    const m = parseSkillFrontmatter(md, 'triage-dir');
    expect(m?.name).toBe('triage');
    expect(m?.description).toBe('对输入进行分类， 输出类别标签。');
  });

  it('name 缺失回退 dirName；引号剥离', () => {
    const m = parseSkillFrontmatter('---\nname: "quoted"\ndescription: d\n---\n', 'fallback');
    expect(m?.name).toBe('quoted');
    const noName = parseSkillFrontmatter('---\ndescription: d\n---\n', 'fallback');
    expect(noName?.name).toBe('fallback');
  });

  it('无 frontmatter / 空内容 → null', () => {
    expect(parseSkillFrontmatter('正文没有 frontmatter', 'x')).toBeNull();
    expect(parseSkillFrontmatter('---\nname: x\n', 'x')).toBeNull();
  });
});

describe('readSkillBody', () => {
  it('剥离 frontmatter，修整正文首尾空白', () => {
    const body = readSkillBody('---\nname: x\ndescription: d\n---\n\n# 标题\n\n正文行\n');
    expect(body).toBe('# 标题\n\n正文行');
  });

  it('无 frontmatter → 全文（仅尾部空白修整）', () => {
    expect(readSkillBody('  纯正文  ')).toBe('  纯正文');
  });
});

describe('isSkillName', () => {
  it('kebab-case 通过', () => {
    expect(isSkillName('pdf-export')).toBe(true);
    expect(isSkillName('a')).toBe(true);
    expect(isSkillName('a1-b2')).toBe(true);
  });
  it('非法名拒绝', () => {
    expect(isSkillName('')).toBe(false);
    expect(isSkillName('Pdf-Export')).toBe(false);
    expect(isSkillName('pdf_export')).toBe(false);
    expect(isSkillName('pdf export')).toBe(false);
    expect(isSkillName('-pdf')).toBe(false);
    expect(isSkillName('pdf-')).toBe(false);
  });
});

describe('filterSkills', () => {
  const skills = [
    { name: 'a', description: '', dirName: 'aa' },
    { name: 'b', description: '', dirName: 'bb' },
  ];
  it('空白名单 = 全部', () => {
    expect(filterSkills(skills)).toHaveLength(2);
    expect(filterSkills(skills, [])).toHaveLength(2);
  });
  it('name 或 dirName 命中', () => {
    expect(filterSkills(skills, ['a'])).toEqual([skills[0]]);
    expect(filterSkills(skills, ['bb'])).toEqual([skills[1]]);
  });
});

describe('buildSkillsBlock', () => {
  it('全空组 → 空串', () => {
    expect(buildSkillsBlock([])).toBe('');
    expect(buildSkillsBlock([{ skills: [], locationPrefix: './data/skills' }])).toBe('');
  });

  it('渲染 <available_skills>（location 前缀 + 描述截断 + XML 转义 + 引导词）', () => {
    const block = buildSkillsBlock([
      {
        skills: [{ name: 'pdf<&>', description: 'x'.repeat(300), dirName: 'pdf' }],
        locationPrefix: './data/skills',
      },
    ]);
    expect(block).toContain('<available_skills>');
    expect(block).toContain('load_skill 工具');
    expect(block).toContain('<name>pdf&lt;&amp;&gt;</name>');
    expect(block).toContain('<location>./data/skills/pdf/SKILL.md</location>');
    expect(block).toContain('...');
    expect(block.match(/x{197}\.\.\./)).toBeTruthy();
  });

  it('多组并列渲染：各自带 location 前缀，组序即渲染序', () => {
    const block = buildSkillsBlock([
      { skills: [{ name: 'g1', description: '全局', dirName: 'g1' }], locationPrefix: './data/skills' },
      { skills: [{ name: 'own1', description: '专属', dirName: 'own1' }], locationPrefix: './data/files/neko/skills' },
    ]);
    expect(block).toContain('<location>./data/skills/g1/SKILL.md</location>');
    expect(block).toContain('<location>./data/files/neko/skills/own1/SKILL.md</location>');
    expect(block.indexOf('g1')).toBeLessThan(block.indexOf('own1'));
  });
});

describe('escapeXml', () => {
  it('五类实体转义', () => {
    expect(escapeXml('<a>&"\'')).toBe('&lt;a&gt;&amp;&quot;&apos;');
  });
});

describe('discoverWorkspaceSkills', () => {
  it('多约定目录扫描（.claude/skills、.github/skills、skills、.agents/skills）+ 位置前缀 POSIX 形', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-skill-ws-'));
    try {
      const write = (rel: string, dirName: string, name: string) => {
        mkdirSync(join(tmp, rel, dirName), { recursive: true });
        writeFileSync(join(tmp, rel, dirName, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n正文`);
      };
      write(join('.claude', 'skills'), 'pdf', 'pdf-export');
      write(join('.github', 'skills'), 'review', 'code-review');
      write('skills', 'plain', 'plain-skill');
      write(join('.agents', 'skills'), 'agent', 'agent-skill');
      const groups = discoverWorkspaceSkills(tmp);
      expect(groups.map((g) => g.relDir)).toEqual(['.claude/skills', '.github/skills', 'skills', '.agents/skills']);
      expect(groups[0].skills.map((s) => s.name)).toEqual(['pdf-export']);
      expect(groups[0].locationPrefix).toBe(`${tmp.replace(/\\/g, '/')}/.claude/skills`);
      expect(groups[0].root).toBe(join(tmp, '.claude', 'skills'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('同名先命中先得（约定序即优先序，跨组按 name 去重）；空/缺目录跳过', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-skill-ws-'));
    try {
      const write = (rel: string, dirName: string, name: string) => {
        mkdirSync(join(tmp, rel, dirName), { recursive: true });
        writeFileSync(join(tmp, rel, dirName, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n正文`);
      };
      // 同名 pdf-export 在 .github/skills 与 skills 两处 → .github 先命中
      write(join('.github', 'skills'), 'pdf', 'pdf-export');
      write('skills', 'pdf', 'pdf-export');
      write('skills', 'other', 'other-skill');
      // 约定目录存在但无技能 → 不产组
      mkdirSync(join(tmp, '.claude', 'skills', 'no-skill-md'), { recursive: true });
      const groups = discoverWorkspaceSkills(tmp);
      expect(groups.map((g) => g.relDir)).toEqual(['.github/skills', 'skills']);
      const names = groups.flatMap((g) => g.skills.map((s) => s.name));
      expect(names).toEqual(['pdf-export', 'other-skill']);
      // 全空工作区 → 空数组
      const empty = mkdtempSync(join(tmpdir(), 'ac-skill-ws-'));
      try {
        expect(discoverWorkspaceSkills(empty)).toEqual([]);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

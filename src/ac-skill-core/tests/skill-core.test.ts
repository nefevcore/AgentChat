// ============================================================
// ac-skill-core/tests/skill-core.test.ts —— frontmatter 解析/渲染
// ============================================================
import { describe, it, expect } from 'vitest';
import { parseSkillFrontmatter, buildSkillsBlock, filterSkills, escapeXml } from '../src/index';

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
  it('无技能 → 空串', () => {
    expect(buildSkillsBlock([], './data/skills')).toBe('');
  });

  it('渲染 <available_skills>（location 前缀 + 描述截断 + XML 转义）', () => {
    const block = buildSkillsBlock(
      [
        { name: 'pdf<&>', description: 'x'.repeat(300), dirName: 'pdf' },
      ],
      './data/skills',
    );
    expect(block).toContain('<available_skills>');
    expect(block).toContain('<name>pdf&lt;&amp;&gt;</name>');
    expect(block).toContain('<location>./data/skills/pdf/SKILL.md</location>');
    expect(block).toContain('...');
    expect(block.match(/x{197}\.\.\./)).toBeTruthy();
  });
});

describe('escapeXml', () => {
  it('五类实体转义', () => {
    expect(escapeXml('<a>&"\'')).toBe('&lt;a&gt;&amp;&quot;&apos;');
  });
});

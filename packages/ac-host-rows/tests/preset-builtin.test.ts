// ============================================================
// preset-builtin 模板集单测（cr-540）：静态配置集解析 + 默认模板唯一 +
// 模板词形全部命中行集目录（行引用 ∨ 工具名 ∨ 捆绑词——防模板引用死行）。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listTemplates, readTemplate, TEMPLATE_DIR, materializeTemplateSkills, readAgentSkills } from '../src/preset-builtin.ts';
import { isPresetId } from 'ac-agents-core';
import { readCatalog, evaluateLegacyShellRows, SEAT_ROW_IDS } from 'ac-rowset-core';

const CATALOG = path.join(process.env.AGENTCHAT_REPO_ROOT ?? process.cwd(), 'apps', 'catalog', 'row-catalog.json');

describe('内置模板静态配置集（preset-builtin 行数据面）', () => {
  it('四模板全量解析：键/标签/次序/default 与身份配置', () => {
    const templates = listTemplates();
    expect(templates.map((t) => t.id)).toEqual(['standard', 'dsh-minimal', 'creator', 'abap-dev']);
    expect(templates.map((t) => t.label)).toEqual(['标准模式', '极简模式', '创造模式', 'ABAP开发模式']);
    expect(templates.filter((t) => t.default === true).map((t) => t.id)).toEqual(['standard']);
    expect(templates.map((t) => t.config.id)).toEqual(['__standard__', '__dsh_minimal__', '__creator__', '__abap_dev__']);
    for (const template of templates) {
      // cr-880：模板 config 不再携带 preset 字段——类属由物化目标 id 词形承载
      expect('preset' in template.config).toBe(false);
      expect(isPresetId(template.config.id)).toBe(true); // 模板 id 恒保留字词形
      expect(Array.isArray(template.config.rows)).toBe(true);
    }
  });

  it('模板词形全部命中行集目录：壳行集派生零 warnings（模板↔目录同源）', () => {
    const catalog = readCatalog(CATALOG);
    const shellRows = catalog.rows.filter((r) => r.tree === 'shell');
    for (const template of listTemplates()) {
      const derived = evaluateLegacyShellRows(template.config.rows, shellRows, [], SEAT_ROW_IDS);
      expect(derived.warnings, `模板 ${template.id} 有死引用：${derived.warnings.join('; ')}`).toEqual([]);
      expect(derived.rowIds.length).toBeGreaterThan(0);
      // 会话基座不剪：外壳 boot 的账本/会话行恒在（R-5 完整实例组成件）
      expect(derived.rowIds).not.toContain('memory');
    }
  });

  it('模板目录实盘存在（行缺席/目录漂移 fail-loud）', () => {
    expect(fs.existsSync(path.join(TEMPLATE_DIR, 'standard', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(TEMPLATE_DIR, 'creator', 'meta.json'))).toBe(true);
  });

  it('未知/词法非法模板键 = undefined（不抛错、不越目录）', () => {
    expect(readTemplate('nope')).toBeUndefined();
    expect(readTemplate('../standard')).toBeUndefined();
    expect(readTemplate('')).toBeUndefined();
  });

  it('cr-879 模板 skills/ 扫描 + 物化/读取往返', () => {
    const creator = readTemplate('creator');
    expect(creator?.skills?.map((s) => s.dirName)).toEqual(['plugin-dev']);
    expect(creator?.skills?.[0]?.content).toContain('迭代铁律');
    // 无技能模板 = 空表
    expect(readTemplate('standard')?.skills).toBeUndefined();
    // 物化（skip-if-present）+ 全量读取往返（临时数据根）
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-tpl-skills-'));
    try {
      const written = materializeTemplateSkills(root, '__x__', creator?.skills ?? []);
      expect(written.map((s) => s.dirName)).toEqual(['plugin-dev']);
      expect(fs.readFileSync(path.join(root, 'files/__x__/skills/plugin-dev/SKILL.md'), 'utf-8')).toContain('迭代铁律');
      // 已在场不覆盖（用户编辑优先）
      fs.writeFileSync(path.join(root, 'files/__x__/skills/plugin-dev/SKILL.md'), '# 用户版\n', 'utf-8');
      expect(materializeTemplateSkills(root, '__x__', creator?.skills ?? [])).toEqual([]);
      // overwrite = true 无条件覆盖（reconcile follow 专用）
      materializeTemplateSkills(root, '__x__', creator?.skills ?? [], true);
      expect(fs.readFileSync(path.join(root, 'files/__x__/skills/plugin-dev/SKILL.md'), 'utf-8')).toContain('迭代铁律');
      // readAgentSkills：点名读取 + 全量扫描（缺省）
      expect(readAgentSkills(root, '__x__', ['plugin-dev'])['plugin-dev']).toContain('迭代铁律');
      expect(Object.keys(readAgentSkills(root, '__x__'))).toEqual(['plugin-dev']);
      expect(readAgentSkills(root, '__none__')).toEqual({});
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

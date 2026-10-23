// ============================================================
// preset-builtin 模板集单测（cr-540）：静态配置集解析 + 默认模板唯一 +
// 模板词形全部命中行集目录（行引用 ∨ 工具名 ∨ 捆绑词——防模板引用死行）。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listTemplates, readTemplate, TEMPLATE_DIR } from '../src/preset-builtin.ts';
import { readCatalog, deriveShellRowset } from 'ac-rowset-core';

const CATALOG = path.resolve('preview/apps/catalog/row-catalog.json');

describe('内置模板静态配置集（preset-builtin 行数据面）', () => {
  it('四模板全量解析：键/标签/次序/default 与身份配置', () => {
    const templates = listTemplates();
    expect(templates.map((t) => t.id)).toEqual(['standard', 'dsh-minimal', 'creator', 'abap-dev']);
    expect(templates.map((t) => t.label)).toEqual(['标准模式', '极简模式', '创造模式', 'ABAP开发模式']);
    expect(templates.filter((t) => t.default === true).map((t) => t.id)).toEqual(['standard']);
    expect(templates.map((t) => t.config.id)).toEqual(['__standard__', '__dsh_minimal__', '__creator__', '__abap_dev__']);
    for (const template of templates) {
      expect(template.config.preset).toBe(true); // 模板 = 预设名册语义（创建时剥除）
      expect(Array.isArray(template.config.tools)).toBe(true);
    }
  });

  it('模板词形全部命中行集目录：壳行集派生零 warnings（模板↔目录同源）', () => {
    const catalog = readCatalog(CATALOG);
    for (const template of listTemplates()) {
      const derived = deriveShellRowset(template.config, catalog);
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
});

// ============================================================
// @vitest-environment jsdom
// tests/preview-office.test.ts —— Office 预览分派纯函数测试
//（docx/xlsx/xlsm/pptx 进 office 分支；97-2003 老格式与未知二进制
//  维持无选项兜底；binary 网关与显式模式合法性同现有语义）
// ============================================================
import { describe, it, expect } from 'vitest';
import { previewModeOptions, resolveViewKind, PREVIEW_MODE_LABELS } from '../client/filePreviewContent.ts';

describe('previewModeOptions：office 扩展名', () => {
  it('docx/xlsx/xlsm/pptx → [auto, office]', () => {
    expect(previewModeOptions('a.docx')).toEqual(['auto', 'office']);
    expect(previewModeOptions('报表.XLSX')).toEqual(['auto', 'office']); // 大小写不敏感
    expect(previewModeOptions('宏表.xlsm')).toEqual(['auto', 'office']);
    expect(previewModeOptions('演示.pptx')).toEqual(['auto', 'office']);
  });

  it('97-2003 老格式（doc/xls/ppt）不支持——无选项（兜底十六进制/本地打开）', () => {
    expect(previewModeOptions('old.doc')).toEqual([]);
    expect(previewModeOptions('old.xls')).toEqual([]);
    expect(previewModeOptions('old.ppt')).toEqual([]);
  });

  it('非 office 格式不受影响（回归）', () => {
    expect(previewModeOptions('README.md')).toEqual(['auto', 'markdown', 'code', 'text']);
    expect(previewModeOptions('pic.png')).toEqual(['auto', 'image']);
  });
});

describe('resolveViewKind：office 分派', () => {
  it('auto → office', () => {
    expect(resolveViewKind('auto', '报告.docx', true)).toBe('office');
    expect(resolveViewKind('auto', '表.xlsm', true)).toBe('office');
  });

  it('binary 网关：office 文件允许 office 显式模式（二进制即其自然格式）', () => {
    expect(resolveViewKind('office', '报告.docx', true)).toBe('office');
  });

  it('标签词表含 office', () => {
    expect(PREVIEW_MODE_LABELS.office).toBe('Office');
  });
});
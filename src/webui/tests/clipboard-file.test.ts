// ============================================================
// clipboard-file：剪贴板文件补名（粘贴图片/文件 → 上传附件链路）
// ============================================================
import { describe, it, expect } from 'vitest';
import { ensurePasteName } from '../src/utils/clipboard-file';

function file(name: string, type: string, content = 'x'): File {
  return new File([content], name, { type });
}

const T = new Date(2026, 8, 3, 15, 30, 45); // 2026-09-03 15:30:45（月份 0 起）

describe('ensurePasteName', () => {
  it('无扩展名截图（image/png）→ 补 paste-<stamp>.png，内容与类型保留', () => {
    const out = ensurePasteName(file('image', 'image/png', 'PNGDATA'), T);
    expect(out.name).toBe('paste-0903-153045.png');
    expect(out.type).toBe('image/png');
  });

  it('空名文件按 MIME 补名；点开头名（.bashrc）视作"点+字母尾"直通（无法与扩展名可靠区分，缺省安全）', () => {
    expect(ensurePasteName(file('', 'image/jpeg'), T).name).toBe('paste-0903-153045.jpg');
    const dot = file('.bashrc', 'text/plain');
    expect(ensurePasteName(dot, T)).toBe(dot);
  });

  it('已有扩展名（含大小写）→ 原样直通（不上传端重命名）', () => {
    const f = file('截图.PNG', 'image/png');
    expect(ensurePasteName(f, T)).toBe(f);
  });

  it('MIME 不在表内且无扩展名 → 原样直通（上传端自有兜底）', () => {
    const f = file('blob', 'application/octet-stream');
    expect(ensurePasteName(f, T)).toBe(f);
  });
});

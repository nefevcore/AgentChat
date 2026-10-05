// ============================================================
// ac-app/tests/cr-log.test.ts —— CR 目录头部快查块守门（cr-40）
//   · cr-log.md 头部「当前号：cr-N」必须与目录最大序号一致——
//     agent 惯从头部读，头行是登记取号的单一入口（读头即得号，
//     免读尾/grep 二次查询）；新 CR 只追加目录不同步头行即红。
//   · 头部形态（> **当前号：cr-N**（登记新条目前同步本行——…））
//     以正则锁定，防止格式漂移导致快查失效。
// 静态文档契约锁：与 event-catalog.test.ts 同款立场（读源文本是
// 唯一途径）。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const CR_LOG = fileURLToPath(new URL('../../../cr-log.md', import.meta.url));

const text = fs.readFileSync(CR_LOG, 'utf8');
const lines = text.split(/\r?\n/);

// 头部「当前号」块必须住引言区（## 目录 之前）——agent 从头读，
// 块漂到目录区即失去快查意义。
const tocIdx = lines.findIndex((l) => l.startsWith('## 目录'));
const headText = tocIdx === -1 ? '' : lines.slice(0, tocIdx).join('\n');

const headMatch = headText.match(/^> \*\*当前号：cr-(\d+)\*\*/m);
const maxEntry = Math.max(
  ...lines
    .map((l) => l.match(/^- 【cr-(\d+) /))
    .filter(Boolean)
    .map((m) => Number(m![1])),
);

describe('cr-log 头部快查块（cr-40）', () => {
  it('头部有「当前号」行且与目录最大序号一致', () => {
    expect(headMatch, '头部引言区缺 **当前号：cr-N** 快查行').toBeTruthy();
    expect(Number(headMatch![1])).toBe(maxEntry);
  });

  it('目录条目形态：行首「- 【cr-数字 日期 描述】」且无重复序号', () => {
    const entries = lines
      .map((l) => l.match(/^- 【cr-(\d+) (\d{4}-\d{2}-\d{2}) /))
      .filter(Boolean)
      .map((m) => ({ n: Number(m![1]), date: m![2] }));
    expect(entries.length).toBeGreaterThan(0);
    const nums = entries.map((e) => e.n);
    expect(new Set(nums).size).toBe(nums.length);
    // 历史跳号已由 cr-24/cr-38 勘误归位，现行序列应从 cr-1 连续到最大号。
    // 不锁物理顺序：cr-38 系勘误后补登记，排在 cr-39 之后是登记时序的真实记录。
    expect([...nums].sort((a, b) => a - b)).toEqual(
      Array.from({ length: maxEntry }, (_, i) => i + 1),
    );
  });
});

// ============================================================
// styles.test.ts —— UI 入口 L0 样式导入面对账（cr-673）
//
// 症状史：cr-577 只补 tokens.css，badge.css 当时按「零消费」不补——实际有 9 个
// 行包在用 .ui-badge 族（状态/标签/类型徽记三族 + .ui-avatar-badge + tt-* 色相），
// 浏览器里整族没有任何规则。根因不是漏了一行 import，而是入口手工维护「kit css
// 子集」——kit 加层、消费面变化都无人对账，于是同一处漏导复发两次。
// 本用例把口径改成全集等式：kit package.json 导出的每个 css 子路径都必须在入口
// 导入。新增 L0 层（或新 css 子路径）未进入口即红，不再靠人记得。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(here, '..');
const repoRoot = join(uiRoot, '..', '..', '..');

const kitPkg = JSON.parse(readFileSync(join(repoRoot, 'src/webui-kit/package.json'), 'utf-8')) as { exports: Record<string, string> };
const cssSubpaths = Object.keys(kitPkg.exports).filter((k) => k.endsWith('.css'));
const entry = readFileSync(join(uiRoot, 'client/main.ts'), 'utf-8');
const imported = new Set([...entry.matchAll(/import\s+['"](@agentchat\/webui-kit\/[^'"]+\.css)['"]/g)].map((m) => m[1]));

describe('cr-673 · UI 入口 L0 样式导入面', () => {
  it('kit 导出的每个 css 子路径都在入口导入（新增层不许静默缺席）', () => {
    expect(cssSubpaths.length).toBe(4);
    for (const sub of cssSubpaths) {
      const spec = '@agentchat/webui-kit/' + sub.replace(/^\.\//, '');
      expect(imported.has(spec), '入口未导入 kit L0 层：' + spec).toBe(true);
    }
  });
});

// ============================================================
// webui-base.test.ts —— webui 基座源文档漂移锁定（cr-905 / cr-901
// v2.1 批3 切片一：通道目录增删/改 manifest 未重跑 gen-webui-base = 红）
// ============================================================
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const OUT = path.join(REPO, 'apps/catalog/profile/webui.patch.yml');

describe('webui 基座源文档（生成物漂移锁定）', () => {
  it('通道目录与基座文档同步（重生成零差异）', () => {
    const before = fs.readFileSync(OUT, 'utf-8');
    const out = execFileSync('node', [path.join(REPO, 'scripts/gen-webui-base.mjs')], { encoding: 'utf-8' });
    expect(out).toContain('已同步');
    expect(fs.readFileSync(OUT, 'utf-8')).toBe(before);
  });

  it('版本戳在位 + 条目 id 与 web 面包一致 + name = link: 词形', () => {
    const text = fs.readFileSync(OUT, 'utf-8');
    expect(text).toMatch(/^# ac-base-version: \d+$/m);
    const dirs = fs.readdirSync(path.join(REPO, 'packages'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('ac-client-ui-'))
      .filter((e) => JSON.parse(fs.readFileSync(path.join(REPO, 'packages', e.name, 'package.json'), 'utf-8')).ac?.faces?.web !== undefined)
      .map((e) => e.name.slice('ac-client-ui-'.length)).sort();
    const ids = [...text.matchAll(/^- id: (.+)$/gm)].map((m) => m[1]);
    expect(ids).toEqual(dirs);
    for (const line of text.split('\n')) {
      if (line.startsWith('  name: ')) expect(line).toContain('link:packages/ac-client-ui-');
    }
  });
});

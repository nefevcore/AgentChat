// ============================================================
// ac-app/tests/row-manifest.test.ts —— 裸行名可解析性守门（cr-302）
//
//   loader 以 baseUrl = src/ 为 parentURL 解析 yml 行名（supervised 启动
//   时 worker cwd = src），src/ 下没有 node_modules，唯一命中点是仓库根
//   node_modules —— 那里只放根 package.json devDependencies 声明过的包
//   （生态惯例见 ecosystem.ts 头部注释）。于是「cordis.yml 加了行、忘了
//   声明进根 package.json」= 启动期 ERR_MODULE_NOT_FOUND → exit 78：
//   cr-288（ac-harness-tools）与 cr-302（ac-client-ui-onboarding）同形。
//   两次都是 TREE/行集测试绿、真启动红——缺口在「行名可解析」这一步，
//   故本文件静态零 boot（unit 档）单锁这一步。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const rows = yaml.load(
  fs.readFileSync(new URL('../../cordis.yml', import.meta.url), 'utf8'),
) as Array<{ id?: string; name?: string; disabled?: boolean }>;
const rootDevDeps = Object.keys(
  JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).devDependencies ?? {},
);

// 只查激活行：disabled 行不装载，不必可解析；相对路径行自带解析（'./x.ts'）。
const bareRows = rows.filter(
  (row) => !row.disabled && typeof row.name === 'string' && !row.name.startsWith('./'),
);
// 链接落点按文件系统查，不用 createRequire：vitest 里 createRequire 走 Vite
// 解析器（它会命中 src/* 工作区包），对照实测——真 Node 从 src/ 锚点解析
// 同包名是 ERR_MODULE_NOT_FOUND，测试内却真绿。假绿比没守门更坏。
const linkOf = (name: string) => path.join(REPO_ROOT, 'node_modules', ...name.split('/'));

describe('cordis.yml 裸行名可解析性（cr-302）', () => {
  it('每个激活行的裸行名都声明进根 package.json devDependencies', () => {
    const missing = bareRows
      .filter((row) => !rootDevDeps.includes(row.name!))
      .map((row) => `${row.id} (${row.name})`);
    expect(
      missing,
      '行名未声明进根 devDependencies → loader 从 src/ 解析不到（启动期 exit 78）。' +
        '修法：根 package.json devDependencies 加 "<包名>": "workspace:*"，再 pnpm install',
    ).toEqual([]);
  });

  it('每个裸行名在根 node_modules 都有链接（声明了但未 install 同样红）', () => {
    const unlinked = bareRows
      .filter((row) => !fs.existsSync(linkOf(row.name!)))
      .map((row) => `${row.id} (${row.name})`);
    expect(
      unlinked,
      '根 node_modules 里没有该链接 → 启动期 ERR_MODULE_NOT_FOUND。修法：补根 devDependencies 声明后 pnpm install',
    ).toEqual([]);
  });
});

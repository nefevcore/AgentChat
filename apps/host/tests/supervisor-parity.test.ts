// ============================================================
// supervisor-parity.test.ts —— 双 supervisor 布局一致性锁（cr-706）
//
// 仓库根 supervisor.mjs（产品入口）与 apps/host/supervisor.mjs（测试
// 沙箱入口）是刻意保留的双份外壳（差异：数据根缺省/env 读取/品牌 exe/
// stdio tee——见两文件头注明）。监护策略本体同源 ac-supervisor-core
// 纯函数——本锁保证「策略改一处即双入口生效」：两份文件 import 的
// ac-supervisor-core 导入名集合必须恒等（漏改任何一份在此红，而不是
// 在生产监护行为上静默分叉）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** 从 .mjs 源码文本提取 ac-supervisor-core 的导入名集合（静态扫） */
function coreImports(file: string): Set<string> {
  const src = readFileSync(file, 'utf8');
  const brace = /import\s*\{([^}]*)\}\s*from\s*'ac-supervisor-core'/.exec(src);
  if (brace === null) throw new Error(file + ' 缺 ac-supervisor-core 导入');
  const out = new Set<string>();
  for (const name of brace[1]!.split(',')) {
    const n = name.trim().replace(/^type\s+/, '').trim();
    if (n !== '') out.add(n);
  }
  return out;
}

describe('双 supervisor 布局（cr-706）', () => {
  it('两份 supervisor 的 ac-supervisor-core 导入策略一致', () => {
    const product = coreImports(join(repoRoot, 'supervisor.mjs'));
    const sandbox = coreImports(join(repoRoot, 'apps', 'host', 'supervisor.mjs'));
    expect([...sandbox].sort()).toEqual([...product].sort());
  });

  it('两份的退出码协议常量同名引用（EXIT_RESTART 在场）', () => {
    for (const f of ['supervisor.mjs', 'apps/host/supervisor.mjs']) {
      const src = readFileSync(join(repoRoot, f), 'utf8');
      expect(src.includes('EXIT_RESTART'), f).toBe(true);
      expect(src.includes('decideOnExit'), f).toBe(true);
    }
  });
});

// ============================================================
// ac-plugin-registry/tests/helpers.ts —— 测试共用助手
//
// makePluginDir：建最小插件目录（manifest + 空入口）——
// plugin-registry.test 与 install-flow.test 原各持一份同构拷贝，并源。
// （boot 助手各文件行集不同，不合并。）
// ============================================================
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function makePluginDir(
  base: string,
  name: string,
  version = '1.0.0',
  extra: Record<string, unknown> = {},
): Promise<string> {
  const dir = join(base, `${name}-src`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name, version, entry: 'index.ts', ...extra }));
  await writeFile(join(dir, 'index.ts'), 'export function apply() {}\n');
  return dir;
}

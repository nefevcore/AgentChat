// @vitest-environment jsdom
// ============================================================
// host-module-table.test.ts —— 宿主模块表对账锁（cr-905 批3 切片二）
// 构建面单源表 ≡ 装载面运行时键集（skeletonModuleHost ∪ sharedModules）
// ============================================================
import { describe, it, expect } from 'vitest';
import { HOST_MODULE_SPECS } from '../scripts/host-module-table.ts';
import { skeletonModuleHost } from '../client/boot.ts';
import { sharedModules } from '../client/shared-modules.ts';

describe('宿主模块表（构建面 ≡ 装载面）', () => {
  it('HOST_MODULE_SPECS = skeleton ∪ shared 键集（冻结清单）', () => {
    const runtime = new Set([...Object.keys(skeletonModuleHost()), ...Object.keys(sharedModules())]);
    expect([...new Set(HOST_MODULE_SPECS)].sort()).toEqual([...runtime].sort());
  });

  it('子路径前缀匹配面：同包说明符外部化由前缀规则承担（表内含裸包键）', () => {
    for (const spec of HOST_MODULE_SPECS) {
      if (!spec.includes('/')) continue;
      // 深路径键的裸包前缀（如 ac-client-ui-agents/client/index.ts → ac-client-ui-agents/client）
      const bare = spec.replace(/\.(ts|vue)$/, '');
      expect(spec.startsWith(bare)).toBe(true);
    }
  });
});

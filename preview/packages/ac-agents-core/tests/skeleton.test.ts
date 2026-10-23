// ac-agents-core 骨架冒烟：包可达 + exports 解析（M0.2）
import { describe, it, expect } from 'vitest';
import * as pkg from '../src/index.ts';

describe('ac-agents-core 骨架', () => {
  it('包入口可导入且自述包名', () => {
    expect(pkg.name).toBe('ac-agents-core');
  });
});

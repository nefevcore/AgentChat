// ============================================================
// M6.5 影子 spawn 面单测：物化即快照 / 剥减 / 重物化 fail-loud /
// deriveChildAuth ⊆ 父投影。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { materializeChild, deriveChildConfig, readChildConfig, listChildIds } from '../src/tree.ts';
import type { AgentConfig } from '../src/config.ts';

const ROOT = path.join('sandbox', 'test-shadow-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const parent: AgentConfig = {
  id: 'w', model: 'mock', preset: true,
  rows: ['fs-tools'],
  name: '现任',
};

describe('M6.5 影子物化（R-5）', () => {
  it('物化即快照：child config 落盘 + preset 剥除 + id 换新', () => {
    const dir = materializeChild(ROOT, 'w', 'w-shadow-1', parent);
    expect(dir).toBe(path.join(ROOT, 'agents', 'w', 'children', 'w-shadow-1'));
    const child = readChildConfig(ROOT, 'w', 'w-shadow-1');
    // 会话基座并入已单源化到行集派生层（cr-548）——物化快照保持父词形
    expect(child).toMatchObject({ id: 'w-shadow-1', model: 'mock', rows: ['fs-tools'] });
    expect(child?.preset).toBeUndefined(); // 名册语义不继承
    expect(listChildIds(ROOT, 'w')).toEqual(['w-shadow-1']);
  });

  it('快照非镜像：物化后父改配置不传播', () => {
    materializeChild(ROOT, 'w', 's1', parent);
    const parent2 = { ...parent, model: 'NEW-MODEL' };
    fs.mkdirSync(path.join(ROOT, 'agents', 'w'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'agents', 'w', 'config.json'), JSON.stringify(parent2), 'utf-8');
    expect(readChildConfig(ROOT, 'w', 's1')?.model).toBe('mock');
  });

  it('重物化 fail-loud（不静默覆盖）', () => {
    materializeChild(ROOT, 'w', 's1', parent);
    expect(() => materializeChild(ROOT, 'w', 's1', parent)).toThrow(/已物化/);
  });

  it('deriveChildConfig 纯函数剥减', () => {
    const c = deriveChildConfig(parent, 'x1');
    expect(c.id).toBe('x1');
    expect(c.preset).toBeUndefined();
    expect(c.name).toBe('现任'); // 其余身份原样
  });
});

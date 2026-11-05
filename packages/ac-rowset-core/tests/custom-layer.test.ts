// ============================================================
// custom-layer.test.ts —— host/shell-custom 偏好层单测（cr-909 批6 切片三）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readCustomLayer } from '../src/custom-layer.ts';

const ROOT = path.join('sandbox', 'test-custom-layer-' + process.pid);
const PROFILE = path.join(ROOT, 'profile');
beforeEach(() => fs.mkdirSync(PROFILE, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('readCustomLayer（cr-909）', () => {
  it('缺席 = 空层零警告（常态）；disable 面解析；坏文件 = 空层 + 警告不炸', () => {
    expect(readCustomLayer(PROFILE, 'host')).toEqual({ disabled: new Set(), warnings: [] });
    fs.writeFileSync(path.join(PROFILE, 'shell-custom.patch.yml'),
      '- id: sap-adt' + String.fromCharCode(10) + '  disabled: true' + String.fromCharCode(10));
    const layer = readCustomLayer(PROFILE, 'shell');
    expect([...layer.disabled]).toEqual(['sap-adt']);
    expect(layer.warnings).toEqual([]);
    fs.writeFileSync(path.join(PROFILE, 'webui-custom.patch.yml'), '{nope');
    const bad = readCustomLayer(PROFILE, 'webui');
    expect(bad.disabled.size).toBe(0);
    expect(bad.warnings.join()).toContain('不可读');
  });
});


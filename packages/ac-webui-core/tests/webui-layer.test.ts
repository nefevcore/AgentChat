// ============================================================
// webui-layer.test.ts —— webui 装配文档分层合成单测（cr-905 批3 切片三）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { synthesizeWebuiGraph } from '../src/webui-layer.ts';

const ROOT = path.join('sandbox', 'test-webui-layer-' + process.pid);
const PLUGINS = path.join(ROOT, 'plugins');
const PROFILE = path.join(ROOT, 'profile');
beforeEach(() => {
  fs.mkdirSync(path.join(PLUGINS, 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(PLUGINS, 'beta'), { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  for (const n of ['alpha', 'beta']) {
    fs.writeFileSync(path.join(PLUGINS, n, 'manifest.json'), JSON.stringify({
      name: n, version: '1.0.0', entry: 'ui/index.js', platform: 'web',
      seats: [], isolated: false,
    }));
  }
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function writeDoc(file: string, entries: unknown[]): void {
  fs.writeFileSync(path.join(PROFILE, file), yaml.dump(entries), 'utf-8');
}

describe('synthesizeWebuiGraph 分层合成', () => {
  it('基座缺席 = 纯目录扫描透传（行为等价）', () => {
    const r = synthesizeWebuiGraph(PLUGINS, PROFILE);
    expect(r.graph.map((e) => e.name).sort()).toEqual(['alpha', 'beta']);
    expect(r.warnings).toEqual([]);
  });

  it('基座点名子集：点名项下发；未点名在场项兼容窗口仍下发 + 警告；点名缺席项警告跳过', () => {
    writeDoc('webui.patch.yml', [{ id: 'alpha' }, { id: 'ghost' }]);
    const r = synthesizeWebuiGraph(PLUGINS, PROFILE);
    expect(r.graph.map((e) => e.name).sort()).toEqual(['alpha', 'beta']);
    expect(r.warnings.join('；')).toContain('beta'); // 未点名在场（v1 存量兼容）
    expect(r.warnings.join('；')).toContain('ghost'); // 点名缺席（跳过 + 上报）
  });

  it('custom disable 减法；installed 反向适配（face:web）并集', () => {
    writeDoc('webui.yml', [{ id: 'alpha' }]);
    writeDoc('webui.patch.yml', [{ id: 'alpha', disabled: true }]);
    // beta 物化 + faces.web 声明（cr-1004：scope 退役——基座分析包 face）
    const betaDir = path.join(ROOT, 'profile', 'node_modules', 'beta');
    fs.mkdirSync(betaDir, { recursive: true });
    fs.writeFileSync(path.join(betaDir, 'package.json'), JSON.stringify({
      name: 'beta', ac: { faces: { web: { entry: './ui.js' } } },
    }));
    writeDoc('installed.yml', [{ id: 'beta', name: 'beta', owner: 'u' }]);
    const r = synthesizeWebuiGraph(PLUGINS, PROFILE);
    expect(r.graph.map((e) => e.name)).toEqual(['beta']); // alpha 被 custom 停用；beta 经 face 适配点名
    expect(r.warnings.join('；')).not.toContain('beta'); // beta 已点名非兼容窗口
  });

  it('坏基座文档（顶层非数组）→ throw（fail-loud：安装器代写文档损坏）', () => {
    fs.writeFileSync(path.join(PROFILE, 'webui.patch.yml'), 'version: 2' + String.fromCharCode(10));
    expect(() => synthesizeWebuiGraph(PLUGINS, PROFILE)).toThrow('顶层必须是条目数组');
  });
});

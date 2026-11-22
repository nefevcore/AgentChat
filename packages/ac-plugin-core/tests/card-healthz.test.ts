// ============================================================
// card-healthz.test.ts —— 审批卡 + healthz + 豁免单测
//（cr-903 / cr-901 v2.1 批2 切片三）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildApprovalCard, contentDiffOf } from '../src/card.ts';
import { pluginHealthz } from '../src/healthz.ts';
import { installPackage, admissionOf, type ExemptionRule } from '../src/installer.ts';
import { writeInstalledDoc } from '../src/installed.ts';
import { resetQueuesForTest } from '../src/fsx.ts';

const ROOT = path.join('sandbox', 'test-card-' + process.pid);
const SRC = path.join(ROOT, 'src-plugin');
beforeEach(() => {
  resetQueuesForTest();
  fs.mkdirSync(SRC, { recursive: true });
});
afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  resetQueuesForTest();
});

function writePlugin(version = '1.0.0', acExtra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(SRC, 'package.json'), JSON.stringify({
    name: 'dev-plugin-demo',
    version,
    engines: { node: '>=20', agentchat: '^2' },
    ac: { permissions: ['fs', 'shell'], provides: { tools: ['demo-tool'] }, ...acExtra },
  }, null, 2));
  fs.writeFileSync(path.join(SRC, 'index.ts'), 'export const apply = () => {};' + String.fromCharCode(10));
}

describe('审批卡', () => {
  it('载荷完整：engines/权限面/provides/内容指纹/门禁明细', () => {
    writePlugin();
    const card = buildApprovalCard(SRC, { grants: ['fs', 'shell'] });
    expect(card.name).toBe('dev-plugin-demo');
    expect(card.engines.ok).toBe(true);
    expect(card.permissions.declared).toEqual(['fs', 'shell']);
    expect(card.permissions.explicitRequired).toEqual(['shell']);
    expect(card.provides).toEqual({ tools: ['demo-tool'] });
    expect(card.fingerprint.kind).toBe('content-hash');
    expect(card.fingerprint.hash).toHaveLength(64);
    expect(card.admission.ok).toBe(true);
  });

  it('门禁失败在卡面明示（未授予 shell）', () => {
    writePlugin();
    const card = buildApprovalCard(SRC, { grants: ['fs'] });
    expect(card.admission.ok).toBe(false);
    expect(card.admission.reasons.join()).toContain('未授予的权限');
  });

  it('升级 diff：旧版在场 → 文件级变更清单', async () => {
    writePlugin('1.0.0');
    await installPackage({ root: ROOT, sourceDir: SRC, owner: 'a', grants: ['fs', 'shell'] });
    writePlugin('1.1.0');
    fs.writeFileSync(path.join(SRC, 'extra.ts'), 'export const x = 1;');
    const card = buildApprovalCard(SRC, { grants: ['fs', 'shell'] });
    expect(card.upgrade?.oldVersion).toBe('1.0.0');
    expect(card.upgrade?.diff.added).toContain('extra.ts');
    expect(card.upgrade?.diff.changed).toContain('package.json');
  });

  it('豁免规则命中放行 + 留痕（engines 面例外）', () => {
    writePlugin();
    fs.writeFileSync(path.join(SRC, 'package.json'), JSON.stringify({
      name: 'dev-plugin-old', version: '0.1.0', engines: { agentchat: '^1' },
      ac: { permissions: ['fs'] },
    }));
    const rules: ExemptionRule[] = [
      { id: 'legacy-abi', plugin: 'dev-plugin-old', gate: 'engines', note: '迁移期例外（cr-903）' },
    ];
    const v = admissionOf(SRC, undefined, rules);
    expect(v.ok).toBe(true);
    expect(v.exemptionHits).toHaveLength(1);
    expect(v.exemptionHits[0]).toContain('legacy-abi');
    const noExempt = admissionOf(SRC);
    expect(noExempt.ok).toBe(false);
    // 卡面留痕
    const card = buildApprovalCard(SRC, { exemptions: rules });
    expect(card.exemptionHits).toHaveLength(1);
  });
});

describe('contentDiffOf', () => {
  it('新增/变更/移除三清单', () => {
    const a = path.join(ROOT, 'a');
    const b = path.join(ROOT, 'b');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(a, 'same.txt'), 'x');
    fs.writeFileSync(path.join(a, 'gone.txt'), 'x');
    fs.writeFileSync(path.join(b, 'same.txt'), 'x');
    fs.writeFileSync(path.join(b, 'gone2.txt'), 'y');
    const d = contentDiffOf(a, b);
    expect(d).toEqual({ added: ['gone2.txt'], changed: [], removed: ['gone.txt'] });
  });
});

describe('pluginHealthz', () => {
  it('健康态零 issue；物化缺席 → needs-reinstall；登记断裂 → issue', async () => {
    writePlugin();
    await installPackage({ root: ROOT, sourceDir: SRC, owner: 'a', grants: ['fs', 'shell'] });
    let h = pluginHealthz(ROOT);
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0].issues).toEqual([]);
    // 物化缺席
    fs.rmSync(path.join(ROOT, 'plugins', 'dev-plugin-demo'), { recursive: true, force: true });
    h = pluginHealthz(ROOT);
    expect(h.entries[0].needsReinstall).toBe(true);
    expect(h.entries[0].issues.join()).toContain('物化目录缺席');
    // 登记断裂：手工撤 installed.yml 条目
    writeInstalledDoc(ROOT, []);
    h = pluginHealthz(ROOT);
    expect(h.entries[0].documented).toBe(false);
    expect(h.entries[0].issues.join()).toContain('installed.yml 未登记');
  });
});

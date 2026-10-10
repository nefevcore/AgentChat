// ============================================================
// ac-core-utils：persona 解析词法（cr-321 自 ac-persona 下沉随迁——
// 词法级行为锁定；插件面/装配链路测试仍住 ac-persona/tests）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { resolvePersonaText } from '../src/persona.ts';

/** agentStore 文档读口假件（键 = `${agentId}/${name}`） */
const storeWith = (docs: Record<string, string>): { readDoc: (a: string, n: string) => string | undefined } =>
  ({ readDoc: (agentId, name) => docs[`${agentId}/${name}`] });

describe('resolvePersonaText（形状与回退序）', () => {
  it('旧 string 形状：trim 后非空生效；空白 = 无人设', () => {
    expect(resolvePersonaText(undefined, undefined, '  海盗  ')).toBe('海盗');
    expect(resolvePersonaText(undefined, undefined, '   ')).toBeUndefined();
  });

  it('非字符串非对象（number/null/undefined/boolean）→ 无人设', () => {
    for (const cfg of [1, null, undefined, true]) {
      expect(resolvePersonaText(undefined, undefined, cfg)).toBeUndefined();
    }
  });

  it('enabled=false 软停用（text 存在也不注入）', () => {
    expect(resolvePersonaText(undefined, undefined, { enabled: false, text: 'x' })).toBeUndefined();
  });

  it('text trim 后生效；text/file 均缺 → 无人设', () => {
    expect(resolvePersonaText(undefined, undefined, { text: ' 猫娘 ' })).toBe('猫娘');
    expect(resolvePersonaText(undefined, undefined, {})).toBeUndefined();
  });
});

describe('resolvePersonaText（file 优先：store 文档 → 文件系统 → text 回退）', () => {
  let tmp = '';

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = '';
    }
  });

  it('裸名双名同义：store 内 AGENTS.md 优先于 AGENT.md（配置写哪个名读序一致）', () => {
    const store = storeWith({ 'a1/AGENTS.md': '# 新\n', 'a1/AGENT.md': '# 旧\n' });
    expect(resolvePersonaText(store, 'a1', { file: 'AGENT.md' })).toBe('# 新');
    expect(resolvePersonaText(store, 'a1', { file: 'AGENTS.md' })).toBe('# 新');
  });

  it('store 仅存量旧名 → AGENT.md 回退命中', () => {
    const store = storeWith({ 'a2/AGENT.md': '存量\n' });
    expect(resolvePersonaText(store, 'a2', { file: 'AGENTS.md' })).toBe('存量');
  });

  it('store 命中但 strip frontmatter 后为空 → 视同未命中回退 text', () => {
    const store = storeWith({ 'a6/PROFILE.md': '---\nonly frontmatter\n---\n' });
    expect(resolvePersonaText(store, 'a6', { file: 'PROFILE.md', text: '内联' })).toBe('内联');
  });

  it('agentId 缺省（直连 loop 形态）→ store 不被咨询', () => {
    const mustNotCall = { readDoc: (): never => { throw new Error('store 不应被咨询'); } };
    expect(resolvePersonaText(mustNotCall, undefined, { file: 'missing-persona-doc.md' })).toBeUndefined();
  });

  it('带分隔符路径 → 文件系统读取 + frontmatter 剥离（不走 store）', () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-core-utils-persona-'));
    writeFileSync(join(tmp, 'persona.md'), '---\ntitle: x\n---\n\n文件人设\n', 'utf-8');
    // 相对 cwd 的路径形态（带分隔符）——store 传入也不应被咨询
    const rel = relative(process.cwd(), join(tmp, 'persona.md'));
    const mustNotCall = { readDoc: (): never => { throw new Error('store 不应被咨询'); } };
    expect(resolvePersonaText(mustNotCall, 'a3', { file: rel, text: '内联' })).toBe('文件人设');
  });
});

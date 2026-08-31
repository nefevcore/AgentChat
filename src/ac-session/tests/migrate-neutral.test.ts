// ============================================================
// 迁移恒等门（M21 步骤 7 / D13）：旧 baked 行迁移为中性格式后，同一桶
// 迁移前后的 history(conv,{viewer}) 投影输出逐字节同构；头行 v1、单调
// seq 回填、幂等（已 v1 文件不动）。纯函数对拍（migrateSessionText ×
// projectRecord），另含新会话头行/未知版本 fail-loud/重写保头行。
// ============================================================
import { describe, it, expect } from 'vitest';
import { migrateSessionText } from '../../scripts/migrate-session-neutral.ts';
import { projectRecord, type SessionRecord } from '../src/index.ts';

const LEGACY = [
  JSON.stringify({ role: 'user', content: '你好', name: 'user', message_id: 'm1', timestamp: 't1' }),
  JSON.stringify({ role: 'assistant', content: '在的', name: 'helper', message_id: 'm2', timestamp: 't2', reasoning_content: '想想' }),
  JSON.stringify({ role: 'user', content: '再来', name: 'user', message_id: 'm3', timestamp: 't3' }),
  JSON.stringify({ role: 'assistant', content: '好的', name: 'helper', message_id: 'm4', timestamp: 't4' }),
  JSON.stringify({ role: 'event', content: '定时触发', name: 'helper', message_id: 'm5', timestamp: 't5', source: 'event' }),
].join('\n') + '\n';

/** 委托形态（a⇄b 桶：b 发起记 user name=b——旧存储视角颠倒的病灶行） */
const LEGACY_DELEGATE = [
  JSON.stringify({ role: 'user', content: 'b 的发起', name: 'b', message_id: 'd1', timestamp: 't1' }),
  JSON.stringify({ role: 'assistant', content: 'a 的回复', name: 'a', message_id: 'd2', timestamp: 't2' }),
].join('\n') + '\n';

function parseRows(text: string): SessionRecord[] {
  return text
    .trim()
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('{"type":"session-header"'))
    .map((l) => JSON.parse(l) as SessionRecord);
}

describe('迁移恒等门（D13）', () => {
  it('1v1 桶：迁移前匿名回放（旧 history 语义）≡ 迁移后 viewer 投影（逐字节）', () => {
    const legacyRows = parseRows(LEGACY);
    const migrated = migrateSessionText(LEGACY, 'helper~user');
    expect(migrated.already).toBe(false);
    const neutralRows = parseRows(migrated.text);
    expect(neutralRows).toHaveLength(legacyRows.length);
    // 恒等门（§8.4）：user⇄x 桶下旧匿名回放（存储视角 = 读者 Agent 视角）
    // 与迁移后 viewer='helper' 投影逐字节同构
    const before = legacyRows.map((r) => JSON.stringify(projectRecord(r, undefined, 'helper~user')));
    const after = neutralRows.map((r) => JSON.stringify(projectRecord(r, 'helper', 'helper~user')));
    expect(after).toEqual(before);
  });

  it('多视角对称：迁移前后对任意 viewer 的相对角色一致（own=assistant / peer=user）', () => {
    const legacyRows = parseRows(LEGACY);
    const migrated = migrateSessionText(LEGACY, 'helper~user');
    const neutralRows = parseRows(migrated.text);
    for (const viewer of ['helper', 'other', 'user']) {
      const beforeRoles = legacyRows.map((r) => projectRecord(r, viewer, 'helper~user').role);
      const afterRoles = neutralRows.map((r) => projectRecord(r, viewer, 'helper~user').role);
      expect(afterRoles).toEqual(beforeRoles);
    }
    // 委托形态（D1 病灶行）：迁移后 b 读自己的发起 = assistant（旧存储
    // 视角颠倒由 viewer 投影修复——迁移保真 + 投影纠错的分工）
    const delegateRows = parseRows(migrateSessionText(LEGACY_DELEGATE, 'a~b').text);
    expect(projectRecord(delegateRows[0], 'b', 'a~b')).toEqual({
      role: 'assistant',
      content: 'b 的发起',
      name: 'b',
    });
    expect(projectRecord(delegateRows[1], 'b', 'a~b')).toEqual({
      role: 'user',
      content: 'a 的回复',
      name: 'a',
    });
  });

  it('中性化 + 头行 v1 + 单调 seq 回填；name 字段退役', () => {
    const migrated = migrateSessionText(LEGACY, 'helper~user');
    const lines = migrated.text.trim().split('\n');
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'session-header', version: 1 });
    const rows = lines.slice(1).map((l) => JSON.parse(l));
    expect(rows.map((r) => r.role)).toEqual(['agent', 'agent', 'agent', 'agent', 'event']);
    expect(rows.map((r) => r.agent_id)).toEqual(['user', 'helper', 'user', 'helper', 'helper']);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.every((r) => r.name === undefined)).toBe(true); // 词表统一
    expect(rows[1].reasoning_content).toBe('想想'); // 载荷保留
  });

  it('幂等：已 v1（含头行）文件 already=true 原文不动', () => {
    const once = migrateSessionText(LEGACY, 'helper~user');
    const twice = migrateSessionText(once.text, 'helper~user');
    expect(twice.already).toBe(true);
    expect(twice.converted).toBe(0);
    expect(twice.text).toBe(once.text);
  });
});

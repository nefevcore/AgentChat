// ============================================================
// src/services/group-service 单元测试 —— 群组门面 + 持久化（L4）
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GroupManager } from '@agentchat/router';
import type { GroupMessage } from '@agentchat/router';
import { AgentRegistry } from '@agentchat/agents';
import { GroupService } from '../src/group-service';

let tmp: string;
let registry: AgentRegistry;
let gm: GroupManager;

/** 测试辅助：写群聊本体（模拟 saveSession：sessions/group~<gid>/messages.jsonl，回话无思考/工具） */
function writeGroupMessages(gid: string, msgs: any[]): string {
  const dir = path.join(tmp, 'sessions', `group~${gid}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'messages.jsonl');
  fs.appendFileSync(file, msgs.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
  return file;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grp-'));
  registry = new AgentRegistry();
  registry.register({ agent_id: 'a', name: 'A' } as any);
  registry.register({ agent_id: 'b', name: 'B' } as any);
  registry.register({ agent_id: 'user', name: '用户', virtual: true } as any);
  gm = new GroupManager(registry);
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('GroupService 持久化', () => {
  it('createGroup → 写 group.json；群消息 → 群聊本体 messages.jsonl；历史读取', async () => {
    const svc = new GroupService(gm, tmp);
    svc.createGroup({ group_id: 'g1', name: '群1', participants: ['a', 'b'] });

    const cfgPath = path.join(tmp, 'groups', 'g1', 'group.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).group_id).toBe('g1');

    // 群聊消息由 GroupService 监听 group.message.received 统一落盘
    // （send_group 投递 + 用户 WebUI 群消息的唯一入口），只记真实投递消息
    await gm.deliverGroupMessage({
      from: 'a', to: '*', type: 'chat.send', payload: 'hello', group_id: 'g1',
    } as any);
    await gm.deliverGroupMessage({
      from: 'user', to: '*', type: 'group.message', payload: '大家好', group_id: 'g1',
      data: { content: '大家好' },
    } as any);

    const msgFile = path.join(tmp, 'sessions', 'group~g1', 'messages.jsonl');
    expect(fs.existsSync(msgFile)).toBe(true);

    const history = svc.getGroupHistory('g1');
    expect(history.length).toBe(2);
    expect(history[0].agent_id).toBe('a');
    expect(history[0].content).toBe('hello');
    expect(history[0].role).toBe('agent');
    expect(history[1].agent_id).toBe('user');
    expect(history[1].content).toBe('大家好');
  });

  it('group.message.received 落盘：空 payload 跳过；写 message_id/timestamp', async () => {
    const svc = new GroupService(gm, tmp);
    svc.createGroup({ group_id: 'g1', name: '群1', participants: ['a', 'b'] });

    // 空 payload（无内容）不落盘
    await gm.deliverGroupMessage({
      from: 'a', to: '*', type: 'chat.send', payload: '', group_id: 'g1',
    } as any);
    expect(svc.getGroupHistory('g1').length).toBe(0);

    await gm.deliverGroupMessage({
      from: 'a', to: '*', type: 'chat.send', payload: '带 ID', group_id: 'g1',
      correlation_id: 'corr-1',
    } as any);
    const [m] = svc.getGroupHistory('g1');
    expect(m.message_id).toBe('corr-1');
    expect(m.timestamp).toBeTruthy();
  });

  // Phase 1 ID 贯通（docs/group-single-channel-design.md I1）：
  // deliverGroupMessage 入口统一铸造 correlation_id —— 未显式携带时生成，
  // 且落盘行 message_id、group.trigger 载荷、返回值三方同源。
  it('入口铸造 correlation_id：落盘/trigger/返回值三方同源（I1）', async () => {
    const svc = new GroupService(gm, tmp);
    svc.createGroup({ group_id: 'g1', name: '群1', participants: ['a', 'b'] });

    const triggers: any[] = [];
    gm.on('group.trigger', (d: any) => triggers.push(d));

    const result = await gm.deliverGroupMessage({
      from: 'a', to: '*', type: 'chat.send', payload: '无显式 id', group_id: 'g1',
    } as any);

    expect(result.message_id).toMatch(/^msg-\d+-\w+$/);
    // 落盘行 message_id 与铸造 id 同源
    const [m] = svc.getGroupHistory('g1');
    expect(m.message_id).toBe(result.message_id);
    // trigger 载荷携带同一 id（router 据此注入 RunStartMeta.sourceMeta.message_id）
    expect(triggers).toHaveLength(1);
    expect(triggers[0].correlation_id).toBe(result.message_id);
  });

  it('listGroupsWithActivity 读取群聊本体最后一条消息时间戳', async () => {
    const svc = new GroupService(gm, tmp);
    svc.createGroup({ group_id: 'g1', name: '群1', participants: ['a', 'b'] });
    svc.createGroup({ group_id: 'g2', name: '群2', participants: ['a'] });
    writeGroupMessages('g1', [{ role: 'agent', agent_id: 'a', content: 'x', timestamp: '2026-08-07T00:00:00.000Z' }]);

    const byId = Object.fromEntries(svc.listGroupsWithActivity().map((g) => [g.group_id, g]));
    expect(byId.g1.lastActivity).toBe(new Date('2026-08-07T00:00:00.000Z').getTime()); // 有消息
    expect(byId.g2.lastActivity).toBe(0);            // 无消息
  });

  it('updateGroup（重命名/描述）持久化 group.json', () => {
    const svc = new GroupService(gm, tmp);
    svc.createGroup({ group_id: 'g1', name: '群1', participants: ['a'] });
    svc.updateGroup('g1', { name: '群1改', description: 'desc' });

    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'groups', 'g1', 'group.json'), 'utf-8'));
    expect(cfg.name).toBe('群1改');
    expect(cfg.description).toBe('desc');
  });

  it('joinGroup / leaveGroup 持久化参与者', () => {
    const svc = new GroupService(gm, tmp);
    svc.createGroup({ group_id: 'g1', name: '群1', participants: ['a'] });
    svc.joinGroup('g1', 'b');
    let cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'groups', 'g1', 'group.json'), 'utf-8'));
    expect(cfg.participants).toEqual(['a', 'b']);

    svc.leaveGroup('g1', 'a');
    cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'groups', 'g1', 'group.json'), 'utf-8'));
    expect(cfg.participants).toEqual(['b']);
  });

  it('deleteGroup 清理磁盘目录', () => {
    const svc = new GroupService(gm, tmp);
    svc.createGroup({ group_id: 'g1', name: '群1', participants: ['a'] });
    const dir = path.join(tmp, 'groups', 'g1');
    expect(fs.existsSync(dir)).toBe(true);

    expect(svc.deleteGroup('g1')).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(svc.deleteGroup('g1')).toBe(false);
  });

  it('loadGroupsFromDisk 从磁盘恢复群组（幂等）', () => {
    // 预写磁盘 group.json（模拟重启前残留）
    const dir = path.join(tmp, 'groups', 'g9');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'group.json'), JSON.stringify({
      group_id: 'g9', name: '群9', participants: ['a'], created_at: 123,
    }), 'utf-8');

    const svc = new GroupService(gm, tmp);
    expect(svc.loadGroupsFromDisk()).toBe(1);
    expect(gm.getGroup('g9')?.name).toBe('群9');
    // 重复加载跳过已存在
    expect(svc.loadGroupsFromDisk()).toBe(0);
    expect(gm.listGroups().length).toBe(1);
  });

  it('getGroupHistory 支持 limit/offset 从最新往回分页', async () => {
    const svc = new GroupService(gm, tmp);
    svc.createGroup({ group_id: 'g1', name: '群1', participants: ['a', 'b'] });
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      role: 'agent',
      agent_id: i % 2 ? 'b' : 'a',
      content: `m${i + 1}`,
      timestamp: `2026-08-07T00:00:0${i + 1}.000Z`,
    }));
    writeGroupMessages('g1', msgs);

    const last2 = svc.getGroupHistory('g1', 2);
    expect(last2.map((m) => m.content)).toEqual(['m4', 'm5']);
    const off1 = svc.getGroupHistory('g1', 2, 1);
    expect(off1.map((m) => m.content)).toEqual(['m3', 'm4']);
  });

  it('getGroupHistory limit=1 快速路径：只返回最后一条消息', async () => {
    const svc = new GroupService(gm, tmp);
    svc.createGroup({ group_id: 'g1', name: '群1', participants: ['a', 'b'] });
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      role: 'agent',
      agent_id: i % 2 ? 'b' : 'a',
      content: `m${i + 1}`,
      timestamp: `2026-08-07T00:00:0${i + 1}.000Z`,
    }));
    writeGroupMessages('g1', msgs);

    const [m] = svc.getGroupHistory('g1', 1);
    expect(m.content).toBe('m5');
  });

  // ---- GroupFeed（单通道化 v3）：readSince / currentAnchor ----

  /** 预置 3 条带 id 的群消息（a→b 视角） */
  async function seedFeedMessages(svc: GroupService, gid = 'g1') {
    svc.createGroup({ group_id: gid, name: '测试群', participants: ['a', 'b'] });
    writeGroupMessages(gid, [
      { role: 'agent', agent_id: 'a', content: '第一条', message_id: 'm1', timestamp: '2026-08-17T12:00:00Z' },
      { role: 'agent', agent_id: 'a', content: '第二条', message_id: 'm2', timestamp: '2026-08-17T12:00:01Z' },
      { role: 'agent', agent_id: 'a', content: '第三条', message_id: 'm3', timestamp: '2026-08-17T12:00:02Z' },
    ]);
  }

  it('readSince：锚点后增量（peer 消息 <msg> 包装，群名/显示名一致）+ 推进锚点', async () => {
    const svc = new GroupService(gm, tmp);
    await seedFeedMessages(svc);

    const page = await svc.readSince('g1', { message_id: 'm1' }, { viewer: 'b' });
    expect(page.injected).toContain('<msg from="a" name="A" group="测试群">第二条</msg>');
    expect(page.injected).toContain('<msg from="a" name="A" group="测试群">第三条</msg>');
    expect(page.message_ids).toEqual(['m2', 'm3']);
    expect(page.anchor).toEqual({ message_id: 'm3', line: 2 });
  });

  it('readSince：own 消息不包装（与 loadGroupHistory 行为一致）', async () => {
    const svc = new GroupService(gm, tmp);
    await seedFeedMessages(svc);

    const page = await svc.readSince('g1', { message_id: 'm1' }, { viewer: 'a' });
    expect(page.injected).not.toContain('<msg');
    expect(page.injected).toContain('第二条');
  });

  it('readSince：锚点=最新 → 空增量；无锚点 → 空增量（防双注）', async () => {
    const svc = new GroupService(gm, tmp);
    await seedFeedMessages(svc);

    const pageLatest = await svc.readSince('g1', { message_id: 'm3' }, { viewer: 'b' });
    expect(pageLatest.injected).toBe('');
    expect(pageLatest.anchor).toEqual({ message_id: 'm3', line: 2 });

    const pageNoAnchor = await svc.readSince('g1', undefined, { viewer: 'b' });
    expect(pageNoAnchor.injected).toBe('');
  });

  it('readSince：line 回退（锚点无 message_id）+ 超限截断头部提示', async () => {
    const svc = new GroupService(gm, tmp);
    await seedFeedMessages(svc);

    // line 回退：anchor.line=0 → 增量 = 第 2、3 条
    const page = await svc.readSince('g1', { line: 0 }, { viewer: 'b' });
    expect(page.message_ids).toEqual(['m2', 'm3']);

    // maxTokens=1：只保留最新一条 + 头部「另有 N 条」提示
    const pageTiny = await svc.readSince('g1', { message_id: 'm1' }, { viewer: 'b', maxTokens: 1 });
    expect(pageTiny.injected).toContain('另有 1 条更早的群消息未注入');
    expect(pageTiny.injected).toContain('第三条');
    expect(pageTiny.injected).not.toContain('第二条</msg>');
  });

  it('currentAnchor：返回本体尾（最新 id + 行号）', async () => {
    const svc = new GroupService(gm, tmp);
    await seedFeedMessages(svc);

    const anchor = await svc.currentAnchor('g1');
    expect(anchor).toEqual({ message_id: 'm3', line: 2 });
  });

  // ---- Phase 2.5 本体轮转（容量管理：恢复 v0.4.x group-archive 轮转语义）----

  it('本体轮转：超阈值 → 旧消息入 archive/history_N + 摘要 + 本体保留尾部', async () => {
    const svc = new GroupService(gm, tmp, { archiveTokens: 100, keepTokens: 20 });
    svc.createGroup({ group_id: 'g1', name: '群1', participants: ['a', 'b'] });

    for (let i = 0; i < 10; i++) {
      await gm.deliverGroupMessage({
        from: 'a', to: '*', type: 'chat.send', payload: `消息${i}：${'早期讨论内容'.repeat(20)}`, group_id: 'g1',
      } as any);
    }

    // 本体只剩尾部（远小于 10 条；低阈值下每条触发一轮转）
    const body = svc.getGroupHistory('g1', 1000);
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThan(10);
    expect(body[body.length - 1].content).toContain('消息9'); // 尾部保留最新

    const archiveDir = path.join(tmp, 'sessions', 'group~g1', 'archive');
    const historyFiles = fs.readdirSync(archiveDir).filter((f) => /^history_\d+\.jsonl$/.test(f));
    expect(historyFiles.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(archiveDir, 'summary_1.md'))).toBe(true);

    // 摘要可读（最新一份含归档消息条目）
    const summary = svc.readLatestArchiveSummary('g1');
    expect(summary).toContain('消息');
    // 消息不丢：本体 + 全部归档 = 10
    const archivedTotal = historyFiles.reduce(
      (acc, f) => acc + fs.readFileSync(path.join(archiveDir, f), 'utf-8').split('\n').filter(Boolean).length, 0,
    );
    expect(archivedTotal + body.length).toBe(10);
  });

  it('本体轮转：未超阈值不轮转（无归档产物）', async () => {
    const svc = new GroupService(gm, tmp); // 默认 50 万阈值
    svc.createGroup({ group_id: 'g1', name: '群1', participants: ['a', 'b'] });
    for (let i = 0; i < 5; i++) {
      await gm.deliverGroupMessage({ from: 'a', to: '*', type: 'chat.send', payload: `m${i}`, group_id: 'g1' } as any);
    }
    expect(svc.getGroupHistory('g1').length).toBe(5);
    expect(fs.existsSync(path.join(tmp, 'sessions', 'group~g1', 'archive'))).toBe(false);
  });
});

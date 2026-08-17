// ============================================================
// makeLoadHistoryHook 群聊 trigger hint 去重测试
//
// 背景（8/16 现场复现）：deliverGroupMessage 先 emit group.message.received
// （GroupService 同步落盘 messages.jsonl）→ 后 emit group.trigger（通知参与者）。
// 参与者 runStart 加载历史时，刚落盘的消息已写入 messages.jsonl
// （loadGroupHistory 会包含它），而 trigger hint 又携带同一消息
// （router.ts _wireGroupTriggers 的 <msg> 封装与 loadGroupHistory 逐字一致）
// → LLM 上下文同一条消息出现两次 → Agent 判为「消息重复投递」。
//
// 修复：makeLoadHistoryHook 群聊分支剔除历史中与 hint 相同的消息段
// （hint 已携带，无需历史再注入）。
//
// 8/17 补全：hint 消息后已跟上他人回复时（接收方 run 迟到），loadGroupHistory
// 把相邻对方发言合并成块、hint 段位于块首/块中——旧版仅匹配末尾会失配。
// 现按边界（整条/块首/块中/块尾）在整段历史内剔除。
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { makeLoadHistoryHook, makeGroupContractHook } from '@agentchat/agent-session';
import { CHAT_START_META_KEY, GROUP_CONTRACT_TEXT, GROUP_SYNC_META_KEY } from '@agentchat/contracts';
import type { CurrentContext } from '@agentchat/agent-loop';

describe('makeLoadHistoryHook 群聊 trigger hint 去重', () => {
  const gid = 'g1';
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-ghd-'));
    vi.stubEnv('AGENTCHAT_WORKSPACE', tmp);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function messagesFile(): string {
    return path.join(tmp, 'sessions', `group~${gid}`, 'messages.jsonl');
  }

  function writeMessages(msgs: Record<string, unknown>[]): void {
    const f = messagesFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, msgs.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
  }

  function writeGroupConfig(name: string): void {
    const f = path.join(tmp, 'groups', gid, 'group.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ group_id: gid, name }), 'utf-8');
  }

  function makeCtx(overrides: Partial<CurrentContext> = {}): CurrentContext {
    return {
      llm: {} as any,
      systemPrompt: '',
      history: [],
      tools: new Map(),
      inbox: { nextTurn: [], nextStep: [] },
      dialogId: `group~${gid}~neko`,
      agentId: 'neko',
      ...overrides,
    } as CurrentContext;
  }

  function makeHook() {
    // services 仅需要 router（getName/getGroupName 注入）；未注入时回退 agent_id/群 ID，不影响去重判定
    return makeLoadHistoryHook({ agent_id: 'neko' } as any, { router: undefined } as any);
  }

  it('群聊 trigger：历史末尾与 hint 相同的消息被剔除（单条独立场景）', async () => {
    writeMessages([
      { role: 'agent', agent_id: 'news', content: '晚间速递内容', timestamp: '2026-08-16T12:00:00Z' },
    ]);
    writeGroupConfig('愉快玩耍');
    const hook = makeHook();
    const ctx = makeCtx({
      meta: {
        [CHAT_START_META_KEY]: {
          hint: '<msg from="news" name="news" group="愉快玩耍">晚间速递内容</msg>\n\n[当前时间] 2026-08-16 20:00 周日\n收到群聊消息：若值得回应，请调用工具 send_group 把回复发回群聊——直接输出文本不会发送到群聊、其他成员看不到；若无话可说则保持沉默，请注意不要刷屏。',
          source: { kind: 'group', form: 'hint' },
        },
      },
    });
    await hook(ctx);
    // 历史只加载 hint 之前的内容；本条被剔除（hint 已携带）→ history 为空
    expect(ctx.history).toHaveLength(0);
  });

  it('群聊 trigger：历史末尾 hint 相同 + 更早历史共存时，只剔除末尾一条', async () => {
    writeMessages([
      { role: 'agent', agent_id: 'chat_agent', content: '更早的消息', timestamp: '2026-08-16T11:50:00Z' },
      { role: 'agent', agent_id: 'news', content: '晚间速递内容', timestamp: '2026-08-16T12:00:00Z' },
    ]);
    writeGroupConfig('愉快玩耍');
    const hook = makeHook();
    const ctx = makeCtx({
      meta: {
        [CHAT_START_META_KEY]: {
          hint: '<msg from="news" name="news" group="愉快玩耍">晚间速递内容</msg>\n\n[当前时间] 2026-08-16 20:00 周日\n收到群聊消息：若值得回应，请调用工具 send_group 把回复发回群聊。',
          source: { kind: 'group', form: 'hint' },
        },
      },
    });
    await hook(ctx);
    expect(ctx.history).toHaveLength(1);
    expect(ctx.history[0].content).toContain('更早的消息');
    expect(ctx.history[0].content).not.toContain('晚间速递内容');
  });

  it('群聊 trigger：合并场景（相邻对方视角已合并）剔除末尾 hint 段', async () => {
    writeMessages([
      { role: 'agent', agent_id: 'chat_agent', content: '第一条', timestamp: '2026-08-16T11:59:00Z' },
      { role: 'agent', agent_id: 'test', content: '第二条', timestamp: '2026-08-16T11:59:01Z' },
    ]);
    writeGroupConfig('愉快玩耍');
    const hook = makeHook();
    const ctx = makeCtx({
      meta: {
        [CHAT_START_META_KEY]: {
          hint: '<msg from="test" name="test" group="愉快玩耍">第二条</msg>\n\n[当前时间] 2026-08-16 20:00 周日\n收到群聊消息。',
          source: { kind: 'group', form: 'hint' },
        },
      },
    });
    await hook(ctx);
    // 两条对方消息被 loadGroupHistory 合并为一条；末尾 hint 段被剔除，保留第一条
    expect(ctx.history).toHaveLength(1);
    expect(ctx.history[0].content).toContain('第一条');
    expect(ctx.history[0].content).not.toContain('第二条');
  });

  // ---- 8/17 现场复现（chat~…group 8/17 19:59 补丁消息 + 20:00 晚间速递两个样本）----
  // 接收方 run 迟到：hint 消息之后已有他人回复落盘并合并成块，hint 段位于合并块
  // 头部——旧版 endsWith 失配 → 同一条消息在上下文出现两遍（test 收双遍，
  // run 即时触发的 news/小七收单遍为对照组）。
  it('8/17 场景：hint 段位于合并块头部（后跟他人回复）同样被剔除', async () => {
    writeMessages([
      { role: 'agent', agent_id: 'news', content: '晚间速递 · 08-17', timestamp: '2026-08-17T12:00:40Z' },
      { role: 'agent', agent_id: 'chat_agent', content: '收到～观察位我继续挂着', timestamp: '2026-08-17T12:00:47Z' },
    ]);
    writeGroupConfig('愉快玩耍');
    const hook = makeHook();
    const ctx = makeCtx({
      meta: {
        [CHAT_START_META_KEY]: {
          hint: '<msg from="news" name="news" group="愉快玩耍">晚间速递 · 08-17</msg>\n\n[当前时间] 2026-08-17 20:01 周一\n收到群聊消息。',
          source: { kind: 'group', form: 'hint' },
        },
      },
    });
    await hook(ctx);
    // 合并块 = 速递段 + 小七回复段；头部速递段被剔除，回复保留
    expect(ctx.history).toHaveLength(1);
    expect(ctx.history[0].content).toContain('观察位我继续挂着');
    expect(ctx.history[0].content).not.toContain('晚间速递');
  });

  it('8/17 场景：hint 段位于合并块中部（前后均有他人消息）被剔除', async () => {
    writeMessages([
      { role: 'agent', agent_id: 'news', content: '前一条', timestamp: '2026-08-17T11:59:00Z' },
      { role: 'agent', agent_id: 'user2', content: '风栗补丁消息', timestamp: '2026-08-17T11:59:17Z' },
      { role: 'agent', agent_id: 'chat_agent', content: '后一条回复', timestamp: '2026-08-17T11:59:57Z' },
    ]);
    writeGroupConfig('愉快玩耍');
    const hook = makeHook();
    const ctx = makeCtx({
      meta: {
        [CHAT_START_META_KEY]: {
          hint: '<msg from="user2" name="user2" group="愉快玩耍">风栗补丁消息</msg>\n\n[当前时间] 2026-08-17 20:00 周一\n收到群聊消息。',
          source: { kind: 'group', form: 'hint' },
        },
      },
    });
    await hook(ctx);
    // 三条对方消息合并成一块；中间段被剔除，前后保留
    expect(ctx.history).toHaveLength(1);
    expect(ctx.history[0].content).toContain('前一条');
    expect(ctx.history[0].content).toContain('后一条回复');
    expect(ctx.history[0].content).not.toContain('风栗补丁消息');
  });

  it('nextStep 待注入的 hint 段同样参与历史去重（steer 注入前置剔除）', async () => {
    writeMessages([
      { role: 'agent', agent_id: 'news', content: '速递内容', timestamp: '2026-08-17T12:00:40Z' },
      { role: 'agent', agent_id: 'chat_agent', content: '小七回复', timestamp: '2026-08-17T12:00:47Z' },
    ]);
    writeGroupConfig('愉快玩耍');
    const hook = makeHook();
    const ctx = makeCtx({
      meta: { [CHAT_START_META_KEY]: { source: { kind: 'group', form: 'hint' } } },
      inbox: {
        nextTurn: [],
        nextStep: [{
          role: 'user',
          content: '<msg from="news" name="news" group="愉快玩耍">速递内容</msg>\n\n[当前时间] 2026-08-17 20:01 周一\n收到群聊消息。',
        }],
      } as any,
    });
    await hook(ctx);
    // nextStep 将在本 run 注入该段 → 历史里的重复副本被剔除，仅剩小七回复
    expect(ctx.history).toHaveLength(1);
    expect(ctx.history[0].content).toContain('小七回复');
    expect(ctx.history[0].content).not.toContain('速递内容');
  });

  // ---- Phase 1 ID 贯通（docs/group-single-channel-design.md §3）：message_id 去重 ----
  // 落盘行与 trigger 经 deliverGroupMessage 统一铸造的 correlation_id 同源；
  // 即使 hint 封装文本与历史封装漂移（改名/格式变化），按 id 的 pre-merge 行级
  // 剔除依然精确——字符串匹配降级为旧数据兜底。
  it('ID 路径：hint 封装文本漂移（名称不一致）仍按 message_id 剔除', async () => {
    writeMessages([
      { role: 'agent', agent_id: 'news', content: '速递内容', message_id: 'msg-dedup-001', timestamp: '2026-08-17T12:00:40Z' },
      { role: 'agent', agent_id: 'chat_agent', content: '小七回复', message_id: 'msg-dedup-002', timestamp: '2026-08-17T12:00:47Z' },
    ]);
    writeGroupConfig('愉快玩耍');
    const hook = makeHook();
    const ctx = makeCtx({
      meta: {
        [CHAT_START_META_KEY]: {
          // 故意漂移：name 与历史封装不一致（模拟改名/getName 查询失败），字符串路径必然失配
          hint: '<msg from="news" name="莉莉新闻V2" group="愉快玩耍">速递内容</msg>\n\n[当前时间] 2026-08-17 20:01 周一\n收到群聊消息。',
          source: { kind: 'group', form: 'hint', message_id: 'msg-dedup-001' },
        },
      },
    });
    await hook(ctx);
    // id 命中：速递（msg-dedup-001）被剔除，只剩小七回复
    expect(ctx.history).toHaveLength(1);
    expect(ctx.history[0].content).toContain('小七回复');
    expect(ctx.history[0].content).not.toContain('速递内容');
  });

  it('ID 路径：nextStep steer 携带 message_id 时同样剔除（busy 注入场景）', async () => {
    writeMessages([
      { role: 'agent', agent_id: 'news', content: '触发消息', message_id: 'msg-dedup-101', timestamp: '2026-08-17T12:00:40Z' },
    ]);
    writeGroupConfig('愉快玩耍');
    const hook = makeHook();
    const ctx = makeCtx({
      meta: { [CHAT_START_META_KEY]: { source: { kind: 'group', form: 'hint' } } },
      inbox: {
        nextTurn: [],
        nextStep: [{
          role: 'user',
          content: '<msg from="news" name="改名后的莉莉" group="愉快玩耍">触发消息</msg>',
          source: { kind: 'group', form: 'hint', message_id: 'msg-dedup-101' },
        }],
      } as any,
    });
    await hook(ctx);
    expect(ctx.history).toHaveLength(0);
  });

  it('非群聊 trigger（无 hint 或 hint 非 <msg 开头）不剔除历史', async () => {
    writeMessages([
      { role: 'agent', agent_id: 'news', content: '正常历史', timestamp: '2026-08-16T11:00:00Z' },
    ]);
    writeGroupConfig('愉快玩耍');
    const hook = makeHook();
    // 无 meta（如用户主动打开群聊历史加载）
    const ctx = makeCtx({});
    await hook(ctx);
    expect(ctx.history).toHaveLength(1);
    expect(ctx.history[0].content).toContain('正常历史');
  });

  it('1v1 会话不走群聊分支（不受 hint 去重影响）', async () => {
    const hook = makeHook();
    const ctx = makeCtx({
      dialogId: 'chat~neko~news',
      agentId: 'neko',
      meta: {
        [CHAT_START_META_KEY]: {
          hint: '任意 hint',
          source: { kind: 'system', form: 'hint' },
        },
      },
    });
    await hook(ctx);
    // 1v1 无历史文件 → 空；不抛错即可（关键是不进入群聊分支）
    expect(ctx.history).toEqual([]);
  });

  // ---- runStart 锚点记录（单通道化 §2.3：busy readSince 的增量起点）----
  it('load-history 后记录群读取锚点到 ctx.meta[group.sync]（= 本体尾）', async () => {
    writeMessages([
      { role: 'agent', agent_id: 'news', content: '速递', message_id: 'anchor-tail-1', timestamp: '2026-08-17T12:00:40Z' },
      { role: 'agent', agent_id: 'chat_agent', content: '回复', message_id: 'anchor-tail-2', timestamp: '2026-08-17T12:00:47Z' },
    ]);
    writeGroupConfig('愉快玩耍');
    const ctx = makeCtx({});
    await makeHook()(ctx);
    expect((ctx.meta as any)[GROUP_SYNC_META_KEY]).toEqual({ message_id: 'anchor-tail-2', line: 1 });
  });

  // ---- Phase 2.5：归档摘要注入（本体轮转后的长期记忆锚点）----
  it('归档摘要注入：有 summary_N.md 时历史头部带摘要', async () => {
    writeMessages([
      { role: 'agent', agent_id: 'news', content: '近期消息', message_id: 's-1', timestamp: '2026-08-17T12:00:40Z' },
    ]);
    writeGroupConfig('愉快玩耍');
    const archiveDir = path.join(tmp, 'sessions', `group~${gid}`, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, 'summary_1.md'), '# 群聊 g1 早期摘要\n\n- [2026-08-01 10:00] news: 早期重要事项记档', 'utf-8');

    const ctx = makeCtx({});
    await makeHook()(ctx);
    expect(ctx.history[0].content).toContain('归档摘要');
    expect(ctx.history[0].content).toContain('早期重要事项记档');
    expect(ctx.history[1].content).toContain('近期消息');
  });

  it('无归档摘要时不注入头部消息（行为不变）', async () => {
    writeMessages([
      { role: 'agent', agent_id: 'news', content: '近期消息', message_id: 's-1', timestamp: '2026-08-17T12:00:40Z' },
    ]);
    writeGroupConfig('愉快玩耍');
    const ctx = makeCtx({});
    await makeHook()(ctx);
    expect(ctx.history).toHaveLength(1);
    expect(ctx.history[0].content).toContain('近期消息');
  });
});

// ============================================================
// group-contract 契约钩子（单通道化 v3 §2.4，I11）
// ============================================================
describe('makeGroupContractHook 群聊行为契约注入', () => {
  const gid = 'g2';
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-gc-'));
    vi.stubEnv('AGENTCHAT_WORKSPACE', tmp);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function contractCtx(kind: string): CurrentContext {
    return {
      llm: {} as any,
      systemPrompt: '',
      history: [{ role: 'agent', content: '已有历史' } as any],
      tools: new Map(),
      inbox: { nextTurn: [], nextStep: [] },
      dialogId: `group~${gid}~neko`,
      agentId: 'neko',
      meta: { [CHAT_START_META_KEY]: { source: { kind, form: 'hint' } } },
    } as any;
  }

  it('kind=group：契约追加在已加载历史尾部（位置契约：决策点之前、currentMessage 之后可见）', async () => {
    const ctx = contractCtx('group');
    await makeGroupContractHook({ agent_id: 'neko' } as any)(ctx);
    expect(ctx.history).toHaveLength(2);
    expect(ctx.history[0].content).toBe('已有历史');          // 历史在前
    expect(ctx.history[1].content).toBe(GROUP_CONTRACT_TEXT);  // 契约在尾部
    expect((ctx.history[1] as any).source).toEqual({ kind: 'group', form: 'notice' });
  });

  it('非 group 触发（timer/system/1v1）不注入', async () => {
    const timerCtx = contractCtx('timer');
    await makeGroupContractHook({ agent_id: 'neko' } as any)(timerCtx);
    expect(timerCtx.history).toHaveLength(1);

    const oneOnOne: any = contractCtx('group');
    oneOnOne.dialogId = 'chat~neko~news';
    await makeGroupContractHook({ agent_id: 'neko' } as any)(oneOnOne);
    expect(oneOnOne.history).toHaveLength(1);
  });

  it('契约文案逐字节锁定（I11：默认正典受快照保护，修改需过 A/B 验收）', () => {
    expect(GROUP_CONTRACT_TEXT).toBe(
      '收到群聊消息：若值得回应，请调用工具 send_group 把回复发回群聊——直接输出文本不会发送到群聊、其他成员看不到；若无话可说则保持沉默，请注意不要刷屏。',
    );
  });

  it('契约可配置：agent.group.groupContractText 覆盖正典（自定义文案实验）', async () => {
    const ctx = contractCtx('group');
    await makeGroupContractHook({
      agent_id: 'neko',
      'agent.group': { groupContractText: '群规试行版：惜字如金，只在被点名时回应' },
    } as any)(ctx);
    expect(ctx.history[1].content).toBe('群规试行版：惜字如金，只在被点名时回应');
  });

  it('契约可配置：空串/空白回落正典（不因配置误填丢契约）', async () => {
    const ctx = contractCtx('group');
    await makeGroupContractHook({
      agent_id: 'neko',
      'agent.group': { groupContractText: '   ' },
    } as any)(ctx);
    expect(ctx.history[1].content).toBe(GROUP_CONTRACT_TEXT);
  });
});

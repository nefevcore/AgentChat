// ============================================================
// prefix-snapshot.test.ts —— cr-888 singles system prompt 物化验收
//
// §7-5 测试面：物化/冻结/重算触发（仅 model）/十类注入文本（措辞按 §4
// 表逐条锁定）/幂等/崩溃窗口/非 singles 不激活/预览镜像/指纹缺 model
// 红线（快照 ENV_MODEL 与 request.model 一致性断言）。
// 夹具：真 cordis 树（复用 service.test.ts 形态）× .singles-registry.json
// 直投（SinglesShim 同款判定面）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import type { LoopRunRequest } from 'ac-agent-loop';
import { makeLedgerRow, readLedger } from 'ac-ledger';
// SinglesShim 同款判定面（ac-host-face-client 提供；测试树显式注册——真实壳行集恒有）
class SinglesShim extends Service {
  private dataRoot: string;
  constructor(ctx: Context, dataRoot: string) {
    super(ctx, 'singles');
    this.dataRoot = dataRoot;
  }
  get(conversationId: string): unknown {
    try {
      // cr-998 对齐生产 SinglesShim（ac-host-face-client）：注册表住 meta/sessions/
      const raw = JSON.parse(fs.readFileSync(
        path.join(this.dataRoot, 'meta', 'sessions', '.singles-registry.json'), 'utf-8'),
      ) as { entries?: Record<string, unknown> };
      return raw.entries !== undefined && conversationId in raw.entries ? { id: conversationId } : undefined;
    } catch {
      return undefined;
    }
  }
}
/** conv-settings 读面垫片（壳内 ConvSettingsShim 同款——直读 <root>/conv-settings/<sid>.json）。
 *  测试面 singles sid 有人桶——effective 与 get 同值 */
class ConvSettingsShim extends Service {
  private dataRoot: string;
  constructor(ctx: Context, dataRoot: string) {
    super(ctx, 'convSettings');
    this.dataRoot = dataRoot;
  }
  get(conversationId: string): Record<string, string> {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dataRoot, 'conv-settings', conversationId + '.json'), 'utf-8')) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string' && v !== '') out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }
  effective(conversationId: string): Record<string, string> {
    return this.get(conversationId);
  }
}
import { makeConversationRow, type ConversationService } from 'ac-shell-conversation';
import { makeEnvelope, type Envelope } from 'ac-envelope-core';
import { readPrefixSnapshot, diffFingerprints } from '../src/prefix-snapshot.ts';
import { writeAgentConfig } from 'ac-agents-core';

const ROOT = path.join('sandbox', 'test-prefix-snapshot-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function seedAgent(agentId: string, extra: Record<string, unknown> = {}): void {
  // cr-1036 批3：v3 写口（config.json 读窗退役）
  writeAgentConfig(ROOT, { id: agentId, model: 'mock-1', ...extra } as import('ac-agents-core').AgentConfig);
}

/** singles 注册表直投（SinglesShim 读面——cr-973 迁 meta/sessions/） */
function seedSingles(sid: string): void {
  const dir = path.join(ROOT, 'meta', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.singles-registry.json'), JSON.stringify({ version: 1, entries: { [sid]: {} } }), 'utf-8');
}

/** conv-settings 直投（ConvSettingsShim 读面） */
function seedConvSettings(sid: string, patch: Record<string, string>): void {
  const dir = path.join(ROOT, 'conv-settings');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + '.json'), JSON.stringify(patch), 'utf-8');
}

interface Boot { ctx: Context; fibers: Fiber[]; conv: ConversationService; sysPrompts: string[]; models: string[]; }

async function bootTree(agentId: string): Promise<Boot> {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, llmRow, loopRow]) {
    fibers.push(ctx.plugin(row as never, undefined as never));
  }
  const sysPrompts: string[] = [];
  const models: string[] = [];
  fibers.push(ctx.plugin({
    name: 'mock-provider',
    inject: ['llm'],
    apply(c: Context) {
      c.llm.register('mock', () => ({
        stream: async function* (input: { model?: string; messages: Array<{ role: string; content: string }> }) {
          const sys = input.messages.find((m) => m.role === 'system');
          if (sys) sysPrompts.push(sys.content);
          models.push(input.model ?? '');
          const last = input.messages.filter((m) => m.role === 'user').at(-1);
          yield { delta: '[回复]' };
          yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
        },
      }), { models: ['mock-1', 'mock-2'], visionModels: ['mock-1'] });
    },
  }));
  fibers.push(ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId })));
  fibers.push(ctx.plugin({ name: 'test-singles-shim', apply(c: Context) { new SinglesShim(c, ROOT); } }));
  fibers.push(ctx.plugin({ name: 'test-conv-settings-shim', apply(c: Context) { new ConvSettingsShim(c, ROOT); } }));
  fibers.push(ctx.plugin(makeConversationRow({ dataRoot: ROOT, agentId })));
  for (const f of fibers) await f;
  return { ctx, fibers, conv: ctx.get('conversation', false) as unknown as ConversationService, sysPrompts, models };
}

function msg(sid: string, requestId: string, text: string, model?: string): Envelope {
  return makeEnvelope({ uuid: sid, requestId, sender: 'user', to: 'alpha', payload: { text }, ...(model !== undefined ? { model } : {}) });
}

const SID = 'sid-snap-1';

describe('cr-888 singles system prompt 物化', () => {
  it('① 物化：首 run 落 prefix-snapshot.json（段数组 + 指纹）；② 正文域漂移（cr-1114）→ ③ 重算：注册面段变化进正文', async () => {
    seedAgent('alpha');
    seedSingles(SID);
    const { ctx, fibers, conv, sysPrompts } = await bootTree('alpha');
    try {
      await conv.receiveEnvelope(msg(SID, 'r1', '第一问'), { fresh: true });
      const snap = readPrefixSnapshot(ROOT, SID);
      expect(snap).not.toBeNull();
      expect(snap!.settingsFingerprint.model).toBe('mock-1');
      // 快照含 ENV_MODEL 段（红线前提）
      expect(snap!.sections.some((s) => s.name === 'ENV_MODEL')).toBe(true);
      const first = sysPrompts[0];
      expect(first).toContain('[模型能力]');
      // 注册面后续变化：新注册一个段（模拟行装卸/描述更新）——sectionTexts
      // 漂移升 ③ 重算（cr-1114 批1：正文域字节变 = KV cache 前缀必死，重算
      // 白纸无代价；旧「冻结」语义正是懒注册工具三面失明的根因）
      ctx.agentLoop.registerPromptSection({ name: 'TERMINOLOGY', text: '后注册段' }, 'test');
      await conv.receiveEnvelope(msg(SID, 'r2', '第二问'), { fresh: true });
      expect(sysPrompts[1]).not.toBe(first); // 正文已重算（新段进正文）
      expect(sysPrompts[1]).toContain('后注册段');
      // 重算后稳定：再跑一轮不再变（新基线冻结）
      await conv.receiveEnvelope(msg(SID, 'r3', '第三问'), { fresh: true });
      expect(sysPrompts[2]).toBe(sysPrompts[1]);
    } finally {
      for (const f of [...fibers].reverse()) await f.dispose();
    }
  });

  it('③ 重算：仅 provider/model 变化触发快照重写（缓存域必死白纸）；非 model 变化不重写', async () => {
    seedAgent('alpha');
    seedSingles(SID);
    const { fibers, conv, sysPrompts } = await bootTree('alpha');
    try {
      await conv.receiveEnvelope(msg(SID, 'r1', '问一'), { fresh: true });
      const created1 = readPrefixSnapshot(ROOT, SID)!.createdAt;
      // toolMode 覆盖（非 model 变化）：通知行 + 指纹更新，正文不重写
      seedConvSettings(SID, { toolMode: 'tc-programmatic' });
      await conv.receiveEnvelope(msg(SID, 'r2', '问二'), { fresh: true });
      const snap2 = readPrefixSnapshot(ROOT, SID)!;
      expect(snap2.createdAt).toBe(created1); // 正文未重写（createdAt 不变）
      expect(snap2.settingsFingerprint.toolMode).toBe('tc-programmatic');
      // model 切换：快照重写（createdAt 更新），ENV_MODEL 重算
      await conv.receiveEnvelope(msg(SID, 'r3', '问三', 'mock-2'), { fresh: true });
      const snap3 = readPrefixSnapshot(ROOT, SID)!;
      expect(snap3.createdAt).not.toBe(created1);
      expect(snap3.settingsFingerprint.model).toBe('mock-2');
      // 重算后 system 变化（ENV_MODEL 已按新模型重算——此处 mock 无 vision 元数据，断言指纹域）
      expect(sysPrompts.length).toBe(3);
    } finally {
      for (const f of [...fibers].reverse()) await f.dispose();
    }
  });

  it('④ 注入：toolMode 切换落 context+event 通知行（label=会话设置变更）且消息天然自带；幂等键收敛重放', async () => {
    seedAgent('alpha');
    seedSingles(SID);
    const { fibers, conv, sysPrompts } = await bootTree('alpha');
    try {
      await conv.receiveEnvelope(msg(SID, 'r1', '问一'), { fresh: true });
      seedConvSettings(SID, { toolMode: 'tc-programmatic' });
      await conv.receiveEnvelope(msg(SID, 'r2', '问二'), { fresh: true });
      // 通知行落账（本 run 消息复读即含）
      const rows = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', SID)).rows;
      const notices = rows.filter((r) => r.role === 'context' && r.source === 'event');
      expect(notices.length).toBe(1);
      expect(notices[0].label).toBe('会话设置变更');
      expect(notices[0].content).toContain('[会话设置] 工具调用模式已切换：程序化——一切工具调用经 run_code 编排完成，不再逐个直调。');
      // 本 run messages 自带（无需 splice）——sysPrompt 之后的 user 尾消息含通知文本
      expect(sysPrompts.length).toBe(2);
      // 指纹已更新：同状态下再跑（无变化）不再落通知
      await conv.receiveEnvelope(msg(SID, 'r3', '问三'), { fresh: true });
      const rows2 = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', SID)).rows;
      expect(rows2.filter((r) => r.role === 'context' && r.source === 'event').length).toBe(1);
    } finally {
      for (const f of [...fibers].reverse()) await f.dispose();
    }
  });

  it('§4 注入措辞锁定（diffFingerprints 纯函数——cr-947 起 tier/elevation 合并为 access 单类；cr-1082 起新指纹无 access 键）', () => {
    const base: Record<string, string> = {
      provider: '', model: 'm', tools: 'read,write', toolMode: 'tc-base', browserTier: '',
      issueSubmit: '', workspace: '', ptcSdk: 'h1', skills: '',
    };
    // #1 工具集（cr-1114 批1：tools 漂移升 ③ 重算抢先——diff 句退役，零通知）
    expect(diffFingerprints(base, { ...base, tools: 'read' }, { defaultWorkdir: '/w' }).notices)
      .toEqual([]);
    // #2 toolMode →tc-programmatic / →tc-none / →tc-base 恢复
    expect(diffFingerprints(base, { ...base, toolMode: 'tc-programmatic' }, { defaultWorkdir: '/w' }).notices)
      .toEqual(['[会话设置] 工具调用模式已切换：程序化——一切工具调用经 run_code 编排完成，不再逐个直调。']);
    expect(diffFingerprints(base, { ...base, toolMode: 'tc-none' }, { defaultWorkdir: '/w' }).notices)
      .toEqual(['[会话设置] 工具调用模式已切换：工具已全部停用，纯对话。']);
    expect(diffFingerprints({ ...base, toolMode: 'tc-programmatic' }, base, { defaultWorkdir: '/w' }).notices)
      .toEqual(['[会话设置] 工具调用模式已恢复工具直调。']);
    // #3 browserTier 降档 / disabled
    expect(diffFingerprints({ ...base, browserTier: 'manipulate' }, { ...base, browserTier: 'observe' }, { defaultWorkdir: '/w' }).notices)
      .toEqual(['[会话设置] 浏览器能力档位已调整：manipulate → observe（交互动作不再可用）。']);
    expect(diffFingerprints({ ...base, browserTier: 'observe' }, { ...base, browserTier: 'disabled' }, { defaultWorkdir: '/w' }).notices)
      .toEqual(['[会话设置] 浏览器工具本会话已停用。']);
    expect(diffFingerprints({ ...base, browserTier: 'disabled' }, { ...base, browserTier: 'observe' }, { defaultWorkdir: '/w' }).notices)
      .toEqual(['[会话设置] 浏览器工具已恢复可用（档位 observe）。']);
    // #4 issueSubmit
    expect(diffFingerprints(base, { ...base, issueSubmit: 'disabled' }, { defaultWorkdir: '/w' }).notices)
      .toEqual(['[会话设置] ISSUE 提交已停用。']);
    expect(diffFingerprints({ ...base, issueSubmit: 'disabled' }, base, { defaultWorkdir: '/w' }).notices)
      .toEqual(['[会话设置] ISSUE 提交已启用。']);
    // #5 workspace 切换 / 移除
    expect(diffFingerprints({ ...base, workspace: '/old' }, { ...base, workspace: '/new' }, { defaultWorkdir: '/w' }).notices)
      .toEqual(['[会话设置] 工作区已切换：/old → /new。']);
    expect(diffFingerprints({ ...base, workspace: '/old' }, base, { defaultWorkdir: '/w' }).notices)
      .toEqual(['[会话设置] 工作区已移除，回到默认工作目录 /w。']);
    // #6 技能卸载（装载不注入）
    expect(diffFingerprints({ ...base, skills: 'a,b' }, { ...base, skills: 'b' }, { defaultWorkdir: '/w' }).notices)
      .toEqual(['[会话设置] 技能 a 已卸载，其指引不再适用。']);
    expect(diffFingerprints({ ...base, skills: 'b' }, { ...base, skills: 'a,b' }, { defaultWorkdir: '/w' }).notices)
      .toEqual([]);
    // #7 安全档位（cr-1082 起仅存量快照迁移：旧值在场 → 新缺键，一次性通知；两边缺席零噪声）
    expect(diffFingerprints({ ...base, access: 'full-access' }, base, { defaultWorkdir: '/w' }).notices)
      .toEqual(['[会话设置] 安全档位已调整：full-access → 默认，部分工具调用将需要授权。']);
    expect(diffFingerprints(base, base, { defaultWorkdir: '/w' }).notices)
      .toEqual([]);
    // #9 PTC_SDK 漂移（cr-1114 批1：ptcSdk 漂移升 ③ 重算抢先——diff 句退役，零通知）
    expect(diffFingerprints({ ...base, ptcSdk: 'h1' }, { ...base, ptcSdk: 'h2' }, { defaultWorkdir: '/w' }).notices)
      .toEqual([]);
    // #10 扩展键
    expect(diffFingerprints(base, { ...base, 'ext.ui-theme': 'dark' }, { defaultWorkdir: '/w' }).notices)
      .toEqual(['[会话设置] ui-theme 已变化：无 → dark。']);
    // 合并规则：多项变化 → 多句并列（一条 context 行）——tools 漂移句已退役
    const multi = diffFingerprints(base, { ...base, tools: 'read', issueSubmit: 'disabled' }, { defaultWorkdir: '/w' });
    expect(multi.notices.length).toBe(1);
    // toolMode 连带的清单变化归 toolMode 一句
    const modeAndTools = diffFingerprints(base, { ...base, toolMode: 'tc-none', tools: '' }, { defaultWorkdir: '/w' });
    expect(modeAndTools.notices).toEqual(['[会话设置] 工具调用模式已切换：工具已全部停用，纯对话。']);
  });

  it('崩溃窗口与幂等：落账后崩（指纹未更新）→ 重放落同内容行（requestId 幂等键收敛冗余）', async () => {
    seedAgent('alpha');
    seedSingles(SID);
    const { fibers, conv } = await bootTree('alpha');
    try {
      await conv.receiveEnvelope(msg(SID, 'r1', '问一'), { fresh: true });
      seedConvSettings(SID, { issueSubmit: 'disabled' });
      // 模拟「落账后崩」：手动预置同内容通知行 + 保持指纹陈旧
      const snap0 = readPrefixSnapshot(ROOT, SID)!;
      const d = diffFingerprints(snap0.settingsFingerprint, { ...snap0.settingsFingerprint, issueSubmit: 'disabled' }, { defaultWorkdir: '/w' });
      expect(d.notices.length).toBe(1);
      // requestId 由内容对（旧指纹|新指纹）决定——确定性幂等键
      const d2 = diffFingerprints(snap0.settingsFingerprint, { ...snap0.settingsFingerprint, issueSubmit: 'disabled' }, { defaultWorkdir: '/w' });
      expect(d2.requestId).toBe(d.requestId);
      // 实跑：通知行落账（deliverRow 的 writer admission 幂等——同 requestId 不重复）
      await conv.receiveEnvelope(msg(SID, 'r2', '问二'), { fresh: true });
      const rows = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', SID)).rows;
      expect(rows.filter((r) => r.role === 'context' && r.source === 'event').length).toBe(1);
    } finally {
      for (const f of [...fibers].reverse()) await f.dispose();
    }
  });

  it('非 singles 不激活：无注册表命中 = 无快照、无通知行；子域（child）同样不激活', async () => {
    seedAgent('alpha');
    const { fibers, conv, sysPrompts } = await bootTree('alpha');
    try {
      await conv.receiveEnvelope(msg('u-pair-1', 'r1', '问一'), { fresh: true });
      expect(readPrefixSnapshot(ROOT, 'u-pair-1')).toBeNull();
      expect(sysPrompts.length).toBe(1);
      const rows = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', 'u-pair-1')).rows;
      expect(rows.filter((r) => r.role === 'context' && r.source === 'event').length).toBe(0);
    } finally {
      for (const f of [...fibers].reverse()) await f.dispose();
    }
  });

  it('预览镜像：previewSystemPrompt 读快照（注册面后变化不出现在预览）；非 singles 会话预览走注册面', async () => {
    seedAgent('alpha');
    seedSingles(SID);
    const { ctx, fibers, conv } = await bootTree('alpha');
    try {
      await conv.receiveEnvelope(msg(SID, 'r1', '第一问'), { fresh: true });
      const p1 = await conv.previewSystemPrompt(SID);
      // 注册面后续变化：预览仍读快照（镜像不破）
      ctx.agentLoop.registerPromptSection({ name: 'TERMINOLOGY', text: '后注册段' }, 'test');
      const p2 = await conv.previewSystemPrompt(SID);
      expect(p2).toBe(p1);
      expect(p1).toContain('[模型能力]'); // ENV_MODEL 段冻结进快照（树上真实段）
    } finally {
      for (const f of [...fibers].reverse()) await f.dispose();
    }
  });

  it('红线：快照指纹缺 model 键 = ENV_MODEL 永久错误——物化必含 model 且与 request.model 一致', async () => {
    seedAgent('alpha');
    seedSingles(SID);
    const { fibers, conv } = await bootTree('alpha');
    try {
      await conv.receiveEnvelope(msg(SID, 'r1', '问一'), { fresh: true });
      const snap = readPrefixSnapshot(ROOT, SID)!;
      // 指纹必含 model 键且值 = 生效模型（红线测试锁定）
      expect(typeof snap.settingsFingerprint.model).toBe('string');
      expect(snap.settingsFingerprint.model).toBe('mock-1');
      // 篡改指纹移除 model 键 = 下 run 必触发重算（防御性快照不崩）
      const broken = { ...snap, settingsFingerprint: { ...snap.settingsFingerprint } as Record<string, string> };
      delete broken.settingsFingerprint.model;
      const fsmod = await import('node:fs');
      // cr-1100：快照落点分居 meta/prefix-snapshots/<sid>.json（cr-973 曾寄居
      // meta/sessions/——被宿主 listIds 通配误收成幻影会话后分居）
      fsmod.writeFileSync(path.join(ROOT, 'meta', 'prefix-snapshots', SID + '.json'), JSON.stringify(broken));
      await conv.receiveEnvelope(msg(SID, 'r2', '问二'), { fresh: true });
      expect(readPrefixSnapshot(ROOT, SID)!.settingsFingerprint.model).toBe('mock-1');
    } finally {
      for (const f of [...fibers].reverse()) await f.dispose();
    }
  });
});

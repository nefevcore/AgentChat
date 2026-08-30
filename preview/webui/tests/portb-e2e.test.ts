// ============================================================
// tests/portb-e2e.test.ts —— Port B 端到端锁测试（收口形态，真 WS 全链路）
//
// node 'ws' 垫 + bootTree 自举服务器：src stores 直连 preview 协议
// （src/api/wire 传输 + feed/chat 状态机）——建档 → 发送 → 流式帧
// 状态机 → 历史 → resume。适配器已退役；本测试锁【UI ⇄ preview 契约
// 的组装】（帧合成表语义由 feed 状态机测试锁定；后端缝由
// ac-app/tests/webui-e2e.test.ts 锁定）。
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WS from 'ws';

// ---- ws 垫浏览器表面积（须在 wire 模块求值前挂全局） ----
class WsSocketShim {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private sock: WS;

  constructor(url: string | URL) {
    this.sock = new WS(url.toString());
    this.sock.on('open', () => this.onopen?.({}));
    this.sock.on('message', (data) => this.onmessage?.({ data: data.toString() }));
    this.sock.on('close', () => this.onclose?.({}));
    this.sock.on('error', () => this.onerror?.({}));
  }

  get readyState(): number {
    return this.sock.readyState;
  }

  send(text: string): void {
    this.sock.send(text);
  }

  close(): void {
    this.sock.close();
  }
}

(globalThis as unknown as { WebSocket: unknown }).WebSocket = WsSocketShim;
// stores/websocket 历史遗留读取点（logger/协议推导）；node 垫最小值
(globalThis as unknown as { location: unknown }).location = { protocol: 'http:', host: '127.0.0.1', origin: 'http://127.0.0.1', search: '' };
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

import type { BootedTree } from '../../ac-app/src/index.ts';
const { setWireSocketFactory, wireRpc } = await import('../src/api/wire.ts');
setWireSocketFactory(WsSocketShim as unknown as typeof WebSocket);
const { bootTree } = await import('../../ac-app/src/index.ts');
const { useChatStore } = await import('../src/stores/chat.ts');
const { createAgent } = await import('../src/api/roster.ts');
const { createPinia, setActivePinia } = await import('pinia');

function scriptedRow() {
  let counter = 0;
  /** provider 收到的 input 快照（api_key 注入链断言用） */
  const seenInputs: Array<Record<string, unknown>> = [];
  const row = {
    name: 'mock-scripted-llm',
    inject: ['llm'],
    apply(ctx: any) {
      ctx.llm.register(
        'scripted',
        () => ({
          stream: async function* (input: Record<string, unknown>) {
            seenInputs.push(input);
            const idx = counter++;
            if (idx === 0) {
              yield { delta: '', reasoning: '先想想' };
              yield { delta: '', toolCalls: [{ index: 0, id: 'c1', name: 'hello' }] };
              yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: '{"message":"preview"}' }] };
              yield { delta: '', finish: 'tool_calls' };
            } else {
              yield { delta: '工具结果已处理' };
              yield { delta: '', finish: 'stop', usage: { prompt: 2, completion: 3 } };
            }
          },
        }),
        { models: ['mock-1'] },
      );
    },
  };
  return { row, seenInputs };
}

let tree: BootedTree;
let dataRoot: string;
let port = 0;
/** scripted provider 收到的 input 快照（凭据注入链断言用） */
let seenInputs: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'ac-portb-e2e-'));
  tree = await bootTree({
    session: { root: dataRoot },
    group: { root: dataRoot },
    conversation: { root: dataRoot },
    usage: { root: dataRoot },
    credentials: { root: dataRoot },
    config: { root: dataRoot },
  });
  const scripted = scriptedRow();
  seenInputs = scripted.seenInputs;
  await tree.ctx.plugin(scripted.row as any);
  port = await tree.ctx.webServer.ready();
  (globalThis as unknown as { location: { host: string; origin: string } }).location.host = `127.0.0.1:${port}`;
  (globalThis as unknown as { location: { origin: string } }).location.origin = `http://127.0.0.1:${port}`;
}, 30_000);

afterAll(async () => {
  for (const fiber of [...tree.fibers.values()].reverse()) {
    if (fiber.uid !== null) await fiber.dispose();
  }
  await import('node:fs').then((fs) => fs.rmSync(dataRoot, { recursive: true, force: true }));
}, 30_000);

describe('Port B 端到端（wire + feed/chat 状态机，收口形态）', () => {
  it('建档 → 发送 → 流式状态机 → 历史 → resume 全链路', { timeout: 60_000 }, async () => {
    // ---- ① 建档（Port B RPC） ----
    const created = await createAgent({ id: 'helper', name: '小助手', provider: 'scripted', llm: { model: 'mock-1' }, tools: { include: ['hello'] } });
    expect(created.success).toBe(true);

    // ---- ② stores 初始化（feed 挂 wire 订阅拉起连接）+ 选中 Agent ----
    setActivePinia(createPinia());
    const chat = useChatStore();
    const { useAgentStore } = await import('../src/stores/agents.ts');
    useAgentStore().activeAgentId = 'helper';

    // ---- ③ 发送 → 全链路流式（feed 吃 preview 帧驱动状态机） ----
    chat.sendMessage('请用工具打个招呼', 'helper');
    // 等待 run 完成（after-run 驱动 chat.end 收束 → streaming 回落）
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!chat.contextBusy) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(chat.contextBusy).toBe(false);
    const { useFeedStore } = await import('../src/stores/feed.ts');

    const msgs = chat.messages;
    // 用户消息（乐观 UI）+ 流式产物（工具轮 + 正文轮）
    expect(msgs.some(m => m.agent_id === 'user' && m.content === '请用工具打个招呼')).toBe(true);
    // 工具卡：真 id 占位 + result 归属
    const toolMsg = msgs.find(m => m.role === 'tool' && m.tool_call_id === 'c1');
    expect(toolMsg).toBeDefined();
    expect(String(toolMsg!.content)).toContain('hello');
    // 思维链 + 正文
    const asst = msgs.find(m => m.role === 'agent' && m.content === '工具结果已处理');
    expect(asst).toBeDefined();
    expect(msgs.some(m => (m.reasoning_content ?? m.thinking ?? '').includes('先想想'))).toBe(true);
    // turns 派生：工具步骤 + final
    const turns = chat.turns;
    expect(turns.length).toBeGreaterThan(0);
    const withTools = turns.find(t => t.steps.some(s => s.tools.length > 0));
    expect(withTools).toBeDefined();

    // ---- ④ 历史回放（run 落盘后首屏拉取：RPC → toHistoryMessages → mergeHistory） ----
    await new Promise((r) => setTimeout(r, 400)); // 落盘 writer 冲刷
    chat.loadHistory('user', 'helper');
    await new Promise((r) => setTimeout(r, 600));
    const histMsgs = chat.messages;
    expect(histMsgs.some(m => m.agent_id === 'user' && m.content === '请用工具打个招呼')).toBe(true);
    expect(histMsgs.some(m => m.agent_id === 'helper' && m.content === '工具结果已处理')).toBe(true);

    // ---- ⑤ resume 降级（空闲 → active:false 无害） ----
    await chat.subscribeAgent('helper');
    await new Promise((r) => setTimeout(r, 300));
    expect(chat.turnInProgress).toBe(false);
  });

  it('singles 独立会话：绑定 Agent 发送 → 分区收到回复；未绑定 → 默认预设路由（src 语义）', { timeout: 60_000 }, async () => {
    const { createSingle } = await import('../src/api/singles.ts');
    const { useSinglesStore } = await import('../src/stores/singles.ts');

    // ---- ① 绑定 Agent 的独立会话：全链路（conversationId = sid 路由到 single 分区） ----
    const { session } = await createSingle({ agentId: 'helper' });
    const chat = useChatStore();
    const singlesStore = useSinglesStore();
    // selectSingle 同款路径（经 store；名册已含该会话）
    await singlesStore.refresh();
    singlesStore.selectSingle(session.id);
    chat.sendMessage('独立会话第一句');
    let deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!chat.contextBusy) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const msgs = chat.messages;
    expect(msgs.some(m => m.agent_id === 'user' && m.content === '独立会话第一句')).toBe(true);
    expect(msgs.some(m => m.agent_id === 'helper' && String(m.content).trim() !== '')).toBe(true);
    singlesStore.deselectSingle();

    // ---- ② 未绑定 Agent 的空会话：默认预设路由（__standard__，src 同款语义：
    //      agentId 空 → defaultPresetId；预设无记忆 settings；模型经会话级覆盖补齐） ----
    const { session: blank } = await createSingle({ reuse: false });
    await singlesStore.updateSession(blank.id, { model: 'mock-1' }); // 预设模型解析依赖池配置——会话级覆盖补齐
    // 预设无记忆语义：给该会话桶写记忆 → __standard__（settings.memory.enabled=false）
    // 的 system prompt 不含 <memory> 块（软停用生效的真链路锁定）
    tree.ctx.memory.set(blank.id, '用户偏好：简短回复');
    await singlesStore.refresh();
    singlesStore.selectSingle(blank.id);
    expect(blank.agentId).toBe('');
    const inputBefore = seenInputs.length;
    chat.sendMessage('默认预设路由');
    deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!chat.contextBusy) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 300));
    // 回复落在 single 分区（消息身份 = __standard__）
    const blankMsgs = chat.messages;
    expect(blankMsgs.some(m => m.agent_id === 'user' && m.content === '默认预设路由')).toBe(true);
    expect(blankMsgs.some(m => m.agent_id === '__standard__' && String(m.content).trim() !== '')).toBe(true);
    // 无记忆：__standard__ 的 run 未注入 <memory> 块（记忆已写入该会话桶）
    const stdInput = seenInputs.slice(inputBefore)[0] as { messages?: Array<{ content?: string }> } | undefined;
    expect(stdInput?.messages?.[0]?.content ?? '').not.toContain('<memory>');
    singlesStore.deselectSingle();
  });

  it('P5/P3/P4：system-prompt 真链路 + 思维链/事件持久化 + 名册摘要合成', { timeout: 60_000 }, async () => {
    // ---- P5：agents/system-prompt 干跑过真组装器链（framework/对话信息块实装） ----
    // （此前缺陷：干跑回读本地旧 request 对象而非载体——组装器"替换
    // call.request"的变异姿势使其恒空；回归锚见 ac-agent-admin tests）
    const sp = await wireRpc.call<{ systemPrompt?: string }>('agents/system-prompt', { agentId: 'helper' });
    // M18：框架块不再用标签包裹（<persona> 标签归 ac-persona 专用）——
    // 以框架首句 + 对话信息块为锚
    expect(sp.systemPrompt ?? '').toContain('你是 AgentChat');
    expect(sp.systemPrompt ?? '').toContain('## 对话信息');

    // ---- P3①：思维链持久化——agent 回复行落账带 reasoning_content（直答对桶；
    //      M21/D13 中性格式：role:'agent' + agent_id） ----
    const hist = await wireRpc.call<{ records?: Array<{ role: string; content: string; reasoning_content?: string; source?: string }> }>('session/history', { conversationId: 'helper~user' });
    const asstRow = (hist.records ?? []).find((r) => r.role === 'agent' && r.content === '工具结果已处理');
    expect(asstRow).toBeDefined();
    expect(asstRow!.reasoning_content ?? '').toContain('先想想');

    // ---- P3②：event 触发消息落 role:'event' + source（UI 渲染事件分隔符）。
    //      M19/D2：机制触发 = 目标自身 + 自会话桶 helper~helper ----
    await tree.ctx.router.send('helper', '定时器触发：汇报一下进展', {
      sender: 'helper',
      source: 'event',
      conversationId: 'helper~helper',
    });
    const hist2 = await wireRpc.call<{ records?: Array<{ role: string; content: string; reasoning_content?: string; source?: string }> }>('session/history', { conversationId: 'helper~helper' });
    const eventRow = (hist2.records ?? []).find((r) => r.role === 'event');
    expect(eventRow).toBeDefined();
    expect(eventRow!.content).toContain('定时器触发');
    expect(eventRow!.source).toBe('event');

    // ---- P4：名册 lastActivity/lastMessage（runs/snapshot 尾部摘要聚合；
    //      M19：viewer 对桶 helper~user 映射到 helper 名册项） ----
    const { fetchAgents } = await import('../src/api/roster.ts');
    const roster = await fetchAgents();
    const helper = roster.agents.find((a) => a.id === 'helper');
    expect(helper).toBeDefined();
    expect(helper!.lastActivity ?? 0).toBeGreaterThan(0);
    expect(helper!.lastMessage?.content ?? '').toContain('工具结果已处理');

    // ---- P3③：UI 侧透传——event 行 → 事件分隔符；assistant 行带 thinking ----
    const { toHistoryMessages } = await import('../src/api/runs.ts');
    const rows = toHistoryMessages([...(hist.records ?? []), ...(hist2.records ?? [])] as never, 'helper~user');
    expect(rows.some((r) => r.role === 'event' && String(r.content).includes('定时器触发'))).toBe(true);
    expect(rows.some((r) => r.role === 'agent' && String((r as { reasoning_content?: string }).reasoning_content ?? '').includes('先想想'))).toBe(true);
    // M18 #6：steps 持久化 → 历史重建 assistant 步气泡（tool_calls——
    // src 持久化键形，historyMsgToChatMessage 消费）+ tool 气泡
    expect(rows.some((r) => r.role === 'agent' && Array.isArray((r as { tool_calls?: unknown[] }).tool_calls) && (r as { tool_calls: Array<{ name: string }> }).tool_calls.some((tc) => tc.name === 'hello'))).toBe(true);
    expect(rows.some((r) => r.role === 'tool' && (r as { toolName?: string }).toolName === 'hello')).toBe(true);
  });

  it('模型管理 api_key 侧信道：config/set 提取进凭据库 → LLM 调用注入 → 掩码回显', { timeout: 60_000 }, async () => {
    const before = seenInputs.length;
    // ① UI 模型管理写口：池条目带 api_key（真实值）
    const set = await wireRpc.call<{ set?: boolean }>('config/set', {
      key: 'llmProviders',
      value: { 'mock-1': { api_key: 'sk-pool-e2e', provider: 'scripted' } },
    });
    expect(set.set).toBe(true);

    // ② config/get 回填掩码（已设置指示）；盘上不落 key
    const cfg = await wireRpc.call<{ config: { llmProviders: Record<string, { api_key?: string }> } }>('config/get');
    expect(cfg.config.llmProviders['mock-1'].api_key).toBe('••••••••');
    const { readFile } = await import('node:fs/promises');
    const onDisk = JSON.parse(await readFile(join(dataRoot, 'config.json'), 'utf-8')) as {
      llmProviders: Record<string, Record<string, unknown>>;
    };
    expect(onDisk.llmProviders['mock-1'].api_key).toBeUndefined();

    // ③ 真链路：router.send → loop → llm.chat → before-chat 注入 → provider 收到
    await tree.ctx.router.send('helper', '验证 key 注入', {});
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && seenInputs.length <= before) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(seenInputs.length).toBeGreaterThan(before);
    for (const input of seenInputs.slice(before)) {
      expect(input.api_key).toBe('sk-pool-e2e'); // 池 key（pool:mock-1）注入每次调用
    }

    // ④ 空串 = 删除凭据：后续调用不再注入（回落行构造/env 缺省 = 无）
    await wireRpc.call('config/set', {
      key: 'llmProviders',
      value: { 'mock-1': { api_key: '', provider: 'scripted' } },
    });
    const before2 = seenInputs.length;
    await tree.ctx.router.send('helper', '再验证一次', {});
    const deadline2 = Date.now() + 15_000;
    while (Date.now() < deadline2 && seenInputs.length <= before2) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(seenInputs.length).toBeGreaterThan(before2);
    for (const input of seenInputs.slice(before2)) {
      expect(input.api_key).toBeUndefined(); // 凭据已删 → 不注入
    }
  });

  it('M22 P2 全链路：扩展目录 × 全行集 / dev 扫描根 / 装配 per-name 合并（真 bootTree RPC）', { timeout: 60_000 }, async () => {
    const settings = await import('../src/settings/api.ts');

    // ---- ① 扩展目录：bootTree 行集与 yml 一致 → 12 条全可见（D4①；
    // M25 P2 增 plugin-gates 声明条目）----
    const cat = await settings.getCatalog();
    expect(cat.extensions.map((e) => e.name).sort()).toEqual([
      'archive', 'datetime', 'mcp', 'memory', 'persona', 'plugin-gates', 'security', 'session', 'skill', 'system-prompt', 'usage', 'web-tools',
    ]);
    // 落点修正两处：security 双落点（门禁+脱敏）；web-tools 工具行（能力供给）
    expect(cat.extensions.find((e) => e.name === 'security')?.targets).toEqual(['tool/before-execute', 'tool/transform-result']);
    expect(cat.extensions.find((e) => e.name === 'web-tools')).toMatchObject({ automatic: true, targets: [] });
    // per-Agent 参数面字段由目录声明（M24 P4：enabled 进 fields + configNs 赋值；
    // 2026-08-30 起 fields 演进为字段级描述形态——名字序仍锁定）
    const personaFields = cat.extensions.find((e) => e.name === 'persona')?.fields ?? [];
    expect(personaFields.map((f: string | { name: string }) => (typeof f === 'string' ? f : f.name))).toEqual(['text', 'file', 'enabled']);
    expect(personaFields.every((f: string | { description?: string }) => typeof f === 'string' || typeof f.description === 'string')).toBe(true);
    expect(cat.extensions.find((e) => e.name === 'persona')?.configNs).toBe('persona');
    expect(cat.extensions.find((e) => e.name === 'web-tools')?.configNs).toBe('web-tools');
    // 装配行原始清单与装载状态透传
    expect(cat.rows.length).toBeGreaterThan(10);
    expect(cat.loaded).toEqual([]);
    expect(cat.failed).toEqual([]);

    // ---- ② dev 扫描：空数据根 → 空清单 + 数据根透出（D7）----
    const lib = await settings.getLibrary();
    expect(lib.dev).toEqual([]);
    expect(lib.root).toBeTruthy();

    // ---- ③ 装配写口：per-name 浅合并 / null 删除（D5，服务端语义）----
    await settings.createAgent({ id: 'm22-asm', name: '装配验证', provider: 'scripted', llm: { model: 'mock-1' } });
    const a1 = await settings.getAssembly('m22-asm');
    expect(a1.assembly.settings.configs).toEqual({});
    await settings.saveAssembly('m22-asm', { settings: { persona: { enabled: false, text: '冷静' } } });
    const a2 = await settings.getAssembly('m22-asm');
    expect(a2.assembly.settings.configs).toEqual({ persona: { enabled: false, text: '冷静' } });
    // 浅合并：enabled 翻转、text 保留；新 name 并存
    await settings.saveAssembly('m22-asm', { settings: { persona: { enabled: true }, memory: { maxTokens: 900 } } });
    const a3 = await settings.getAssembly('m22-asm');
    expect(a3.assembly.settings.configs).toEqual({ persona: { enabled: true, text: '冷静' }, memory: { maxTokens: 900 } });
    // null = 删除该 name
    await settings.saveAssembly('m22-asm', { settings: { memory: null } });
    const a4 = await settings.getAssembly('m22-asm');
    expect(a4.assembly.settings.configs).toEqual({ persona: { enabled: true, text: '冷静' } });
    // 工具意图不变语义回归（include/exclude）
    await settings.saveAssembly('m22-asm', { tools: { include: ['hello'] } });
    const a5 = await settings.getAssembly('m22-asm');
    expect(a5.assembly.tools.include).toEqual(['hello']);
    expect(a5.assembly.tools.enabled).toEqual(['hello']);
    await settings.deleteAgent('m22-asm');
  });
});

// ============================================================
// 宿主 boot 测试（8.8 前置第一批 cr-537；cr-542 单树装配 + ACTIVE 终检）
//
// 覆盖：偏好派生 → 单树 cordis 装配 → web 表面 → 装配终检；webServer
// 消费者的活性（ws-bridge/remote-link/agent-admin——双 ctx 形态下恒 PENDING
// 的静默面，cr-542 根因修复的回归锁）；agent-admin 写侧 RPC 面。
// 数据根恒 preview/sandbox 独立目录（红线）。
// ============================================================
import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { FiberStates } from '@agentchat/cordis';
import { bootHost } from '../boot.ts';
import type { HostBootResult } from '../boot.ts';

const HERE = path.resolve(__dirname, '../../..');
const CATALOG = path.join(HERE, 'apps/catalog/row-catalog.json');
const SANDBOX = path.join(HERE, 'sandbox');

let host: HostBootResult | null = null;
afterAll(async () => {
  if (host !== null) await host.close();
  host = null;
  fs.rmSync(ROOT, { recursive: true, force: true });
});
const ROOT = path.join(SANDBOX, 'host-boot-test');

/** 宿主 agents 编辑面最小面（装配断言用——服务类型住 ac-host-rows） */
interface HostAgentsFace {
  templates(): Array<{ id: string }>;
  saveAgent(config: { id: string; model?: string }): void;
  agentIds(): string[];
}

/** 宿主 web 面 RPC 观测面（web-server 主线行面） */
interface WebRpcFace {
  rpcMethods(): string[];
  callRpc(method: string, params?: unknown): Promise<unknown>;
}

describe('宿主 boot（单树装配面）', () => {
  it('偏好缺省全装：全部宿主行就位对账（48 - 25 ui 域行 = 23，cr-576 后无未就位行）', async () => {
    // 48 = 23 cordis + 25 ui（manifest）。23 中：web 表面 4 行（web-server/
    // webui/web-api + post-office 编排件）+ guardian / preset-builtin 为编排
    // 与数据面；cordis 直装面 = 导入行 + options 工厂行（usage/timers/agents/
    // plugin-registry/auth-registry/group）+ agent-admin（写侧 RPC 编排）。
    // archive 已改树入壳（cr-546，D11）——宿主数据服务组无 archive 行，
    // cr-565 conv-settings 改树入宿主、cr-576 group 全新增（48 全就位）。
    const dataRoot = ROOT;
    host = await bootHost({
      dataRoot,
      catalogFile: CATALOG,
    });
    const expected = ['agent-admin', 'agents', 'auth-registry', 'backup', 'config', 'conv-settings', 'event-policy', 'group', 'guardian',
      'logger-console', 'post-office', 'plugin-market', 'plugin-registry', 'preset-builtin',
      'remote-link', 'singles', 'timer', 'timers', 'usage',
      'ws-bridge', 'web-server', 'webui', 'web-api',
    ];
    // 派生集含 ui 域行（25——manifest 声明面）；cordis 直装 + 承担面 = 非 ui 全集
    expect(host.rowIds.filter((id) => !id.startsWith('ui-')).sort()).toEqual(expected.sort());
    // ui 域行全量在场（manifest 声明面分流计数）
    expect(host.rowIds.filter((id) => id.startsWith('ui-')).length).toBe(25);
    expect(host.web.port).toBeGreaterThan(0);

    // 装配终检（cr-542）：全部 fiber ACTIVE——无静默半激活面
    for (const fiber of host.fibers) expect(fiber.state).toBe(FiberStates.ACTIVE);
    // 回归锁：webServer 消费者在单树形态下必须真激活（双 ctx 形态恒 PENDING）
    const names = host.fibers.map((fiber) => fiber.name);
    for (const name of ['ac-ws-bridge', 'ac-remote-link', 'ac-host-rows/agent-admin']) {
      expect(names).toContain(name);
    }

    // 身份编辑面行真在册（cr-540）：写口活 + 模板面经 preset-builtin 行注入
    const agents = (host.ctx as unknown as { agents: HostAgentsFace }).agents;
    expect(agents.templates().map((t) => t.id)).toEqual(['standard', 'dsh-minimal', 'creator', 'abap-dev']);
    agents.saveAgent({ id: 'wired', model: 'mock' });
    expect(fs.existsSync(path.join(dataRoot, 'agents', 'wired', 'config.json'))).toBe(true);
    expect(agents.agentIds()).toContain('wired');

    // agent-admin 写侧 RPC 面（cr-542）：六方法在册 + 全链真跑（写口单源落盘）
    const web = (host.ctx as unknown as { webServer: WebRpcFace }).webServer;
    const methods = web.rpcMethods();
    for (const method of ['agents/get-config', 'agents/create', 'agents/update-config',
      'agents/delete', 'agents/save-doc', 'agents/read-doc']) {
      expect(methods).toContain(method);
    }
    const created = await web.callRpc('agents/create', { config: { name: 'Write Face', model: 'mock@deepseek-chat' } }) as {
      config: { id: string; model: string; provider?: string };
    };
    expect(created.config.id).toBe('write-face');
    expect(created.config).toMatchObject({ model: 'deepseek-chat', provider: 'mock' });
    const updated = await web.callRpc('agents/update-config', { agentId: 'write-face', patch: { description: '改过' } }) as {
      changed: string[];
    };
    expect(updated.changed).toEqual(['description']);
    await web.callRpc('agents/save-doc', { agentId: 'write-face', name: 'AGENT.md', content: '# 身份' });
    const doc = await web.callRpc('agents/read-doc', { agentId: 'write-face', name: 'AGENT.md' }) as { content: string };
    expect(doc.content.trim()).toBe('# 身份');
    const removed = await web.callRpc('agents/delete', { agentId: 'write-face' }) as { removed: boolean };
    expect(removed.removed).toBe(true);
    expect(fs.existsSync(path.join(dataRoot, 'agents', 'write-face'))).toBe(false);

    // 群存储行（cr-576）：成员表 CRUD + 成员流预登记 + 读面（send 扇出归 e2e）
    for (const method of ['group/list', 'group/create', 'group/delete', 'group/join', 'group/leave',
      'group/rename', 'group/set-description', 'group/send', 'group/history']) {
      expect(methods).toContain(method);
    }
    const grp = await web.callRpc('group/create', { name: '测试群', members: ['wired'] }) as { group: { id: string; members: string[] } };
    expect(grp.group.members).toEqual(['wired']);
    // 成员流 uuid 预登记（多发送方子集一致校验的输入面）：user 与成员来信均放行
    expect(host.po.registry.lookup(grp.group.id + '~wired')?.participants.sort()).toEqual(['user', 'wired']);
    const joined = await web.callRpc('group/join', { groupId: grp.group.id, agentId: 'wired' }) as { joined: boolean };
    expect(joined.joined).toBe(true); // 幂等
    const hist = await web.callRpc('group/history', { groupId: grp.group.id }) as { messages: unknown[] };
    expect(hist.messages).toEqual([]);
    const deleted = await web.callRpc('group/delete', { groupId: grp.group.id }) as { deleted: boolean };
    expect(deleted.deleted).toBe(true);

    // 插件治理面（cr-543）：装载裁决 + 熔断 + 行偏好急救 + 市场行（沿用
    // 导入，inject ['webServer','pluginRegistry']——两服务同树才激活）
    for (const method of ['plugin/installed', 'plugin/stage', 'plugin/approve', 'plugin/reject',
      'plugin/uninstall', 'plugin/rows', 'plugin/load-health', 'plugin/load-failure',
      'rows/list', 'rows/set', 'rows/reset', 'market/search', 'market/stage']) {
      expect(methods).toContain(method);
    }
    const setRows = await web.callRpc('rows/set', { id: 'backup', disabled: true }) as {
      state: string; restartRequired: boolean; rows: Array<{ id: string; disabled: boolean }>;
    };
    expect(setRows.state).toBe('written');
    // 恒冷生效（〈patch 机制退役〉——偏好文件写即生效于下次 boot）
    expect(setRows.restartRequired).toBe(true);
    expect(setRows.rows.find((row) => row.id === 'backup')?.disabled).toBe(true);
    expect(fs.existsSync(path.join(dataRoot, 'host-rows.json'))).toBe(true);
    await web.callRpc('rows/reset');
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'host-rows.json'), 'utf-8'))).toEqual([]);

    // 全局配置写面（cr-564）：单树里 web-api 经 ctx.get('config') 拿到 config 行
    // 服务（配置落盘单源），池 api_key 走 credentials/ 侧信道
    for (const method of ['config/get', 'config/set', 'config/delete', 'config/save', 'llm/pool-credential']) {
      expect(methods).toContain(method);
    }
    await web.callRpc('config/set', { key: 'llmProviders', value: { probe: { api_key: 'sk-boot-probe' } } });
    const cfg = await web.callRpc('config/get') as { config: { llmProviders?: Record<string, { api_key?: string }> } };
    const pools = cfg.config.llmProviders ?? {};
    expect(Object.keys(pools)).toEqual(['probe']);
    expect(pools['probe'].api_key).toBe('••••••••');
    expect(fs.readFileSync(path.join(dataRoot, 'config.json'), 'utf-8')).not.toContain('sk-boot-probe');
    expect(fs.readdirSync(path.join(dataRoot, 'credentials'))).toContain('__GLOBAL___POOL%3APROBE_API_KEY.enc');
    await web.callRpc('config/delete', { key: 'llmProviders' });
    // 宿主直读面（cr-567）：timer / 预设 / 标签 / 技能 / 快照 / 用量 / 版本 / 事件治理
    const saved = await web.callRpc('timer/save', {
      agentId: 'wired', entries: [{ id: 't1', mode: 'time', time: '09:00', hint: '晨报' }],
    }) as { saved: boolean; owner: string };
    expect(saved).toMatchObject({ saved: true, owner: 'wired' });
    const entries = await web.callRpc('timer/entries', { agentId: 'wired' }) as { owner: string; entries: Array<{ id: string }> };
    expect(entries.owner).toBe('wired');
    expect(entries.entries.map((e) => e.id)).toEqual(['t1']);
    await expect(web.callRpc('timer/save', { agentId: 'wired', entries: [{ id: 'x', mode: 'nope', hint: '' }] })).rejects.toThrow(/mode/);
    const presets = await web.callRpc('agents/presets') as { presets: Array<{ id: string }> };
    // id = 预设 Agent 身份（物化时用的 __name__ 形式——独立会话可选用）
    expect(presets.presets.map((t) => t.id).sort()).toEqual(['__abap_dev__', '__creator__', '__dsh_minimal__', '__standard__']);
    // 标签轴已退役（cr-484）→ 目录空集是终态
    expect((await web.callRpc('tags/catalog') as { tags: unknown[] }).tags).toEqual([]);
    // 技能目录 = 数据根 <root>/skills 直读（frontmatter name/description）
    fs.mkdirSync(path.join(dataRoot, 'skills', 'demo-skill'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo\ndescription: 演示技能\n---\n正文', 'utf-8');
    const skills = await web.callRpc('skills/list', { agentId: 'wired' }) as { skills: { global: Array<{ name: string; description: string }> } };
    expect(skills.skills.global.map((s) => [s.name, s.description])).toEqual([['demo', '演示技能']]);
    // 文件快照：空清单 + 磁盘终版读取
    expect((await web.callRpc('fileSnapshots/list', { conversationId: 'c1' }) as { snapshots: unknown[] }).snapshots).toEqual([]);
    const noteFile = path.join(dataRoot, 'note.txt');
    fs.writeFileSync(noteFile, '你好', 'utf-8');
    const current = await web.callRpc('fileSnapshots/read-current', { paths: [noteFile] }) as { contents: Record<string, string | null> };
    expect(current.contents[noteFile]).toBe('你好');
    // 用量汇总：主线同形九维
    const usage = await web.callRpc('usage/tokens') as Record<string, unknown>;
    for (const key of ['byAgent', 'byModel', 'byDay', 'byDayModel', 'byDayPair', 'byConversation', 'byPair', 'bySelfSession', 'totals']) {
      expect(usage).toHaveProperty(key);
    }
    // 版本面：仓库 package.json + 无自更新通道的显式上报
    const version = await web.callRpc('system/version') as { current: string };
    expect(version.current).toMatch(/^\d+\.\d+\.\d+/);
    expect((await web.callRpc('system/version-check') as { checkFailed?: boolean }).checkFailed).toBe(true);
    expect(typeof (await web.callRpc('system/version-changelog') as { content: string }).content).toBe('string');
    await expect(web.callRpc('system/version-update')).rejects.toThrow(/自更新/);
    // 事件治理写口（config events.disabled——host 单树有 eventPolicy 行）
    const policy = await web.callRpc('events/policy-set', { key: 'logger-console::config/changed', disabled: true }) as { set: boolean; disabledList: string[] };
    expect(policy.set).toBe(true);
    expect(policy.disabledList).toContain('logger-console::config/changed');
    // 事件目录面：本批显式空态（目录数据化另批）
    expect((await web.callRpc('events/listeners') as { events: unknown[] }).events).toEqual([]);
    const after = JSON.parse(fs.readFileSync(path.join(dataRoot, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(after.llmProviders).toBeUndefined();
    // 工作区域（cr-568）：本机目录浏览（原生选择/系统打开只在真机手动验证——
    // 测试面不触发窗口副作用，只验错误分支与参数闸）
    const roots = await web.callRpc('workspace/browse-dirs', {}) as { roots?: Array<{ path: string }>; dirs: unknown[] };
    expect(Array.isArray(roots.roots)).toBe(true);
    expect(roots.roots!.length).toBeGreaterThan(0);
    expect(roots.dirs).toEqual([]);
    const listed = await web.callRpc('workspace/browse-dirs', { path: dataRoot }) as { dirs: Array<{ name: string }> };
    expect(listed.dirs.map((d) => d.name)).toContain('agents');
    expect((await web.callRpc('workspace/browse-dirs', { path: 'relative/path' }) as { error?: string }).error).toMatch(/绝对路径/);
    expect((await web.callRpc('workspace/open-local', { path: 'no-such-file.txt' }) as { error?: string }).error).toMatch(/不存在/);
    // open-dir（cr-676 与主线 resolveOpenDir 对齐）：workspaceId 未登记 = error；
    // 未知 agentId 走 treeBase 语义落数据根（会真开资源管理器，测试面不触达）
    expect((await web.callRpc('workspace/open-dir', { workspaceId: 'ws-ghost' }) as { error?: string }).error)
      .toMatch(/工作区不存在/);
    // 插件目录面（cr-568）：builtin = 行集目录（宿主行 assembled），local/pending 空
    const catalog = await web.callRpc('plugin/catalog') as {
      builtin: Array<{ name: string; assembled: boolean; entryId: string }>; local: unknown[]; pending: unknown[]; note?: string;
    };
    expect(catalog.builtin.length).toBeGreaterThan(40);
    expect(catalog.builtin.find((r) => r.name === 'web-api')?.assembled).toBe(true);
    expect(catalog.builtin.find((r) => r.name === 'conversation')?.assembled).toBe(false); // 壳行
    expect(catalog.local).toEqual([]);
    expect(catalog.pending).toEqual([]);
    expect(catalog.note).toMatch(/行集条目/);
    // 装载/热更语义在 preview 不存在 → 可读原因 fail-loud（不空转）
    await expect(web.callRpc('plugin/load', { dir: '/' })).rejects.toThrow(/不装载第三方代码/);
    await expect(web.callRpc('plugin/unload', { name: 'x' })).rejects.toThrow(/不驻留第三方代码/);
    await expect(web.callRpc('plugin/patch-set', { key: 'k', value: 1 })).rejects.toThrow(/退役/);
    // 模型连接面：按 config llmProviders 投影（模型清单 + 能力元数据）
    fs.writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({
      llmProviders: { demo: { base_url: 'https://demo.example/', models: ['m1', { model: 'm2', vision: true }] } },
    }), 'utf-8');
    const llm = await web.callRpc('llm/providers') as {
      providers: string[]; stats: Array<{ name: string; models: string[]; instantiated: boolean; baseUrl?: string; modelMeta?: Record<string, { vision?: boolean }> }>;
    };
    expect(llm.providers).toEqual(['demo']);
    expect(llm.stats[0].models).toEqual(['m1', 'm2']);
    expect(llm.stats[0].baseUrl).toBe('https://demo.example/');
    expect(llm.stats[0].modelMeta?.m2.vision).toBe(true);
    expect(llm.stats[0].instantiated).toBe(false); // 宿主进程无 provider 实例（池在壳内）
  });

  it('偏好裁剪：disable 一行 = 派生集少一行（缺行 fail-loud 已无目标行——全就位）', async () => {
    const dataRoot = path.join(SANDBOX, 'host-boot-missing-test');
    fs.rmSync(dataRoot, { recursive: true, force: true });
    const h = await bootHost({ dataRoot, catalogFile: CATALOG, preferences: [{ id: 'backup', disabled: true }] });
    expect(h.rowIds).not.toContain('backup');
    expect(h.rowIds.filter((id) => !id.startsWith('ui-')).length).toBe(22);
    await h.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it('装配终检 fail-loud：依赖行被显式排除 → 未激活', async () => {
    // agent-admin inject ['webServer','agents']：摘 agents 行 = 本行 PENDING
    //（双 ctx 形态下这条洞是静默的——终检即断根点）
    const dataRoot = path.join(SANDBOX, 'host-boot-pending-test');
    fs.rmSync(dataRoot, { recursive: true, force: true });
    await expect(bootHost({
      dataRoot,
      catalogFile: CATALOG,
      preferences: [{ id: 'agents', disabled: true }],
    })).rejects.toThrow(/未激活/);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
});

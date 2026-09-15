// ============================================================
// ac-sap-adt：demo（进程内 mock ADT）端到端 + 门禁标签断言
//
// 引擎行为（策略/OCC/$batch/调试器…）由源仓库的 290 项测试锁定，
// 这里只验证**宿主适配**：注册形状、ToolResult 归一、exec 垫片
// （工作区锚点）、fs 缝（快照落盘）、凭据缝、软停用。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as configRow from 'ac-config';
import * as agentsRow from 'ac-agents';
import * as sapAdtRow from '../src/index.ts';
import { SapAdtFs } from '../src/engine.ts';

type ExecRes = { ok: boolean; output: any; error?: string };

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function exec(
  ctx: Context,
  name: string,
  args: Record<string, unknown> = {},
  agentId?: string,
): Promise<ExecRes> {
  return (await ctx.tools.execute({ name, args, ...(agentId ? { agentId } : {}) } as never)) as ExecRes;
}

async function boot(options: Record<string, unknown> = {}, dataRoot?: string, withServices = false) {
  if (dataRoot) process.env.AGENTCHAT_DATA_ROOT = dataRoot;
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: Array<[unknown, unknown]> = withServices
    ? [
        [configRow, undefined],
        [agentsRow, undefined],
        [toolsRow, undefined],
        [sapAdtRow, { demo: true, demoPort: 0, ...options }],
      ]
    : [
        [toolsRow, undefined],
        [sapAdtRow, { demo: true, demoPort: 0, ...options }],
      ];
  for (const [plugin, config] of rows as Array<[unknown, unknown]>) {
    const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(() => {
  delete process.env.AGENTCHAT_DATA_ROOT;
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) void fiber.dispose();
    }
  }
});

describe('ac-sap-adt 行装配', () => {
  it('注册全部 adt_* 工具并携带 sap-adt 能力标签（AND 门禁词汇）', async () => {
    const { ctx } = await boot();
    expect(ctx.tools.has('adt_search')).toBe(true);
    expect(ctx.tools.has('adt_object_read')).toBe(true);
    expect(ctx.tools.has('adt_object_write')).toBe(true);
    const def = (ctx as any).tools.get('adt_search');
    expect(def?.requiredTags).toEqual(['sap-adt']);
    // 参数 schema 是标准 JSON Schema（引擎 defineTool 已转换）
    expect(def?.parameters?.type).toBe('object');
    expect(def?.parameters?.required).toContain('query');
    // 工具目录规模（引擎 0.10 实测 32：28 专用 + 4 fs_ops 门面——0.8 起
    // CRUD 时代 A 组 9 名退位为内部路由引擎；0.9 起整合批次再收敛：
    // 调试器五件套→adt_debug、ATC/dumps/transports 的 list+get 对→
    // 单工具、textelements→adt_object_read {part}；与 ac-plugin-core
    // reserved.ts 占名名单精确一致——reserved-consistency 锁定）
    const adtNames = (ctx as any).tools.list().filter((d: { name: string }) => d.name.startsWith('adt_'));
    expect(adtNames.length).toBeGreaterThanOrEqual(32);
  });

  it('enabled: false 软停用 —— 不注册任何工具', async () => {
    const { ctx } = await boot({ enabled: false });
    expect(ctx.tools.has('adt_search')).toBe(false);
  });
});

describe('ac-sap-adt 启停分层（settings[\'sap-adt\'].enabled，settingsOf 合成，热生效）', () => {
  it('全局默认层 enabled:false → adt_* 执行被 veto（含宿主直调），改回即热恢复', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sap-adt-settings-'));
    const { ctx } = await boot({}, root, true);
    // 基线：可用
    expect((await exec(ctx, 'adt_list_destinations')).ok).toBe(true);
    // 全局默认层停用（插件库弹窗写的键）→ 宿主直调（无身份）veto
    ctx.config.set('settings.sap-adt', { enabled: false });
    const denied = await exec(ctx, 'adt_list_destinations');
    expect(denied.ok).toBe(false);
    expect(String(denied.error)).toContain('停用');
    // 非 adt 工具不受影响
    ctx.tools.register({ name: 'probe_x', async execute() { return { ok: true, output: 'x' }; } });
    expect((await exec(ctx, 'probe_x')).ok).toBe(true);
    // 改回 true → 立即恢复（config/changed 热生效，无需重载行）
    ctx.config.set('settings.sap-adt', { enabled: true });
    expect((await exec(ctx, 'adt_list_destinations')).ok).toBe(true);
  });

  it('Agent 差异层 enabled:true 覆盖全局 false；无差异层 Agent 沿用全局', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sap-adt-settings-'));
    const { ctx } = await boot({}, root, true);
    ctx.agents.register({ id: 'abap_dev', settings: { 'sap-adt': { enabled: true } } } as never);
    ctx.config.set('settings.sap-adt', { enabled: false });
    // 差异层覆盖：abap_dev 可用
    const dev = await exec(ctx, 'adt_list_destinations', {}, 'abap_dev');
    expect(dev.ok).toBe(true);
    // 无差异层 Agent：合成后仍停用
    const other = await exec(ctx, 'adt_list_destinations', {}, 'someone_else');
    expect(other.ok).toBe(false);
    expect(String(other.error)).toContain('停用');
  });
});

describe('ac-sap-adt demo 端到端（进程内 mock ADT）', () => {
  it('adt_list_destinations → {ok, output} 归一，含 demo 目的地', async () => {
    const { ctx } = await boot();
    const res = await exec(ctx, 'adt_list_destinations');
    expect(res.ok).toBe(true);
    const names = (res.output.destinations as Array<{ name: string }>).map((d) => d.name);
    expect(names).toContain('demo');
  });

  it('adt_search → adt_object_read 闭环；快照经 fs 缝落盘到 <root>/sap-adt/', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sap-adt-'));
    const { ctx } = await boot({}, root);
    const search = await exec(ctx, 'adt_search', { query: 'ZCL_DEMO' });
    expect(search.ok).toBe(true);
    expect(search.output.objects.length).toBeGreaterThan(0);
    expect(search.output.objects[0].objectName).toBe('ZCL_DEMO');

    const read = await exec(ctx, 'adt_object_read', { name: 'ZCL_DEMO', type: 'CLAS' });
    expect(read.ok).toBe(true);
    expect(String(read.output.source).toLowerCase()).toContain('class');
    expect(read.output.localCopy).toBeTruthy();
    const snap = join(root, 'sap-adt', String(read.output.localCopy));
    expect(existsSync(snap)).toBe(true);
    expect(readFileSync(snap, 'utf8')).toBe(read.output.source);
  });

  it('引擎策略拒绝路径透传为 {ok:false, error 含 [POLICY]}（调试器默认关）', async () => {
    const { ctx } = await boot();
    const res = await exec(ctx, 'adt_debug', { action: 'listen' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('[POLICY]');
  });

  it('参数校验（引擎 defineTool）拒绝非法枚举并给出可读违规', async () => {
    const { ctx } = await boot();
    const res = await exec(ctx, 'adt_object_delete', { type: 'NOPE', name: 'X' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("unknown object type 'NOPE'");
  });

  it('adt_object_read 无 name 调用返回能力矩阵卡（门面路由装配完好）', async () => {
    const { ctx } = await boot();
    const res = await exec(ctx, 'adt_object_read');
    expect(res.ok).toBe(true);
    const text = JSON.stringify(res.output);
    expect(text).toContain('write');
    expect(text.toLowerCase()).toContain('matrix');
  });
});

describe('ac-sap-adt 宿主档案（host seam，core ≥ 0.7.1）', () => {
  it('destinations 落盘 <数据根>/.ac-sap-adt/，工具描述不再出现 DSH 词汇', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sap-adt-host-'));
    const { ctx } = await boot({}, root);
    const res = await exec(ctx, 'adt_create_destination', {
      name: 'dev',
      url: 'https://sap.example.com:44301',
      username: 'DEVUSER',
    });
    expect(res.ok).toBe(true);
    // 存储权威 = 注册表档案：文件直接挂数据根下的 .ac-sap-adt/
    const file = join(root, '.ac-sap-adt', 'destinations.yaml');
    expect(res.output.file).toBe(file);
    expect(existsSync(file)).toBe(true);
    // 描述/注释语境 = AgentChat（'.' 锚点模式：无路径段、无 .dsh-abap-adt）
    const def = (ctx as any).tools.get('adt_create_destination');
    expect(String(def.description)).toContain('destinations.yaml (in the session workspace anchor)');
    expect(String(def.description)).not.toContain('.dsh-abap-adt');
    expect(String(def.description)).not.toContain('./destinations.yaml');
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('.dsh');
    expect(raw).toContain('`sap-adt:`');
    // hint 引导到本宿主凭证存储（ac-credentials 未挂时仍是宿主词汇）
    expect(String(res.output.hint)).toContain('AgentChat encrypted credential store');
    // 快照/导出子树不受锚点影响：仍落 <数据根>/sap-adt/
    const read = await exec(ctx, 'adt_object_read', { name: 'ZCL_DEMO', type: 'CLAS' });
    expect(read.ok).toBe(true);
    expect(existsSync(join(root, 'sap-adt', String(read.output.localCopy)))).toBe(true);
  });

  it('Agent 隔离：per-Agent destinations 文件，同名互不可见；宿主直调用默认路径', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sap-adt-iso-'));
    const { ctx } = await boot({}, root);
    // 两个 Agent 各建同名目的地 dev，URL 不同
    const a1 = await exec(ctx, 'adt_create_destination', { name: 'dev', url: 'https://a1.example.com' }, 'abap_dev');
    const a2 = await exec(ctx, 'adt_create_destination', { name: 'dev', url: 'https://a2.example.com' }, 'abap_qa');
    expect(a1.ok).toBe(true);
    expect(a2.ok).toBe(true);
    // 各自落自己的作用域文件（无嵌套常量目录）
    const f1 = join(root, '.ac-sap-adt', 'agents', 'abap_dev', 'destinations.yaml');
    const f2 = join(root, '.ac-sap-adt', 'agents', 'abap_qa', 'destinations.yaml');
    expect(a1.output.file).toBe(f1);
    expect(a2.output.file).toBe(f2);
    expect(readFileSync(f1, 'utf8')).toContain('a1.example.com');
    expect(readFileSync(f2, 'utf8')).toContain('a2.example.com');
    expect(readFileSync(f1, 'utf8')).not.toContain('a2.example.com');
    // 宿主直调（无身份）→ 默认文件，看不到 Agent 的
    const host = await exec(ctx, 'adt_create_destination', { name: 'host', url: 'https://host.example.com' });
    expect(host.ok).toBe(true);
    expect(host.output.file).toBe(join(root, '.ac-sap-adt', 'destinations.yaml'));
    const hostRaw = readFileSync(join(root, '.ac-sap-adt', 'destinations.yaml'), 'utf8');
    expect(hostRaw).toContain('host.example.com');
    expect(hostRaw).not.toContain('a1.example.com');
    // 含路径分隔符的 agentId 被 slug 化（防目录穿越）
    const weird = await exec(ctx, 'adt_create_destination', { name: 'w', url: 'https://w.example.com' }, 'a/b..c');
    expect(weird.ok).toBe(true);
    expect(weird.output.file).toBe(join(root, '.ac-sap-adt', 'agents', 'a_b..c', 'destinations.yaml'));
  });

  it('Agent × 会话工作区双维隔离：同一 Agent 挂两个工作区的 single 会话互不可见；旧布局存量迁移', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sap-adt-ws-'));
    const { ctx } = await boot({}, root);
    // 假 workspace 服务：conversationId → 会话挂载的工作区本机路径
    // （真实装配里由 ac-workspace conversationWorkspaceRoot 提供——唯一事实源）
    const wsIm = join(root, 'Project-120-IMPC');
    const wsDl = join(root, 'Local-20-Deloitte');
    const offWorkspace = ctx.provide('workspace', {
      root,
      conversationWorkspaceRoot(cid: string | undefined): string | null {
        if (cid === 'conv-impc') return wsIm;
        if (cid === 'conv-deloitte') return wsDl;
        return null;
      },
    });
    const inConv = (name: string, args: Record<string, unknown>, agentId: string, conversationId: string) =>
      ctx.tools.execute({ name, args, agentId, conversationId } as never) as Promise<ExecRes>;

    // 旧布局存量：修复前两个工作区的配置混在 agents/__abap_dev__/destinations.yaml
    const legacyFile = join(root, '.ac-sap-adt', 'agents', '__abap_dev__', 'destinations.yaml');
    mkdirSync(join(root, '.ac-sap-adt', 'agents', '__abap_dev__'), { recursive: true });
    writeFileSync(
      legacyFile,
      'destinations:\n  - name: impc-dev\n    url: https://impcerpdev01.example.com\n  - name: deloitte-kic\n    url: https://180.167.68.213:44304\n',
      'utf8',
    );

    // IMPC 工作区会话：首次调用触发存量迁移（复制旧文件到本工作区子目录）
    const im = await inConv('adt_create_destination', { name: 'impc-test', url: 'https://impc-test.example.com' }, '__abap_dev__', 'conv-impc');
    expect(im.ok).toBe(true);
    // wsSlug = 工作区完整本机路径的 slug 形态（盘符与分隔符归一，路径跨平台
    // 不定 → 从期望规则现算，而非硬编码）
    const slugOf = (p: string) => p.replace(/[:\\\/]+/g, '-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    const agentWsBase = join(root, '.ac-sap-adt', 'agents', '__abap_dev__', 'ws');
    const imDir = join(agentWsBase, slugOf(wsIm));
    expect(im.output.file).toBe(join(imDir, 'destinations.yaml'));
    // 迁移：旧存量（impc-dev + deloitte-kic）已复制进来，且新目的地落同一份
    const imRaw = readFileSync(join(imDir, 'destinations.yaml'), 'utf8');
    expect(imRaw).toContain('impc-dev');
    expect(imRaw).toContain('deloitte-kic');
    expect(imRaw).toContain('impc-test.example.com');

    // Deloitte 工作区会话：独立文件，先迁移存量再删掉 impc 的、留下自己的
    const dl = await inConv('adt_create_destination', { name: 'deloitte-kic2', url: 'https://kic2.example.com' }, '__abap_dev__', 'conv-deloitte');
    expect(dl.ok).toBe(true);
    const dlDir = join(agentWsBase, slugOf(wsDl));
    expect(dl.output.file).toBe(join(dlDir, 'destinations.yaml'));
    // 列表可见性按会话工作区分：IMPC 会话看不到 Deloitte 新建的目的地
    const imList = await inConv('adt_list_destinations', {}, '__abap_dev__', 'conv-impc');
    const imNames = (imList.output.destinations as Array<{ name: string }>).map((d) => d.name);
    expect(imNames).toContain('impc-dev');
    expect(imNames).toContain('impc-test');
    expect(imNames).not.toContain('deloitte-kic2');
    // Deloitte 会话反之
    const dlList = await inConv('adt_list_destinations', {}, '__abap_dev__', 'conv-deloitte');
    const dlNames = (dlList.output.destinations as Array<{ name: string }>).map((d) => d.name);
    expect(dlNames).toContain('deloitte-kic2');
    expect(dlNames).not.toContain('impc-test');

    // 无工作区归属（conversationId 未挂载/解析为 null）→ 维持 per-Agent 原路径
    const plain = await exec(ctx, 'adt_create_destination', { name: 'plain', url: 'https://plain.example.com' }, '__abap_dev__');
    expect(plain.output.file).toBe(legacyFile);
    // 且不再受工作区子目录影响（各自独立）
    expect(readFileSync(legacyFile, 'utf8')).toContain('plain.example.com');
    // 旧文件原样保留（迁移是复制不是移动——无工作区身份的调用仍读它）
    expect(readFileSync(legacyFile, 'utf8')).toContain('impc-dev');
    offWorkspace();
  });
});

describe('SapAdtFs 路径守卫：别名词形（大小写/junction·symlink）不误判逃逸；子树外照拒', () => {
  it('resolve：同子树文件的别名词形放行；子树外与 ../ 逃逸照拒', async ({ skip }) => {
    const base = mkdtempSync(join(tmpdir(), 'ac-adt-fs-'));
    const alias = join(tmpdir(), `ac-adt-alias-${Date.now().toString(36)}`);
    try {
      mkdirSync(join(base, 'src'), { recursive: true });
      writeFileSync(join(base, 'src', 'x.zabap'), 'WRITE x.');
      const adtFs = new SapAdtFs(base);
      // 相对形态（常规）锚定子树
      expect((await adtFs.resolve('src/x.zabap')).targetKey).toBe(join(base, 'src', 'x.zabap'));
      // 别名：兄弟 symlink/junction 指进子树（词法失配、身份回退放行）
      try {
        symlinkSync(base, alias, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        skip('当前环境不支持 symlink/junction');
        return;
      }
      expect((await adtFs.resolve(join(alias, 'src', 'x.zabap'))).targetKey).toBe(join(alias, 'src', 'x.zabap'));
      // win32：同一子树文件的大小写变体（模型手写绝对路径常见词形）
      if (process.platform === 'win32') {
        const upper = join(base.toUpperCase(), 'src', 'x.zabap');
        expect((await adtFs.resolve(upper)).targetKey).toBe(upper);
      }
      // 子树外照拒（词法 + 身份双通道都不在子树内）
      await expect(adtFs.resolve(join(tmpdir(), 'outside.zabap'))).rejects.toThrow(/escapes/);
      await expect(adtFs.resolve('../escape.zabap')).rejects.toThrow(/escapes/);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(alias, { recursive: true, force: true });
    }
  });
});

describe('ac-sap-adt 使用规约注入（loop/before-run，owner 行条件注入）', () => {
  /** 直接驱动 before-run waterfall（不经 loop——只验本行监听器） */
  async function systemAfter(ctx: Context, request: Record<string, unknown>): Promise<string | undefined> {
    const call = { request: { messages: [], ...request } };
    await ctx.waterfall('loop/before-run', call as never, async () => ({ finish: 'stop' }) as never);
    return (call.request as { system?: string }).system;
  }

  it('生效工具集含 adt_* → system 追加 <sap-adt-tools> 规约块（保留既有正文）', async () => {
    const { ctx } = await boot();
    const system = await systemAfter(ctx, { tools: ['adt_search', 'read'], system: '你是 ABAP 助手' });
    expect(system).toContain('你是 ABAP 助手');
    expect(system).toContain('<sap-adt-tools>');
    expect(system).toContain('[ADT 使用规约]');
    // 核心规约在块内：建请求先问 + 复用传输请求
    expect(system).toContain('不得自建');
    expect(system).toContain('modifiable');
  });

  it('tools 未声明 → 回落全目录（demo boot 含 adt_*）→ 注入；无 adt 前缀的工具集不注入', async () => {
    const { ctx } = await boot();
    expect(await systemAfter(ctx, {})).toContain('<sap-adt-tools>');
    expect(await systemAfter(ctx, { tools: ['read', 'write'] })).toBeUndefined();
  });

  it('停用方不注入（settings 合成 false，与暴露面收敛同口径）；改回热恢复', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sap-adt-guide-'));
    const { ctx } = await boot({}, root, true);
    expect(await systemAfter(ctx, { tools: ['adt_search'] })).toContain('<sap-adt-tools>');
    ctx.config.set('settings.sap-adt', { enabled: false });
    expect(await systemAfter(ctx, { tools: ['adt_search'] })).toBeUndefined();
    ctx.config.set('settings.sap-adt', { enabled: true });
    expect(await systemAfter(ctx, { tools: ['adt_search'] })).toContain('<sap-adt-tools>');
  });

  it('硬停（enabled:false，目录无 adt_*）→ 缺省回落目录不含 adt → 不注入', async () => {
    const { ctx } = await boot({ enabled: false });
    expect(await systemAfter(ctx, {})).toBeUndefined();
    expect(await systemAfter(ctx, { tools: ['read'] })).toBeUndefined();
  });
});

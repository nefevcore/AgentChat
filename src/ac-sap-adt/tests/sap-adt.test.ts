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
import { readFileSync, existsSync } from 'node:fs';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as configRow from 'ac-config';
import * as agentsRow from 'ac-agents';
import * as sapAdtRow from '../src/index.ts';

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
    expect(ctx.tools.has('adt_read_object')).toBe(true);
    expect(ctx.tools.has('adt_write_object')).toBe(true);
    expect(ctx.tools.has('adt_crud')).toBe(true);
    const def = (ctx as any).tools.get('adt_search');
    expect(def?.requiredTags).toEqual(['sap-adt']);
    // 参数 schema 是标准 JSON Schema（引擎 defineTool 已转换）
    expect(def?.parameters?.type).toBe('object');
    expect(def?.parameters?.required).toContain('query');
    // 工具目录规模（引擎 0.7.2 实测 46：45 专用 + 1 CRUD 门面；与
    // ac-plugin-core reserved.ts 占名名单精确一致——reserved-consistency 锁定）
    const adtNames = (ctx as any).tools.list().filter((d: { name: string }) => d.name.startsWith('adt_'));
    expect(adtNames.length).toBeGreaterThanOrEqual(46);
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

  it('adt_search → adt_read_object 闭环；快照经 fs 缝落盘到 <root>/sap-adt/', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sap-adt-'));
    const { ctx } = await boot({}, root);
    const search = await exec(ctx, 'adt_search', { query: 'ZCL_DEMO' });
    expect(search.ok).toBe(true);
    expect(search.output.objects.length).toBeGreaterThan(0);
    expect(search.output.objects[0].objectName).toBe('ZCL_DEMO');

    const read = await exec(ctx, 'adt_read_object', { name: 'ZCL_DEMO', type: 'CLAS' });
    expect(read.ok).toBe(true);
    expect(String(read.output.source).toLowerCase()).toContain('class');
    expect(read.output.localCopy).toBeTruthy();
    const snap = join(root, 'sap-adt', String(read.output.localCopy));
    expect(existsSync(snap)).toBe(true);
    expect(readFileSync(snap, 'utf8')).toBe(read.output.source);
  });

  it('引擎策略拒绝路径透传为 {ok:false, error 含 [POLICY]}（调试器默认关）', async () => {
    const { ctx } = await boot();
    const res = await exec(ctx, 'adt_debug_session', { action: 'listen' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('[POLICY]');
  });

  it('参数校验（引擎 defineTool）拒绝非法枚举并给出可读违规', async () => {
    const { ctx } = await boot();
    const res = await exec(ctx, 'adt_crud', { verb: 'explode' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('must be one of');
  });

  it('adt_crud 无 verb 调用返回能力矩阵卡（门面路由装配完好）', async () => {
    const { ctx } = await boot();
    const res = await exec(ctx, 'adt_crud');
    expect(res.ok).toBe(true);
    const text = JSON.stringify(res.output);
    expect(text).toContain('create');
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
    const read = await exec(ctx, 'adt_read_object', { name: 'ZCL_DEMO', type: 'CLAS' });
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
});

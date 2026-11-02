// ============================================================
// tool-catalog-parity.test.ts —— 工具目录快照对账锁（cr-825 批三）
//
// 静态目录（apps/catalog/tool-catalog.json = tools/list 冷面底座）与
// 真装配注册面的对拍：漂移即红，提示重跑 scripts/gen-tool-catalog.mjs。
// 与 catalog.test.ts（行集目录对账）同构——生成物快照 vs 单源真值。
// 对账口径（同生成器）：全部声明 tools 的行全点名装配 → listWithOwner
// 投影逐字段一致；平台差（bash/pwsh 二选一注册）按在场侧对拍、缺席侧
// 与在场侧（改名外）一致。
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bootShell } from '../boot.ts';
import { readCatalog } from 'ac-rowset-core';

const CATALOG = path.join(process.env.AGENTCHAT_REPO_ROOT ?? process.cwd(), 'apps', 'catalog', 'row-catalog.json');
const SNAPSHOT = path.join(process.env.AGENTCHAT_REPO_ROOT ?? process.cwd(), 'apps', 'catalog', 'tool-catalog.json');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-parity-'));
const AGENT = '__tool_parity__';

let boot: Awaited<ReturnType<typeof bootShell>> | null = null;

beforeAll(async () => {
  const catalog = readCatalog(CATALOG);
  const toolRowIds = catalog.rows
    .filter((r) => r.tree === 'shell' && (r.tools !== undefined || r.id === 'mcp'))
    .map((r) => r.id);
  const dir = path.join(DATA_ROOT, 'agents', AGENT);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ id: AGENT, model: 'mock', rows: toolRowIds }), 'utf-8');
  const started = await bootShell({ dataRoot: DATA_ROOT, agentId: AGENT, catalogFile: CATALOG, mockProvider: true }, { emit: () => {} });
  boot = started;
  // sap-adt 异步 init——轮询有界等待到目录声明全集在场
  const want = catalog.rows
    .filter((r) => r.tree === 'shell' && r.tools !== undefined)
    .flatMap((r) => r.tools ?? [])
    .filter((t) => t !== 'bash' || process.platform !== 'win32');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const names = new Set((started.ctx.get('tools') as { list(): Array<{ name: string }> }).list().map((t) => t.name));
    if (want.every((w) => names.has(w))) break;
    await new Promise((r) => setTimeout(r, 200));
  }
}, 60_000);

afterAll(async () => {
  await boot?.close();
  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
});

/** 注册面投影（与生成器同形态——toolsCatalog 的 dump 口径） */
function liveEntries(): Array<Record<string, unknown>> {
  if (boot === null) throw new Error('boot 未就绪');
  const tools = boot.ctx.get('tools') as unknown as { listWithOwner(): Array<Record<string, unknown>> };
  return tools.listWithOwner().map((t) => ({
    name: t.name,
    description: t.description ?? '',
    parameters: t.parameters ?? {},
    owner: t.owner,
    ...(t.requiredTags ? { requiredTags: t.requiredTags } : {}),
    ...(t.needPermission ? { needPermission: true } : {}),
    ...(t.injection !== undefined && t.injection !== 'capability' ? { injection: t.injection } : {}),
    ...(t.requiresInteraction ? { requiresInteraction: true } : {}),
  }));
}

describe('工具目录快照对账（tool-catalog.json ↔ 真装配注册面）', () => {
  it('快照可读且工具非空（生成器产物在场）', () => {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf-8')) as { tools: unknown[] };
    expect(snap.tools.length).toBeGreaterThan(50);
  });

  it('逐字段对拍：真装配注册面 ⊆ 快照且定义一致（漂移 = 重跑生成器）', () => {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf-8')) as { tools: Array<Record<string, unknown>> };
    const byName = new Map(snap.tools.map((t) => [String(t.name), t]));
    const drift: string[] = [];
    for (const live of liveEntries()) {
      const name = String(live.name);
      const declared = byName.get(name);
      if (declared === undefined) {
        drift.push(name + ': 注册面有、快照缺（新增工具未生成快照）');
        continue;
      }
      for (const key of ['description', 'parameters', 'owner', 'requiredTags', 'needPermission', 'injection', 'requiresInteraction']) {
        if (JSON.stringify(declared[key] ?? null) !== JSON.stringify(live[key] ?? null)) {
          drift.push(name + '.' + key + ': 快照与注册面不一致');
        }
      }
    }
    expect(drift.join('\n')).toBe('');
  });

  it('词形对账：row-catalog 声明的行工具名 ⊆ 快照（声明 stale 或漏生成即红）', () => {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf-8')) as { tools: Array<{ name: string }> };
    const names = new Set(snap.tools.map((t) => t.name));
    const catalog = readCatalog(CATALOG);
    const missing: string[] = [];
    for (const r of catalog.rows.filter((x) => x.tree === 'shell' && x.tools !== undefined)) {
      for (const t of r.tools ?? []) {
        if (!names.has(t)) missing.push(r.id + ' → ' + t);
      }
    }
    expect(missing.join('; ')).toBe('');
  });

  // cr-826 事件目录段：events（注册面 dump）与 eventDescs（声明目录）对拍
  it('事件注册面对拍：真装配 _hooks（过滤 internal/*）⊆ 快照 events 且 listener 逐字段一致', () => {
    if (boot === null) throw new Error('boot 未就绪');
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf-8')) as {
      events: Array<{ name: string; listeners: Array<Record<string, unknown>> }>;
    };
    const byName = new Map(snap.events.map((e) => [e.name, e.listeners]));
    const drift: string[] = [];
    const hooksTable = boot.ctx.events as unknown as {
      _hooks: Record<string, Array<{ ctx?: { fiber?: { name?: string } }; prepend?: unknown; global?: unknown; description?: unknown }>>;
    };
    for (const [name, hooks] of Object.entries(hooksTable._hooks)) {
      if (name.startsWith('internal/')) continue;
      if (!Array.isArray(hooks) || hooks.length === 0) continue;
      const declared = byName.get(name);
      if (declared === undefined) {
        drift.push(name + ': 注册面有、快照缺（新增监听器未重跑生成器）');
        continue;
      }
      // 同 owner 可有多条 listener（如 ac-skill 两个 ctx.on）——按
      // (owner, prepend, global, description) 签名集合对拍
      const sigOf = (l: { owner?: unknown; prepend?: unknown; global?: unknown; description?: unknown }, desc?: unknown) =>
        String(l.owner) + '|' + (l.prepend === true) + '|' + (l.global === true) + '|' + String(l.description ?? desc ?? '');
      const declaredSigs = new Set(declared.map((l) => sigOf(l)));
      for (const h of hooks) {
        const sig = sigOf(
          { owner: h.ctx?.fiber?.name ?? '(anonymous)', prepend: h.prepend, global: h.global },
          typeof h.description === 'string' ? h.description : '',
        );
        if (!declaredSigs.has(sig)) {
          drift.push(name + ': listener 签名缺席（' + sig.slice(0, 80) + '）');
        }
      }
    }
    expect(drift.join('\n')).toBe('');
  });

  it('事件声明目录在场（eventDescs 非空——生成器 import 面正常）', () => {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf-8')) as { eventDescs: unknown[] };
    expect(snap.eventDescs.length).toBeGreaterThan(5);
  });
});

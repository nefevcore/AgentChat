// ============================================================
// ac-run-code 测试：worker 快照降级链（自锁事故实测证伪后的修复锁定）
// · absolutizeSnapshotImports：import 说明符绝对化（词法骨架跳过字符串）
// · 快照候选真实引导：dev/bundle 缺席 → 磁盘快照（绝对化 import）跑通程序
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as agentsRow from 'ac-agents';
import * as diRow from 'ac-durable-interaction';
import { absolutizeSnapshotImports, buildWorkerSnapshotJs, __runCodeTestHooks } from '../src/tool.ts';
import * as runCodeRow from '../src/index.ts';

const REAL_WORKER = fileURLToPath(new URL('../src/worker.ts', import.meta.url));

describe('absolutizeSnapshotImports', () => {
  it('相对导入 → 源目录 file URL；node: 内置放行', () => {
    const out = absolutizeSnapshotImports("import { X } from './protocol.ts';\nimport { Y } from 'node:fs';", 'file:///repo/pkg/src/worker.ts');
    expect(out).toContain("from 'file:///repo/pkg/src/protocol.ts'");
    expect(out).toContain("from 'node:fs'");
  });
  it('裸包名 → requireShim.resolve 入口（真实 workspace 解析）', () => {
    const out = absolutizeSnapshotImports("import { normalizeSource } from 'ac-run-code-core';", 'file:///repo/pkg/src/worker.ts');
    expect(out).toMatch(/from 'file:\/\/\/.*ac-run-code-core\/src\/index\.ts';/);
  });
  it('type import 与 CRLF 行尾原样保留', () => {
    const src = "import type { A } from './p.ts';\r\nconst x = 1;";
    const out = absolutizeSnapshotImports(src, 'file:///repo/pkg/src/worker.ts');
    expect(out).toContain("from 'file:///repo/pkg/src/p.ts';\r\n");
  });
  it('字符串/模板内的 import 字样不动（词法骨架跳过）', () => {
    const src = 'const s = ' + JSON.stringify("import { x } from './fake.ts';") + ';';
    expect(absolutizeSnapshotImports(src, 'file:///w.ts')).toBe(src);
  });
  it('真实 worker 源构建快照：全部 import 可解析形态', () => {
    const js = buildWorkerSnapshotJs(REAL_WORKER, readFileSync(REAL_WORKER, 'utf8'));
    expect(js).toBeDefined();
    for (const line of js!.split('\n')) {
      const m = /^import\s+(?:type\s+)?[^' ]*\s+from\s+'([^']+)';$/.exec(line.trim());
      if (m) expect(m[1].startsWith('node:') || m[1].startsWith('file:///')).toBe(true);
    }
  });
});

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
async function boot() {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, llmRow, loopRow, agentsRow, diRow] as unknown[]) fibers.push(await ctx.plugin(row as any));
  ctx.agents.register({ id: 'tester', model: 'm' });
  fibers.push(await ctx.plugin({
    name: 'probe-row', inject: ['tools'],
    apply(c: Context) {
      c.tools.register({ name: 'echo', description: '回声', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, execute: (args) => ({ ok: true, output: { echoed: String(args.text ?? '') } }) });
    },
  } as any));
  fibers.push(await ctx.plugin(runCodeRow as any));
  const entry = { ctx, fibers };
  booted.push(entry);
  return entry;
}
afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) { try { if (fiber.uid !== null) await fiber.dispose(); } catch { /* */ } }
  }
});

describe('快照候选真实引导（降级链修复验收）', () => {
  it('dev/bundle 缺席 → 磁盘快照（import 已绝对化）跑通完整 run_code 程序', async () => {
    const { ctx } = await boot();
    const fakeDev = 'sandbox/tmp/definitely-missing-worker.ts';
    const restore = __runCodeTestHooks.overrideWorkerEntries(() => fakeDev, () => 'sandbox/tmp/definitely-missing-bundle.mjs');
    try {
      const js = buildWorkerSnapshotJs(REAL_WORKER, readFileSync(REAL_WORKER, 'utf8'))!;
      __runCodeTestHooks.seedDiskSnapshot(fakeDev, js);
      const r = await ctx.tools.execute({
        name: 'run_code',
        args: { code: "const e = await tools.echo({ text: 'snap' }); return { ok: e.ok, echoed: e.output?.echoed };" },
        agentId: 'tester', conversationId: 'conv-snap', toolCallId: 'tc-snap',
      });
      expect(r.ok).toBe(true);
      expect((r.output as { value?: { echoed?: string } })?.value?.echoed).toBe('snap');
    } finally {
      restore();
    }
  });
});
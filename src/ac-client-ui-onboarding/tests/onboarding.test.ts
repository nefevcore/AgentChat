// ============================================================
// src/ac-client-ui-onboarding/tests/onboarding.test.ts —— 行验收
//
// · 纯逻辑：首启标记读写（无键=首启/写后不再/坏值容忍）+ 跳过确认
//   判定（无连接且未确认过才拦）。
// · 宿主半边：boot graph 声明 + 卸载级联回收。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as onboardingRow from '../src/index.ts';
import { readMark, writeMark, ONBOARDING_KEY, shouldConfirmSkip } from '../client/onboardingState.ts';

function memStorage(): { store: Map<string, string>; face: { getItem(k: string): string | null; setItem(k: string, v: string): void } } {
  const store = new Map<string, string>();
  return {
    store,
    face: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => { store.set(k, v); },
    },
  };
}

describe('首启标记（localStorage 单键）', () => {
  it('无键 → null（首启该弹）', () => {
    const { face } = memStorage();
    expect(readMark(face)).toBeNull();
  });

  it('写标记后 → 非 null（不再首启）', () => {
    const { face } = memStorage();
    writeMark(face);
    const mark = readMark(face);
    expect(mark).not.toBeNull();
    expect(mark!.version).toBe(1);
    expect(mark!.completedAt).toBeTruthy();
  });

  it('坏值（非 JSON / 缺 completedAt）→ null（容忍不崩）', () => {
    const { store, face } = memStorage();
    store.set(ONBOARDING_KEY, '{oops');
    expect(readMark(face)).toBeNull();
    store.set(ONBOARDING_KEY, JSON.stringify({ version: 1 }));
    expect(readMark(face)).toBeNull();
  });

  it('存储抛异常 → 不崩（返回 null）', () => {
    const face = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(readMark(face)).toBeNull();
    expect(() => writeMark(face)).not.toThrow();
  });
});

describe('跳过确认判定（§3.4/D5）', () => {
  it('无连接且未确认过 → 拦', () => {
    expect(shouldConfirmSkip(0, false)).toBe(true);
  });
  it('已配模型 → 不拦', () => {
    expect(shouldConfirmSkip(1, false)).toBe(false);
  });
  it('确认过一次 → 不再拦', () => {
    expect(shouldConfirmSkip(0, true)).toBe(false);
  });
  it('探测失败（-1）→ 不拦（静默降级）', () => {
    expect(shouldConfirmSkip(-1, false)).toBe(false);
  });
});

describe('宿主半边（boot graph 声明）', () => {
  async function loadRow(ctx: Context): Promise<Fiber> {
    const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
    return plug(onboardingRow, undefined);
  }

  async function boot() {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    return ctx;
  }

  it('行装载 → boot graph 含 ui-onboarding 条目', async () => {
    const ctx = await boot();
    await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    const entry = graph.find((g) => g.name === 'ui-onboarding');
    expect(entry).toBeTruthy();
    expect(entry!.platform).toBe('web');
    expect(entry!.phase).toBe('domain');
  });

  it('行卸载 → 声明级联回收（可摘除性证据）', async () => {
    const ctx = await boot();
    const fiber = await loadRow(ctx);
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().some((g) => g.name === 'ui-onboarding')).toBe(false);
  });
});

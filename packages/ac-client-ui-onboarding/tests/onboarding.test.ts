// ============================================================
// packages/ac-client-ui-onboarding/tests/onboarding.test.ts —— 行验收
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

describe('M28 P1 · ac-client-ui-onboarding 宿主半边（零功能行——cr-1117：装载/卸载零副作用 + extension 形状）', () => {
  it('行装载/卸载零副作用（apply 空实现，无宿主面注册）', async () => {
    const plug = new Context().plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
    const fiber = await plug(onboardingRow, undefined);
    await fiber.dispose();
  });

  it('extension 自述形状（extension-catalog 聚合面契约）', () => {
    expect(onboardingRow.extension.name).toBe(onboardingRow.extension.name.trim());
    expect(onboardingRow.extension.label.length).toBeGreaterThan(0);
    expect(onboardingRow.extension.automatic).toBe(true);
  });
});

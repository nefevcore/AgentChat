// @vitest-environment jsdom
// ============================================================
// run-status-dock-markup.test.ts —— 状态指示视觉契约（cr-769 起）
// 锁四件：无壳（不挂 DockCard）、整行一条色域、文案独占 live region
// （计时不进播报面）、error 停摆档；另锁色域的双层配方（cr-791）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApp, h } from 'vue';
import RunStatusDock from '../client/RunStatusDock.vue';
import type { RunStatus } from '../client/runStatus.ts';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '../client/RunStatusDock.vue'), 'utf8');

let mounted: ReturnType<typeof createApp> | null = null;

function mount(status: RunStatus) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp({ render: () => h(RunStatusDock, { status }) });
  app.mount(root);
  mounted = app;
  return root;
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
});

describe('RunStatusDock 视觉契约', () => {
  it('hidden 不渲染任何东西', () => {
    const root = mount({ kind: 'hidden' });
    expect(root.querySelector('.run-signal')).toBeNull();
  });

  it('无壳：既无 .dock 卡族，也无 pill 容器——只有一行读数', () => {
    const root = mount({ kind: 'calling', sinceMs: Date.now() - 4000 });
    expect(root.querySelector('.dock')).toBeNull();
    expect(root.querySelector('.rs-pill')).toBeNull();
    expect(root.querySelector('.run-signal > .rs-line')).not.toBeNull();
  });

  it('相位 → 色彩/节奏类；计时 + 状态点 + 候选文案在场', () => {
    const root = mount({ kind: 'tooling', sinceMs: Date.now() - 5000 });
    const signal = root.querySelector('.run-signal');
    expect(signal?.classList.contains('phase-tooling')).toBe(true);
    expect(signal?.querySelector('.rs-clock')?.textContent).toContain('秒');
    expect(signal?.querySelector('.rs-status')).not.toBeNull();
    expect(signal?.querySelector('.rs-dot')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('顺序 = 文案在前、计时在后（cr-782：时间只是注脚）', () => {
    const root = mount({ kind: 'replying', sinceMs: Date.now() - 8000 });
    const kids = Array.from(root.querySelector('.rs-line')?.children ?? []);
    expect(kids[0]?.classList.contains('rs-status')).toBe(true);
    expect(kids[1]?.classList.contains('rs-clock')).toBe(true);
  });

  it('文案独占 live region——计时在播报面之外，状态点不朗读', () => {
    const root = mount({ kind: 'thinking', sinceMs: Date.now() - 3000 });
    const live = root.querySelector('[role="status"]');
    expect(live?.textContent).toBe('正在深度思考…');
    expect(live?.classList.contains('rs-clock')).toBe(false);
    expect(root.querySelector('.rs-dot')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('整行一条色域：文案与计时同处一行，容器本身无壳类', () => {
    const root = mount({ kind: 'calling', sinceMs: Date.now() - 4000 });
    const line = root.querySelector('.rs-line');
    expect(line?.querySelector('.rs-clock')).not.toBeNull();
    expect(line?.querySelector('.rs-status')).not.toBeNull();
    // 容器自身只有 rs-line 一个类（透明的前提：无卡族/pill/壳类）；
    // 色域收敛到 .rs-line::before 一条（cr-786：不再是文案区/计时区两块）
    expect(line?.className).toBe('rs-line');
    expect(root.querySelector('.rs-status')?.className).toBe('rs-status');
    expect(root.querySelector('.rs-clock')?.className).toBe('rs-clock');
  });

  it('error → 停摆档（phase-error + 错误文案，无计时域）', () => {
    const root = mount({ kind: 'error', text: '发送失败：超时' });
    const signal = root.querySelector('.run-signal');
    expect(signal?.classList.contains('phase-error')).toBe(true);
    expect(signal?.querySelector('.rs-clock')).toBeNull();
    expect(signal?.querySelector('.rs-label')?.textContent).toBe('发送失败：超时');
  });
});

describe('色域配方（cr-791 双层）', () => {
  it('::before 是双层背景：色相层在上、底色层在下', () => {
    const block = source.match(/\.rs-line::before\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(block).toMatch(/background:\s*\n?\s*linear-gradient/);
    // 双层 = 两个 linear-gradient：色相层在前（绘制在上）、底色层在后
    const layers = block.match(/linear-gradient\(to bottom/g) ?? [];
    expect(layers.length).toBeGreaterThanOrEqual(2);
    expect(block).toContain('rgba(var(--tone), var(--scrim-a))');
    expect(block).toContain('var(--rs-base)');
  });

  it('底色走令牌而不是硬编码 white（cr-773 的同一条教训：暗色下白块会毁掉对比度）', () => {
    expect(source).toContain('--rs-base: var(--bg-base)');
    const block = source.match(/\.rs-line::before\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(block).not.toMatch(/\bwhite\b/);
    // mask 行的 #000 是遮罩不透明度标记（不是颜色），排除后再查色值字面量
    const colorLines = block.split('\n').filter((l) => !l.includes('mask')).join('\n');
    expect(colorLines).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('底色软化宽度是变量（起止同源，避免两边不一致）', () => {
    expect(source).toContain('--rs-base-ramp: 20%');
    const block = source.match(/\.rs-line::before\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(block).toContain('var(--rs-base) var(--rs-base-ramp)');
    expect(block).toContain('calc(100% - var(--rs-base-ramp))');
  });
});

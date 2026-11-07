// ============================================================
// webui-v3 wire 合成单测（cr-925 切片①）：校验门 / 撞名防御 /
// 种子对拍 / 拓扑排与降级 / rev 稳定性——docs/design/webui-v3.md §4.3
// ============================================================
import { describe, it, expect } from 'vitest';
import { checkWebFace, seedCompatible, synthesizeWire, assetUrl, type WireRowInput } from '../src/wire.ts';

const SEEDS = { vue: '^3.4', pinia: '^2.1' };

function row(partial: Partial<WireRowInput> & { id: string }): WireRowInput {
  return { version: '1.0.0', revision: 'r1', entry: 'index.js', seats: ['conversation:dock-widget'], ...partial };
}

describe('checkWebFace 声明校验门', () => {
  it('合法声明过验（entry 显式词形 + seats/isolated/inject/seeds）', () => {
    const c = checkWebFace({ entry: './client/dist/index.js', seats: ['conversation:dock-widget'], isolated: false, inject: ['ac-client-ui-layout'], seeds: { vue: '^3.x' } });
    expect(c.ok).toBe(true);
  });
  it('entry 词形：非产物路径 / 逃逸 / 缺席全拦', () => {
    expect(checkWebFace({ entry: './client/src/index.ts' }).ok).toBe(false);
    expect(checkWebFace({ entry: './client/dist/../../x.js' }).ok).toBe(false);
    expect(checkWebFace({}).ok).toBe(false);
    expect(checkWebFace(null).ok).toBe(false);
  });
  it('theme 行：theme+styles 声明过验；携带 entry/seats、styles 缺席/词形非法全拦', () => {
    expect(checkWebFace({ theme: 'midnight', styles: ['./client/dist/tokens.css'] }).ok).toBe(true);
    expect(checkWebFace({ theme: 'midnight', styles: ['./client/dist/tokens.css'], entry: './client/dist/index.js' }).ok).toBe(false);
    expect(checkWebFace({ theme: 'midnight', styles: ['./client/dist/tokens.css'], seats: ['aux-sidebar'] }).ok).toBe(false);
    expect(checkWebFace({ theme: 'midnight' }).ok).toBe(false);
    expect(checkWebFace({ theme: 'midnight', styles: ['./client/tokens.css'] }).ok).toBe(false);
    expect(checkWebFace({ theme: 'Bad_Id', styles: ['./client/dist/tokens.css'] }).ok).toBe(false);
  });
  it('seats/inject 非字符串数组、isolated 非布尔、seeds 非区间表均拦', () => {
    expect(checkWebFace({ entry: './client/dist/index.js', seats: 'x' }).ok).toBe(false);
    expect(checkWebFace({ entry: './client/dist/index.js', inject: [1] }).ok).toBe(false);
    expect(checkWebFace({ entry: './client/dist/index.js', isolated: 'yes' }).ok).toBe(false);
    expect(checkWebFace({ entry: './client/dist/index.js', seeds: { vue: 3 } }).ok).toBe(false);
  });
});

describe('seedCompatible 主版本轴对拍', () => {
  it('同主版本兼容（^3.4 × 3.x / ~3.1 / >=3.0）', () => {
    expect(seedCompatible('^3.4', '^3.x')).toBe(true);
    expect(seedCompatible('^3.4', '~3.1')).toBe(true);
    expect(seedCompatible('v3.2.0', '>=3.0 <4')).toBe(true);
  });
  it('跨大版本禁静默（vue 4 壳 × vue 3 行 = 不匹配）', () => {
    expect(seedCompatible('^4.0', '^3.4')).toBe(false);
  });
  it('不可解析区间 = 不匹配（loud 而非猜）', () => {
    expect(seedCompatible('latest', '^3.4')).toBe(false);
  });
});

describe('synthesizeWire 合成', () => {
  it('拓扑排：inject 依赖先行；无依赖保持输入序', () => {
    const w = synthesizeWire([
      row({ id: 'b', inject: ['a'] }),
      row({ id: 'a' }),
      row({ id: 'c' }),
    ], SEEDS);
    expect(w.warnings).toEqual([]);
    // 独立层保持输入序：a/c 同层（输入序 a 先于 c），b 随后
    expect(w.rows.map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });
  it('rev：行集不变恒等；增删行/换 revision 必变', () => {
    const base = [row({ id: 'a' }), row({ id: 'b' })];
    const w1 = synthesizeWire(base, SEEDS);
    const w2 = synthesizeWire([...base].reverse(), SEEDS); // 输入序无关
    const w3 = synthesizeWire([row({ id: 'a' })], SEEDS); // 减行
    const w4 = synthesizeWire([row({ id: 'a' }), row({ id: 'b', revision: 'r2' })], SEEDS); // 换 rev
    expect(w2.rev).toBe(w1.rev);
    expect(w3.rev).not.toBe(w1.rev);
    expect(w4.rev).not.toBe(w1.rev);
  });
  it('撞名防御：后到跳过 + warnings 上报', () => {
    const w = synthesizeWire([row({ id: 'a' }), row({ id: 'a', revision: 'r2' })], SEEDS);
    expect(w.rows).toHaveLength(1);
    expect(w.rows[0].entry).toContain('r1');
    expect(w.warnings.some((x) => x.includes('撞名'))).toBe(true);
  });
  it('inject 点名缺席 = 降级跳过 + 上报', () => {
    const w = synthesizeWire([row({ id: 'a', inject: ['ghost'] })], SEEDS);
    expect(w.rows).toHaveLength(0);
    expect(w.warnings.some((x) => x.includes('点名缺席'))).toBe(true);
  });
  it('inject 环：环成员跳过 + 上报，环外行不受牵连', () => {
    const w = synthesizeWire([
      row({ id: 'x', inject: ['y'] }),
      row({ id: 'y', inject: ['x'] }),
      row({ id: 'z' }),
    ], SEEDS);
    expect(w.rows.map((r) => r.id)).toEqual(['z']);
    expect(w.warnings.filter((x) => x.includes('环'))).toHaveLength(2);
  });
  it('种子不匹配 = 跳过 + 上报（跨大版本禁静默）', () => {
    const w = synthesizeWire([
      row({ id: 'a', seeds: { vue: '^4.0' } }),
      row({ id: 'b', seeds: { vue: '^3.0' } }),
    ], SEEDS);
    expect(w.rows.map((r) => r.id)).toEqual(['b']);
    expect(w.warnings.some((x) => x.includes('种子 vue'))).toBe(true);
  });
  it('纯样式行：entry 缺席合法，styles 映射 revision URL', () => {
    const w = synthesizeWire([row({ id: 'theme', entry: undefined, styles: ['tokens.css'] })], SEEDS);
    expect(w.rows[0].entry).toBeUndefined();
    expect(w.rows[0].styles).toEqual([assetUrl('theme', 'r1', 'tokens.css')]);
  });
  it('theme 行：themeId 投影 + styles revision URL + 恒非隔离（cr-936）', () => {
    const w = synthesizeWire([
      row({ id: 'ac-client-theme-x', entry: undefined, seats: [], styles: ['tokens.css'], themeId: 'midnight' }),
    ], SEEDS);
    expect(w.warnings).toEqual([]);
    expect(w.rows[0]).toMatchObject({
      id: 'ac-client-theme-x',
      themeId: 'midnight',
      isolated: false,
      styles: [assetUrl('ac-client-theme-x', 'r1', 'tokens.css')],
    });
    expect(w.rows[0]!.entry).toBeUndefined();
  });
  it('theme 行约束：携带 entry/seats、缺 styles、themeId 词形非法 = 警告跳过', () => {
    const withEntry = synthesizeWire([row({ id: 't1', seats: [], styles: ['tokens.css'], themeId: 't1' })], SEEDS);
    expect(withEntry.rows).toHaveLength(0);
    expect(withEntry.warnings.some((x) => x.includes('theme 行不携带 entry'))).toBe(true);
    const withSeats = synthesizeWire([row({ id: 't2', entry: undefined, styles: ['tokens.css'], themeId: 't2' })], SEEDS);
    expect(withSeats.rows).toHaveLength(0);
    expect(withSeats.warnings.some((x) => x.includes('theme 行不携带 seats'))).toBe(true);
    const noStyles = synthesizeWire([row({ id: 't3', entry: undefined, seats: [], themeId: 't3' })], SEEDS);
    expect(noStyles.rows).toHaveLength(0);
    expect(noStyles.warnings.some((x) => x.includes('theme 行缺 styles'))).toBe(true);
    const badId = synthesizeWire([row({ id: 't4', entry: undefined, seats: [], styles: ['tokens.css'], themeId: 'Bad' })], SEEDS);
    expect(badId.rows).toHaveLength(0);
    expect(badId.warnings.some((x) => x.includes('themeId 词形非法'))).toBe(true);
  });
  it('entry/styles 产物词形与 isolated 缺省（v3 = false）', () => {
    const w = synthesizeWire([
      row({ id: 'a', entry: '../escape.js' }),
      row({ id: 'b', styles: ['../tokens.css'] }),
      row({ id: 'c' }),
    ], SEEDS);
    expect(w.rows.map((r) => r.id)).toEqual(['c']);
    expect(w.rows[0].isolated).toBe(false);
    expect(w.warnings.some((x) => x.includes('entry 产物词形'))).toBe(true);
    expect(w.warnings.some((x) => x.includes('styles 产物词形'))).toBe(true);
  });
  it('行 id 词形与 version/revision 缺席拦截', () => {
    const w = synthesizeWire([
      row({ id: 'Bad_Id' }),
      row({ id: 'ok', version: '' }),
      row({ id: 'ok2', revision: '' }),
    ], SEEDS);
    expect(w.rows).toHaveLength(0);
    expect(w.warnings).toHaveLength(3);
  });
});

// ============================================================
// webui/tests/contrast-tokens.test.ts —— 对比度契约（cr-121）
//
// 背景：双主题色值过去由人眼评审（"看起来还行"），实测浅色主题的
// text-2/3、ok/warn/err 与暗色 surface 上的 text-3/err 全在 4.5:1 以下，
// 徽章 tint 底与星色板更是低到 2~4:1。改色又是最高频的样式改动，
// 因此把「前景 × 底色」的对比度变成 CI 断言而非评审意见：
//   ① 文本/图标令牌 × 四种底色 ≥ 4.5（WCAG 2.1 · 1.4.3 正文线）
//   ② 徽章／标签／星色：本色 + 自身 tint 底（淡染会抬高背景亮度，是最坏底）
//   ③ 控件状态（开关开/关）≥ 3.0（图形 1.4.11），且开/关两态可辨 ≥ 3.0
// 解析对象是 tokens.css / badge.css / row.css / StarAvatar.vue / starColor.ts
// 本体——不是复制值，故改色漏改、加色相类漏加档都会红灯。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const KIT = join(repo, 'src/webui-kit/src');
const tokensCss = readFileSync(join(KIT, 'base/tokens.css'), 'utf8');
const badgeCss = readFileSync(join(KIT, 'base/badge.css'), 'utf8');
const rowCss = readFileSync(join(KIT, 'base/row.css'), 'utf8');
const starAvatar = readFileSync(join(KIT, 'star/StarAvatar.vue'), 'utf8');
const starColorTs = readFileSync(join(KIT, 'starColor.ts'), 'utf8');

type Rgb = [number, number, number];
function hexToRgb(hex: string): Rgb {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`不是 hex 色值：${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}
/** 相对亮度（WCAG 2.1 定义） */
function luminance([r, g, b]: Rgb): number {
  const ch = [r, g, b].map((v) => {
    const u = v / 255;
    return u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
function contrast(a: Rgb | string, b: Rgb | string): number {
  const l1 = luminance(typeof a === "string" ? hexToRgb(a) : a);
  const l2 = luminance(typeof b === "string" ? hexToRgb(b) : b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
/** fg 以 alpha 覆在 bg 上（等价 rgba 叠加；tint 底都是这种形态） */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((c, i) => Math.round(c * alpha + bg[i]! * (1 - alpha))) as Rgb;
}
/** 抽 tokens.css 中某主题块的全部 --x: 值 */
function themeBlock(anchor: string): Record<string, string> {
  const start = tokensCss.indexOf(anchor);
  expect(start, `tokens.css 缺主题块：${anchor}`).toBeGreaterThan(-1);
  const end = tokensCss.indexOf("}", start);
  const out: Record<string, string> = {};
  for (const m of tokensCss.slice(start, end).matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}
const nebula = themeBlock("html[data-theme='nebula']");
const aurora = themeBlock("html[data-theme='aurora']");
const root = themeBlock(':root {');

/** 底色三档（令牌都在两侧主题块里） */
const SURFACES = ['bg-base', 'bg-surface', 'bg-raised', 'bg-hover'];
function color(t: Record<string, string>, name: string): Rgb {
  const v = t[name];
  if (!v) throw new Error(`令牌缺失：--${name}`);
  return hexToRgb(v);
}

describe('对比度契约（cr-121）', () => {
  it('① L0 契约令牌齐备（焦点环 / 运动归一 / 命中区 / 比例尺 / 双主题分层）', () => {
    for (const name of ['focus-ring', 'focus-ring-width', 'focus-ring-offset', 'motion-scale', 'hit-min', 'fs-2xs', 'fs-xs', 'fs-sm', 'fs-md', 'fs-lg', 'fs-xl', 'ctl-h-sm', 'ctl-h-md', 'ctl-h-lg', 'switch-knob']) {
      expect(root[name], `--${name}`).toBeTruthy();
    }
    // 主题相关（浮层分层 / 实底前景）在两侧主题块里
    for (const [theme, t] of [['nebula', nebula], ['aurora', aurora]] as const) {
      expect(t['elev-hairline'], `${theme} --elev-hairline`).toBeTruthy();
      expect(t['on-primary'], `${theme} --on-primary`).toBeTruthy();
    }
    expect(root['motion-scale']).toBe('1');
    expect(tokensCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*--motion-scale: 0/);
  });

  it('② 文本/图标令牌 × 四种底 ≥ 4.5（双主题）', () => {
    const INKS = ['text-1', 'text-2', 'text-3', 'primary', 'primary-strong', 'ok', 'warn', 'err'];
    for (const theme of ['nebula', 'aurora'] as const) {
      const t = theme === 'nebula' ? nebula : aurora;
      for (const ink of INKS) {
        for (const s of SURFACES) {
          const c = contrast(color(t, ink), color(t, s));
          expect(c, `${theme} --${ink} on --${s} = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('②b 图形档令牌：图形件 ≥3.0（WCAG 1.4.11 · base/surface/raised 三底，cr-123）', () => {
    const GRAPHICS = ['ok-graphic', 'warn-graphic', 'err-graphic'] as const;
    // 图形件（环描边/状态点/色条）实际只落三白净底；hover 底上无图形件消费
    const G3 = ['bg-base', 'bg-surface', 'bg-raised'] as const;
    for (const theme of ['nebula', 'aurora'] as const) {
      const t = theme === 'nebula' ? nebula : aurora;
      for (const ink of GRAPHICS) {
        for (const s of G3) {
          const c = contrast(color(t, ink), color(t, s));
          expect(c, `${theme} --${ink} on --${s} = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it('③ 实底上的前景（primary 按钮 / 开关滑块）可达', () => {
    for (const theme of ['nebula', 'aurora'] as const) {
      const t = theme === 'nebula' ? nebula : aurora;
      const onPrimary = contrast(color(t, 'on-primary'), color(t, 'primary'));
      expect(onPrimary, `${theme} on-primary/primary = ${onPrimary.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('④ 徽章：本色 × 自身 tint 底 ≥ 4.5（状态徽章 + info/cfg + dim）', () => {
    const tints: Record<string, number> = {};
    for (const m of badgeCss.matchAll(/\.ui-badge\.(ok|err|warn|info)\s*\{[^}]*rgba\(var\(--([\w-]+)-rgb\),\s*([\d.]+)\)/g)) {
      tints[m[1]!] = Number(m[3]);
    }
    expect(Object.keys(tints).sort()).toEqual(['err', 'info', 'ok', 'warn']);
    for (const theme of ['nebula', 'aurora'] as const) {
      const t = theme === 'nebula' ? nebula : aurora;
      const surface = color(t, "bg-surface");
      for (const tone of ['ok', 'err', 'warn'] as const) {
        const ink = color(t, tone);
        const c = contrast(ink, over(ink, tints[tone]!, surface));
        expect(c, `${theme} .ui-badge.${tone} = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
      const infoInk = color(t, 'primary-strong');
      const cInfo = contrast(infoInk, over(infoInk, tints.info!, surface));
      expect(cInfo, `${theme} .ui-badge.info/.cfg = ${cInfo.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
    const dim = contrast(color(nebula, 'text-3'), color(nebula, 'bg-hover'));
    expect(dim, `.ui-badge.dim = ${dim.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });

  it('⑤ 能力标签色相：暗底/亮底两档都 ≥ 4.5（新增色相类必须两档同加）', () => {
    const NL = String.fromCharCode(10);
    const isIdentChar = (c: string): boolean => /[A-Za-z0-9-]/.test(c);
    const ident = (s: string, from: number): string => {
      let i = from;
      let out = '';
      while (i < s.length && isIdentChar(s[i]!)) { out += s[i]; i += 1; }
      return out;
    };
    /** 逐行取 .tt-x 的 --tag-hue / --tag-hue-rgb（前缀区分暗底 / 亮底两档） */
    const parse = (prefix: string) => {
      const map = new Map<string, { ink: string; triple: string }>();
      for (const raw of badgeCss.split(NL)) {
        const line = raw.trim();
        if (!line.startsWith(prefix + '.tt-')) continue;
        const cls = ident(line, prefix.length + 4);
        if (!cls || !line.includes('--tag-hue:')) continue; // 跳过注释里以 .tt-* 起头的续行
        const read = (prop: string): string => {
          const i = line.indexOf(prop + ':');
          if (i < 0) return '';
          return line.slice(i + prop.length + 1).split(';')[0]!.trim();
        };
        map.set(cls, { ink: read('--tag-hue'), triple: read('--tag-hue-rgb') });
      }
      return map;
    };
    const dark = parse('');
    const light = parse("html[data-theme='aurora'] ");
    expect(dark.size, '暗底色相档数').toBeGreaterThanOrEqual(9);
    expect([...light.keys()].sort(), '亮底必须逐类给档（继承暗底色相必不达标）').toEqual([...dark.keys()].sort());
    /** 标签底色 tint 透明度：从 .ui-badge.tag 配方读，避免测试与配方漂移 */
    const tagIdx = badgeCss.indexOf('.ui-badge.tag');
    const tagSeg = badgeCss.slice(tagIdx, badgeCss.indexOf('}', tagIdx));
    const rIdx = tagSeg.indexOf('rgba(var(--tag-hue-rgb');
    const alpha = rIdx < 0 ? 0.08 : Number(tagSeg.slice(rIdx).split('), ')[1]?.split(')')[0] ?? 0.08) || 0.08;
    /** 色相可写 var(--token) 或 hex；顺手锁「色值与伴随三元组同步」 */
    const themeTok = (t: Record<string, string>, spec: string): string => {
      const s = spec.trim();
      if (!s.startsWith('var(--')) return s;
      const name = s.slice(6, s.indexOf(')'));
      const v = t[name];
      if (!v) throw new Error('主题块缺 --' + name);
      return v;
    };
    for (const [theme, t, map] of [['nebula', nebula, dark], ['aurora', aurora, light]] as const) {
      const surface = color(t, 'bg-surface');
      for (const [cls, spec] of map) {
        const rgb = hexToRgb(themeTok(t, spec.ink));
        const triple = themeTok(t, spec.triple).split(' ').join('');
        expect(triple, '色相与三元组不同步：' + cls + ' ' + spec.ink).toBe(rgb.join(','));
        const c = contrast(rgb, over(rgb, alpha, surface));
        expect(c, theme + ' .tt-' + cls + ' = ' + c.toFixed(2)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('⑥ 开关：开/关两态与页面底色、以及两态之间都可辨（≥3 / ≥1.5 / ≥3）', () => {
    const offAlpha = Number(/rgba\(var\(--text-3-rgb\),\s*([\d.]+)\)/.exec(rowCss)?.[1] ?? 0.35);
    for (const theme of ['nebula', 'aurora'] as const) {
      const t = theme === 'nebula' ? nebula : aurora;
      const page = color(t, "bg-base");
      const on = color(t, 'primary');
      const off = over(color(t, 'text-3'), offAlpha, page);
      const a = contrast(on, page);
      const b = contrast(off, page);
      const c = contrast(on, off);
      expect(a, `${theme} 开态 vs 页面 = ${a.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      expect(b, `${theme} 关态 vs 页面 = ${b.toFixed(2)}`).toBeGreaterThanOrEqual(1.5);
      expect(c, `${theme} 开 vs 关 = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('⑦ 星色板：8 色 + 用户色在其 tint 底上 ≥ 4.5（首字 / 图标）', () => {
    const alpha = Number(/rgba\(var\(--sc-rgb[^)]*\),\s*([\d.]+)\)/.exec(starAvatar)?.[1] ?? 0.14);
    const entries = [...starColorTs.matchAll(/\{ nebula: '(#[0-9a-fA-F]{3,8})', aurora: '(#[0-9a-fA-F]{3,8})', label: '([^']+)' \}/g)];
    expect(entries.length, '星板条目数（8 色 + 用户色）').toBe(9);
    for (const [, neb, aur, label] of entries) {
      for (const [theme, t, hex] of [['nebula', nebula, neb!], ['aurora', aurora, aur!]] as const) {
        const ink = hexToRgb(hex);
        const bg = over(ink, alpha, color(t, "bg-surface"));
        const c = contrast(ink, bg);
        expect(c, `${theme} 星色「${label}」${hex} = ${c.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

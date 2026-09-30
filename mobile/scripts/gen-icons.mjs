// ============================================================
// gen-icons.mjs —— 安卓图标资产单源生成（cr-43 ①）
//
// 从 src/webui/public/logo.svg 派生安卓全套图标资产：
//   · ic_launcher{,_round}.png     各密度（48 基准）——整标直出
//   · ic_launcher_foreground.png   各密度（108dp 基准）——前景层（logo 66% 居中，透明底）
//   · splash_logo.png              各密度（透明底 logo+品牌字卡片）——layer-list 的等比居中层
//   · drawable/splash.xml          layer-list（渐变 shape 铺满 + bitmap 居中）——
//                                  cr-57：全幅位图做窗口背景必然被拉伸失真（屏比
//                                  千差万别），拆「底色 + 独立居中图」任意屏比不变形
//   · values/ic_launcher_background.xml 底色（logo 渐变顶色）
//
// 光栅化 = @resvg/resvg-js（仓库根 devDependency；SVG 组装后按目标尺寸渲染）。
// 用法：node mobile/scripts/gen-icons.mjs
// ============================================================
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const logoSvg = readFileSync(join(repo, 'src/webui/public/logo.svg'), 'utf8');
const resDir = join(repo, 'mobile/app/android/app/src/main/res');

// ---- 尺寸表（与 Capacitor 脚手架 res 同构——直接替换产物） ----
const DENSITIES = [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]];
const BASE_ICON = 48;
const BASE_FG = 108;
// splash 居中卡片（cr-57）：宽 = 竖屏基准 320（铺不满也不裁——bitmap 层 gravity=center），
// 高按内容（logo 30% + 品牌字距）；横竖共用一张（layer-list 不关心方向）
const SPLASH_CARD = { w: 320, h: 480 };

// logo 渐变底首末停色（launcher 底色 / splash 底同源）
const BG_TOP = '#141E45';
const BG_BOTTOM = '#2E3E70';
const BRAND = '#FBF3E6';

// logo.svg 内部（viewBox 512；含圆角矩形底 + 主图形）
const LOGO_INNER = logoSvg
  .replace(/<\?xml[^>]*\?>/, '')
  .replace(/<svg[^>]*>/, '')
  .replace('</svg>', '');

function render(svgBody, w, h, outPng) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' + svgBody + '</svg>';
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: w } }).render().asPng();
  writeFileSync(outPng, png);
}

/** 整标（launcher）：渐变底 + logo 铺满（logo 自带圆角底，视觉即方形徽章） */
function iconSvg(size) {
  return '<g>' + LOGO_INNER.replaceAll('<svg', '<unusedsvg') + '</g>'; // placeholder
}

// ↑ 上函数弃用——直接组装：logo 整体缩放到目标尺寸即可（内含底与圆角）
function scaleLogo(size) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 512 512">' + LOGO_INNER + '</svg>';
}

function renderScaled(size, outPng) {
  const png = new Resvg(scaleLogo(size), { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(outPng, png);
}

/** 前景层（adaptive foreground）：透明底 + logo 66% 居中（自适应安全区 66/108） */
function fgSvg(size) {
  const inner = size * (66 / 108);
  const off = (size - inner) / 2;
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">'
    + '<g transform="translate(' + off + ' ' + off + ') scale(' + (inner / 512) + ')">' + LOGO_INNER + '</g>'
    + '</svg>';
}

/**
 * 启动图居中卡片（cr-57）：透明底 + logo + 品牌字。渐变底由 layer-list 的
 * shape 层承担（可无损拉伸），本图只做等比居中内容——任意屏比不变形。
 */
function splashCardSvg(w, h) {
  const size = Math.min(w, h) * 0.42;
  const off = (w - size) / 2;
  const fs = Math.max(16, Math.round(Math.min(w, h) * 0.055));
  const textY = h / 2 + size / 2 + fs * 1.4;
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">'
    + '<g transform="translate(' + off + ' ' + (h / 2 - size / 2 - fs * 0.4) + ') scale(' + (size / 512) + ')">' + LOGO_INNER + '</g>'
    + '<text x="' + (w / 2) + '" y="' + textY + '" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="' + fs + '" letter-spacing="1" fill="' + BRAND + '">AgentChat</text>'
    + '</svg>';
}

function place(rel, png) {
  const dst = join(resDir, rel);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, png);
}

let count = 0;
for (const [d, scale] of DENSITIES) {
  const s = Math.round(BASE_ICON * scale);
  const f = Math.round(BASE_FG * scale);
  const icon = new Resvg(scaleLogo(s), { fitTo: { mode: 'width', value: s } }).render().asPng();
  const fg = new Resvg(fgSvg(f), { fitTo: { mode: 'width', value: f } }).render().asPng();
  const cw = Math.round(SPLASH_CARD.w * scale);
  const ch = Math.round(SPLASH_CARD.h * scale);
  const card = new Resvg(splashCardSvg(cw, ch), { fitTo: { mode: 'width', value: cw } }).render().asPng();
  place('mipmap-' + d + '/ic_launcher.png', icon);
  place('mipmap-' + d + '/ic_launcher_round.png', icon);
  place('mipmap-' + d + '/ic_launcher_foreground.png', fg);
  place('drawable-' + d + '/splash_logo.png', card);
  count += 4;
  console.log('[gen-icons] ' + d + ' ok');
}

// layer-list：渐变 shape（可无损拉伸）+ splash_logo 等比居中（cr-57 替代全幅
// 位图——窗口背景拉伸下 logo 不再失真）。bitmap 引用走资源系统密度自适应，
// 不需要 -port/-land 变体（居中与方向无关）。
place('drawable/splash.xml', [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<layer-list xmlns:android="http://schemas.android.com/apk/res/android">',
  '    <item android:drawable="@drawable/splash_bg"/>',
  '    <item>',
  '        <bitmap android:gravity="center" android:src="@drawable/splash_logo"/>',
  '    </item>',
  '</layer-list>',
  '',
].join('\n'));
place('drawable/splash_bg.xml', [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<shape xmlns:android="http://schemas.android.com/apk/res/android">',
  '    <gradient android:angle="270" android:startColor="' + BG_TOP + '" android:endColor="' + BG_BOTTOM + '"/>',
  '</shape>',
  '',
].join('\n'));
count += 2;

writeFileSync(
  join(resDir, 'values/ic_launcher_background.xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#141E45</color>\n</resources>\n',
);

console.log('[gen-icons] ' + count + ' 个资产已落盘 → ' + resDir);

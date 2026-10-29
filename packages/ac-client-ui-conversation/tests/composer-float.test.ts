// ============================================================
// composer-float.test.ts —— composer 浮层栈布局契约（cr-778）
// 根因：dock 列与输入区原与消息区同处 chat-main 的 flex 列，三者抢同一份
// 高度——消息区底边被物理截断在 dock 上缘，透明与否都改不了「像被遮挡」。
// 修复 = composer 栈脱流贴底，消息区全高 + 实测底部内边距。本测试锁死
// 这条链路的四个关键环节（纯源码契约：布局量不到，断了就是肉眼才发现的回归）:
//   ① chat-main 必须是浮层的定位锚（position: relative + min-height: 0）
//   ② 栈 absolute 贴底 + 恒在消息之上（z-index）
//   ③ 消息区底部内边距吃 --composer-inset（否则最后一条被永久压住）
//   ④ 回到底部按钮同步抬升（否则被浮层盖住点不到）
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const view = readFileSync(join(here, '../client/ConversationView.vue'), 'utf8');
const transcript = readFileSync(join(here, '../client/TranscriptList.vue'), 'utf8');

describe('composer 浮层栈（cr-778）', () => {
  it('chat-main 是浮层定位锚：relative + min-height:0（防 flex 撑高把栈锚到视口外）', () => {
    const rule = view.match(/\.chat-main\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('position: relative');
    expect(rule).toContain('min-height: 0');
  });

  it('栈绝对定位贴底且恒在消息之上', () => {
    const rule = view.match(/\.composer-stack\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('position: absolute');
    expect(rule).toContain('bottom: 0');
    expect(rule).toMatch(/z-index:\s*\d+/);
  });

  it('栈顶不留渐隐带（cr-788：消息真从 dock 背后经过，带子会成空洞）', () => {
    expect(view).not.toMatch(/\.composer-stack::before\s*\{[^}]*linear-gradient/);
    expect(view).not.toContain('.composer-input::before');
  });

  it('可视区裁剪在浮层顶缘（cr-785：wrapper 吃 padding-bottom = 栈高）', () => {
    // container 的 height:100% 相对 wrapper 的 content box —— wrapper 一加
    // padding-bottom，可视高度就减掉浮层那段：滚到底时最后一条停在浮层上方，
    // 内容不在输入区背后继续移动。
    expect(transcript).toContain(':style="wrapperStyle"');
    expect(transcript).toMatch(/paddingBottom: `\$\{props\.bottomInset\}px`/);
    const wrapper = transcript.match(/\.messages-wrapper\s*\{[^}]*\}/)?.[0] ?? '';
    expect(wrapper).toContain('overflow: hidden');
  });

  it('尾部 spacer 高度 = bottomTail + --composer-extra（cr-797）', () => {
    // 可视区底边压在输入卡上缘再往下 overlap（浮层观感），所以滚到底时内容
    // 会落进 composer 栈里。bottomTail = 宿主实测「输入卡上缘 − 栈顶 + overlap」，
    // dock 列有几张卡、多高都算在内——最后一条因此恒停在栈顶之上。
    expect(transcript).toContain('class="composer-spacer"');
    expect(transcript).toContain('calc(${bottomTail}px + var(--composer-extra, 0px))');
    // 滚动容器自身不带 inset padding（留白不在它身上）
    const container = transcript.match(/\.messages-container\s*\{[^}]*\}/)?.[0] ?? '';
    expect(container).not.toContain('--composer-inset');
  });

  it('--composer-extra 有默认值落点（不是只有 var() 兜底的悬空引用）', () => {
    // cr-796：变量在应用布局令牌里有声明（可见、可被主题包/内联覆盖），
    // 消费点的第二参只是给「别的宿主装配」兜底。
    const mainCss = readFileSync(join(here, '../../../apps/ui/src/assets/main.css'), 'utf8');
    expect(mainCss).toContain('--composer-extra: 0px');
    // 默认值必须在 :root 层（@layer design-tokens 内），不能声明在近祖先——
    // 否则会盖掉 :root 上的用户覆盖，令牌「改了没反应」
    const layerBlock = mainCss.slice(mainCss.indexOf('@layer design-tokens'));
    expect(layerBlock).toContain('--composer-extra: 0px');
  });

  it('尾部留白含 dock 高度：宿主实测 输入卡上缘 − 栈顶 + 重叠（cr-797）', () => {
    // 只算 overlap 不算 dock 高度 = dock 列越高、被盖得越多（用户实测反馈）。
    expect(view).toContain(':bottom-tail="composerTail"');
    expect(transcript).toContain('bottomTail: number');
    // 两个量取自同一份实测：inset 决定浮多深、tail 决定滚到底停在哪
    expect(view).toContain('inputTop - stackRect.top + COMPOSER_OVERLAP');
    expect(view).toContain('stackRect.bottom - inputTop - COMPOSER_OVERLAP');
  });

  it('回到底部按钮抬到栈顶之上（inset + tail = 栈高，cr-797）', () => {
    // 只抬 bottomInset 的话按钮落在「输入卡上缘 + overlap」那条带里，
    // 正好被 dock 列 / 输入卡盖住——两者相加才是栈顶。
    expect(transcript).toContain('bottom: 12 + bottomInset + bottomTail');
  });

  it('可视区底边实测后经 prop 传给消息区（输入卡高度可变）', () => {
    expect(view).toContain('new ResizeObserver');
    expect(view).toContain(':bottom-inset="composerInset"');
  });

  it('底边界 = 输入卡上缘再下沉 COMPOSER_OVERLAP（cr-788：真浮层但不穿透输入卡）', () => {
    // 量的不是整栈高：dock 列要真浮在消息上方（消息从状态行背后经过），
    // 但消息不能完全穿过输入卡——只在上缘露出一条。
    expect(view).toMatch(/const COMPOSER_OVERLAP = \d+;/);
    expect(view).toContain('getBoundingClientRect().top');
    expect(view).toContain('stackRect.bottom - inputTop - COMPOSER_OVERLAP');
    // 基准取自输入卡元素（cardEl——cr-789：多根 fragment 组件 $el 是文本锚点，
    // 曾经因此 getBoundingClientRect 崩溃退位 root 席），不是栈
    expect(view).toContain('composerInput.value?.cardEl');
  });

  it('测高有视口 resize 兜底（dock 卡换行等 RO 未必捕获的抖动）', () => {
    expect(view).toContain("window.addEventListener('resize'");
  });
});

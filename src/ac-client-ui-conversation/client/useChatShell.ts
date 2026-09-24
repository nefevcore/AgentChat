// ============================================================
// client/useChatShell.ts —— 会话视图外壳（滚动/自动跟随/回到底部；M27.2-2 视图半边自 webui composables/ 迁入）
//
// 统一 ChatView(direct) 与 GroupChat(group) 的滚动行为：
//   · 方向检测暂停自动跟随（一次上滚即可脱离，无需滚多次）
//   · 滚底引擎：追赶段用 rAF 指数缓动（平滑滑向底部，不再 scrollTop
//     瞬移跳变）；贴底后逐帧吸收流式增量（增量在折叠线以下生长，
//     视口视觉静止 = 「驻留底部」）
//   · 程序滚动对账（expectedScrollTop）：自身写入与用户滚动严格区分——
//     自身滚动的 scroll 回声绝不参与方向判定（不会把 isUserScrolledUp
//     洗回 false），用户上滚在帧粒度即可察觉（不等 scroll 事件回主线程）
//     → 流式期间轻轻一滚即脱离，且绝不再被拉回；回到底部（<80px）自动恢复驻留
//   · 顶部阈值回调（触发历史加载由调用方按模式实现）
// ============================================================

import { onScopeDispose, ref, watch, type Ref } from 'vue';

interface ChatShellOptions {
  /** 消息滚动容器 ref */
  container: Ref<HTMLElement | undefined>;
  /** 滚动到顶部阈值时回调（调用方按 direct/group 触发历史加载） */
  onTopThreshold: () => void;
  /** 数据变化信号：[消息总数, 流式尾部长度]，变化时若非用户上翻则自动滚底 */
  signal: () => readonly [number, number];
}

/** 距底阈值（px）：少于该值视为「在底部」，自动跟随驻留/恢复 */
const BOTTOM_EPS = 80;
/** 缓动时间常数（ms）：指数追赶的速度衰减；~3τ（240ms）追平 95% */
const GLIDE_TAU = 80;
/** 缓动兜底超时（ms）：目标持续增长等极端情况下强制收尾贴底 */
const GLIDE_TIMEOUT = 800;
/** 跟随引擎静默退出（ms）：流式停歇且已贴底后，空转片刻即停机（省电） */
const FOLLOW_IDLE_MS = 1200;
/** 帧级用户上滚察觉的容差（px）：忽略 1px 级触控板/亚像素噪声 */
const USER_DELTA_EPS = 2;
/** 远距直达阈值：距底超过 max(1200px, 4×视口高)（如切换会话/首载历史）
 *  时直接贴底不缓动——超远距离的"扫屏式滑过"不可读且易晕，瞬达才是
 *  上下文切换的预期语义；常规距离（发送/回到底部/流式追赶）仍平滑缓动 */
function snapDistance(el: HTMLElement): number {
  return Math.max(1200, el.clientHeight * 4);
}

export function useChatShell(opts: ChatShellOptions) {
  const isUserScrolledUp = ref(false);
  let lastScrollTop = 0;
  /** 上次 scroll 事件的 scrollHeight（内容塌缩检测——见 onScroll 豁免） */
  let lastScrollHeight = 0;
  let scrollScheduled = false;

  // ── 程序滚动对账：最近一次「已记账」的 scrollTop ──
  // 程序写入 scrollTop 后立即回读记账；scroll 事件是异步派发的，事件到来
  // 时与记账值相等 → 是自身写入的回声，不参与方向判定（布尔标记不可靠：
  // 事件到达时同步标记早已复位，按值对账才可靠）。用户滚动同样记账，
  // 作为跟随引擎帧级判定的基线。
  let expectedScrollTop = NaN;

  // ── 跟随引擎（单 rAF 循环；gliding = 指数缓动追赶，false = 贴底吸附）──
  let followRaf = 0;
  let gliding = false;
  let glideT0 = 0;
  let glideY = 0;
  let glideT = 0;
  let lastActivity = 0;

  function isAtBottomEl(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_EPS;
  }

  /** 判断滚动条是否接近底部（阈值 80px，容纳流式输出时的高度跳动） */
  function isNearBottom(): boolean {
    const el = opts.container.value;
    if (!el) return true;
    return isAtBottomEl(el);
  }

  /** 程序写 scrollTop（写后回读实际值记账——浏览器可能按最大滚动值钳制） */
  function writeScrollTop(el: HTMLElement, y: number): number {
    el.scrollTop = y;
    const actual = el.scrollTop;
    expectedScrollTop = actual;
    lastScrollTop = actual;
    return actual;
  }

  function stopFollow() {
    if (followRaf) cancelAnimationFrame(followRaf);
    followRaf = 0;
    gliding = false;
  }

  /** 跟随引擎心跳（每帧一次）：
   *  ① 用户上滚察觉：scrollTop 低于记账基线且未贴着最大滚动值 → 用户在
   *     向上滚 → 立即停机让位（帧粒度秒退，不等 scroll 事件回主线程，
   *     绝不与用户争抢滚动条；「恰在最大值」排除内容收缩导致的浏览器钳制）；
   *  ② 缓动段：向实时底部指数逼近（目标随流式增长持续更新，速度随距离
   *     衰减 → 末端平滑收敛，全程无跳变）；用户向下滚时从用户位置续接；
   *  ③ 贴底段：直接吸收流式增量（增量位于折叠线以下，写入不产生视觉
   *     位移 = 视口钉在底部）；
   *  ④ 静默退出：流式停歇且已贴底 → 空转 FOLLOW_IDLE_MS 后停机。 */
  function followTick() {
    const el = opts.container.value;
    if (!el) { stopFollow(); return; }

    // 容器隐藏（display:none：scrollHeight/clientHeight 归零）：不写
    // scrollTop（避免位置被清零），停机等重新可见
    if (!el.clientHeight && !el.scrollHeight) { stopFollow(); return; }

    const now = performance.now();
    const cur = el.scrollTop;
    const target = el.scrollHeight - el.clientHeight;

    // 内容塌缩帧豁免（同 onScroll：重建/合并期的高度塌缩不是用户滚动；
    // target 随 scrollHeight 变化，此处只更新基线继续跟随，不判上翻。
    // 只豁免塌缩——流式增长帧须保留上翻察觉）
    if (el.scrollHeight < lastScrollHeight) {
      lastScrollHeight = el.scrollHeight;
      expectedScrollTop = cur; // 重新对账（避免旧 max 基线误伤后续帧）
    }

    // 用户上滚察觉（低于记账基线超容差，且并非贴最大值的收缩钳制）
    if (cur < expectedScrollTop - USER_DELTA_EPS && cur < target - USER_DELTA_EPS) {
      isUserScrolledUp.value = true;
      stopFollow();
      return;
    }
    if (isUserScrolledUp.value) { stopFollow(); return; }

    if (gliding) {
      // 用户向下助力（滚到了缓动起点之下）→ 从用户当前位置续接缓动
      if (cur > glideY + 0.5) glideY = cur;
      const dt = Math.max(1, now - glideT);
      let y = glideY + (target - glideY) * (1 - Math.exp(-dt / GLIDE_TAU));
      if (y > target) y = target;
      glideY = writeScrollTop(el, y);
      glideT = now;
      if (target - glideY <= 1 || now - glideT0 > GLIDE_TIMEOUT) {
        gliding = false;
        writeScrollTop(el, target); // 收尾精确贴底
      }
    } else if (el.scrollTop !== target) {
      // 贴底吸收：任何流式增量（折叠线以下生长）直接同步，视口视觉静止
      writeScrollTop(el, target);
    }

    if (!gliding && target - el.scrollTop <= 0.5 && now - lastActivity > FOLLOW_IDLE_MS) {
      followRaf = 0; // 贴底且静默 → 停机（下次 signal 变化会重新拉起）
      return;
    }
    followRaf = requestAnimationFrame(followTick);
  }

  /** 确保跟随循环在跑：不在跑则按当前距底距离选模式拉起（距底远 → 缓动
   *  追赶；已贴底 → 直接吸附吸收增量） */
  function ensureFollow() {
    if (followRaf) return;
    const el = opts.container.value;
    if (!el) return;
    const now = performance.now();
    const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
    gliding = dist > 1;
    glideT0 = now;
    glideY = el.scrollTop;
    glideT = now;
    followRaf = requestAnimationFrame(followTick);
  }

  /** 滚动到底部：恢复自动跟随并平滑缓动下去（发送消息/切换会话/首载完成）。
   *  距底超远（切换会话/首载跨几十屏）时直接贴底——超远距离的「扫屏式滑
   *  过」不可读，瞬达才是上下文切换的预期语义；常规距离平滑缓动。
   *  forceGlide：显式操作（回到底部按钮）强制缓动——用户点了按钮，
   *  快速滑过去比瞬移更有方位感。 */
  function scrollToBottom(forceGlide = false) {
    isUserScrolledUp.value = false;
    stopFollow();
    const el = opts.container.value;
    if (!el) return;
    const now = performance.now();
    const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
    if (!forceGlide && dist > snapDistance(el)) {
      gliding = false;
      writeScrollTop(el, el.scrollHeight - el.clientHeight); // 远距直达：贴底
    } else {
      gliding = true;
      glideT0 = now;
      glideY = el.scrollTop;
      glideT = now;
    }
    lastActivity = now;
    followRaf = requestAnimationFrame(followTick);
  }

  /** 回到底部按钮：平滑滚动并恢复自动跟随（无论多远都缓动滑下） */
  function scrollToBottomAndReset() {
    scrollToBottom(true);
  }

  /** 会话切换时重置闭包状态。
   *  isUserScrolledUp / lastScrollTop 跨会话残留的坑：新会话内容不足一屏时
   *  scrollTop 赋值无变化 → 浏览器不派发 scroll 事件 → atBottom 恢复逻辑
   *  永远执行不到 → 流式消息不自动滚底 + 悬浮"回到底部"按钮 + 首次滚动
   *  方向误判（旧实现 ChatView 切换时显式重置，迁移到 DialogView 时丢失）。 */
  function reset() {
    isUserScrolledUp.value = false;
    lastScrollTop = 0;
    lastScrollHeight = 0; // 高度基线同步重置（新会话首帧必然「高度变化」→ 豁免方向判定）
    expectedScrollTop = NaN;
    stopFollow();
  }

  /** 用户滚动：方向检测暂停自动跟随；回到底部恢复；顶部触发历史加载 */
  function onScroll() {
    const el = opts.container.value;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;

    // 自身程序滚动的回声（或恰停在记账位置）：不参与方向判定；
    // 仅当已在底部时顺带恢复驻留标志
    if (Math.abs(scrollTop - expectedScrollTop) < 0.5) {
      if (scrollHeight - scrollTop - clientHeight < BOTTOM_EPS) {
        isUserScrolledUp.value = false;
      }
      lastScrollTop = scrollTop;
      lastScrollHeight = scrollHeight;
      return;
    }

    // 内容塌缩帧豁免（2026-12 切换停中修复）：历史合并/组件树重建
    // （首屏替换、窗口化重挂）会令 scrollHeight 塌缩再回升，浏览器随之
    // 钳制 scrollTop——这不是用户滚动。此帧只对账基线，不做方向判定
    //（否则钳制被误判上翻 → 杀自动跟随 + 触发上翻分帧 → 视口钉在会话中部）。
    // 只豁免塌缩（scrollHeight 变小）：流式增长帧是常态，若一并豁免，
    // 增长期的用户上滚会被吞（自动跟随把视口反复拉回底部）。
    if (scrollHeight < lastScrollHeight) {
      lastScrollTop = scrollTop;
      lastScrollHeight = scrollHeight;
      expectedScrollTop = scrollTop;
      return;
    }

    const dist = scrollHeight - scrollTop - clientHeight;
    const atBottom = dist < BOTTOM_EPS;

    // 向上滚动（scrollTop 减小）→ 立即暂停自动跟随；回到底部 → 恢复。
    // 「恰好钳在最大滚动值」是内容收缩（如思考块折叠）引发的浏览器钳制，
    // 不是用户操作，不得误判为上翻（否则会凭空弹出「回到底部」按钮并
    // 杀死自动跟随）。
    if (scrollTop < lastScrollTop - 1 && dist > USER_DELTA_EPS) {
      isUserScrolledUp.value = true;
    } else if (atBottom) {
      isUserScrolledUp.value = false;
    }
    lastScrollTop = scrollTop;
    lastScrollHeight = scrollHeight;
    expectedScrollTop = scrollTop; // 用户滚动也记账，作为引擎帧级判定基线

    if (scrollTop <= 50) {
      opts.onTopThreshold();
    }
  }

  /** 自动跟随：按帧合并（同一帧多次流式更新只触发一次），尊重用户上翻 */
  function scheduleAutoScroll() {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(() => {
      scrollScheduled = false;
      lastActivity = performance.now();
      if (!isUserScrolledUp.value) ensureFollow();
    });
  }

  watch(() => opts.signal(), () => scheduleAutoScroll());

  // 组件卸载/作用域销毁：停掉跟随循环（rAF 不再触达已卸载容器）
  onScopeDispose(stopFollow);

  return {
    isUserScrolledUp,
    isNearBottom,
    scrollToBottom,
    scrollToBottomAndReset,
    reset,
    onScroll,
  };
}

// ============================================================
// ac-client-ui-conversation/client/viewParking.ts —— 视图停靠
//（session-cache-and-frame-ordering-plan A1）
//
// 会话级滚动/折叠视图位（模块级单例——生命周期独立于组件实例，模式照抄
// draftParking.ts）。背景：数据层多会话保留（dialogs 字典常驻、切走期间
// WS 直播帧持续路由进后台分区），但视图状态切走即丢——切回恒滚底、手动
// 展开的思维链弹回默认折叠。停靠语义：
//   · 切走时泊位：滚动锚点（视口顶部可见条目的 data-item-key）+ 像素
//     scrollTop + 消息条数；
//   · 切回时复位：仅当「切走期间无新消息」（泊位 msgCount === 当前分区
//     条数——fingerprint unchanged 短路的视图侧等价判据：后台分区若收到
//     直播帧，条数已变）才 reveal 原位复位；有新内容则滚底读新。
// 思维链折叠位独立停靠：TurnDisplayItem 的 isExpanded 是组件本地 ref，
// 重挂载即回默认——noteChainExpanded 登记用户手动切换，chainExpandInit
// 挂载时取回（缺席回落调用方默认值）。轮 key 全局唯一（turn-<agent>-<ts>）
// ——链折叠位不按会话分段，超上限 LRU 淘汰。
// 仅内存层（视图位不跨重启——重启预热属 A4，另行设计）。
// ============================================================

/** 停靠位上限（会话数；LRU 淘汰最旧——对齐 A2 热集规模的保守上界） */
const MAX_PARKED = 60;
/** 思维链折叠登记上限（轮数；超限删最旧） */
const MAX_CHAIN = 500;

/** 泊位（滚动锚 + 消息水位） */
export interface ParkedView {
  /** 视口顶部可见条目的 data-item-key（reveal 定位锚） */
  anchorKey: string;
  /** 像素 scrollTop（reveal 只保证条目入屏——随后按此精确复位） */
  scrollTop: number;
  /** 泊位时刻分区消息条数（切回比对：相等 = 切走期间无新消息） */
  msgCount: number;
}

const parkedViews = new Map<string, ParkedView>();

/** 泊位（重插尾部 = LRU 新鲜度） */
export function parkView(dialogId: string, v: ParkedView): void {
  parkedViews.delete(dialogId);
  parkedViews.set(dialogId, v);
  if (parkedViews.size > MAX_PARKED) {
    const oldest = parkedViews.keys().next().value;
    if (oldest !== undefined) parkedViews.delete(oldest);
  }
}

/** 取泊位（不消费——切回多次取同值；无泊位 = undefined） */
export function takeParkedView(dialogId: string): ParkedView | undefined {
  return parkedViews.get(dialogId);
}

/** 清泊位（容器缺席等无法捕获锚点的场合——不驻留过期位） */
export function clearParkedView(dialogId: string): void {
  parkedViews.delete(dialogId);
}

/**
 * 从滚动容器捕获当前视口锚点（切走时刻调用——DOM 仍是旧会话内容）。
 * 锚 = 首个底边越过视口顶的条目（顶部可见者）；窗口化渲染下窗口外条目
 * 无 DOM，锚必然在已挂窗口内（视口内的都在窗口内）。无条目 = null。
 */
export function captureViewAnchor(container: HTMLElement): { anchorKey: string; scrollTop: number } | null {
  const box = container.getBoundingClientRect();
  const els = Array.from(container.querySelectorAll<HTMLElement>('[data-item-key]'));
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.bottom > box.top + 1) {
      const key = el.dataset.itemKey;
      if (key) return { anchorKey: key, scrollTop: container.scrollTop };
    }
  }
  return null;
}

// ── 思维链折叠位（轮 key → 用户手动切换后的值）──

const chainExpanded = new Map<string, boolean>();

/** 登记用户手动切换的链折叠态 */
export function noteChainExpanded(turnKey: string, expanded: boolean): void {
  chainExpanded.delete(turnKey);
  chainExpanded.set(turnKey, expanded);
  if (chainExpanded.size > MAX_CHAIN) {
    const oldest = chainExpanded.keys().next().value;
    if (oldest !== undefined) chainExpanded.delete(oldest);
  }
}

/** 挂载时取回折叠态（无登记回落调用方默认：流式轮展开/历史轮折叠） */
export function chainExpandInit(turnKey: string, fallback: boolean): boolean {
  return chainExpanded.get(turnKey) ?? fallback;
}

/** 测试面：清空两层（测试隔离用） */
export function __clearViewParkingForTest(): void {
  parkedViews.clear();
  chainExpanded.clear();
}

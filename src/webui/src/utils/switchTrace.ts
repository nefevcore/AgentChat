// ============================================================
// switchTrace —— 会话切换 / 历史加载全链路时间戳追踪（诊断用）
//
// 背景：偶发"点击其他 Agent 后界面几秒无变化 → 才出现加载中 →
// 再过几秒才渲染"与"切换完成后才出现加载中"。本工具在每个关键
// 节点打印毫秒级时间戳，用于定位卡顿段。
//
// 输出（浏览器 console，蓝色 [switch] 前缀，不受 LOG_LEVEL 影响）：
//   [switch] +123456ms <event> <detail>
//   <ms> = performance.now()（相对页面加载；同一时间线内可直接相减）
//
// 事件链（一次正常切换）：
//   click-agent/click-single      用户点击列表项
//   active-id                     agentStore.activeAgentId 赋值后（应≈click 同刻）
//   view-watch                    DialogView 的 activeAgentId/single watch 触发
//   req                           feed.loadHistory 发出 WS history.request（含 requestId）
//     ↳ click→req 差 = 主线程阻塞时长（应 <50ms；大 = 有东西占着主线程）
//   resp                          history.response 到达（含 stale 判定与往返耗时）
//     ↳ req→resp 差 = 后端查询 + WS 往返
//   merge                         mergeHistory 完成分区数据替换
//   loading(false)                loadingHistory 翻 false（加载指示器应消失）
//   dom-updated                   nextTick 后（界面实际完成切换的时刻）
//   load-more                     自动续拉触发（内容不满一屏且 hasMore；这就是
//                                 "切换成功后又出现加载中"的来源之一）
//   req-more / resp               续拉的请求与响应
// ============================================================

export function traceSwitch(evt: string, detail?: unknown): void {
  const t = performance.now().toFixed(0).padStart(7, ' ');
  // eslint-disable-next-line no-console
  console.log(`%c[switch]%c +${t}ms ${evt}`, 'color:#58a6ff;font-weight:600', 'color:inherit;color:#58a6ff', detail ?? '');
}

/** 历史请求发出时刻（requestId → performance.now()；resp 计算往返耗时用） */
export const histReqSentAt = new Map<string, number>();

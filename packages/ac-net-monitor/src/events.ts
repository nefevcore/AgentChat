// ============================================================
// ac-net-monitor/src/events.ts —— net/* 事件目录（emit，shell 域）
//
// 谁 emit 谁声明：net/status、net/online、net/offline 的分发方是
// 本包的 NetMonitorService；消费方 import type {} from 'ac-net-monitor'
// 即获得事件类型增强。纯通知（观察归 after/emit）——订阅方：日志、
// 诊断面、未来的 WebUI 徽章。
// ============================================================
import type {} from '@agentchat/cordis';
import type { NetMonitorSnapshot } from './service.ts';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 网络状态翻转（online ⇄ offline）。
     * @mode emit @scope run
     * 载荷：翻转后快照（含 since/interfaces/reason）。
     */
    'net/status'(snapshot: NetMonitorSnapshot): void;
    /** 网络恢复（offline → online）。@mode emit @scope run */
    'net/online'(snapshot: NetMonitorSnapshot): void;
    /** 网络断开（online → offline）。@mode emit @scope run */
    'net/offline'(snapshot: NetMonitorSnapshot): void;
  }
}
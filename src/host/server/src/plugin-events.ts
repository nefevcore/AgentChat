// ============================================================
// @agentchat/server/src/plugin-events.ts —— 插件域 WS 事件总线
//
// PluginHost（@agentchat/plugins）只发事件，不知道传输层；
// bootstrap 用 attachEventSink 把事件汇聚到这里，WebUIServer 再把
// 总线交给 WSHandler 订阅，最终经现有 message 通道广播给所有客户端。
// ============================================================
import { EventEmitter } from 'events';
import type { PluginEventMap, PluginEventName } from '@agentchat/protocol';

export class PluginEventBus {
  private emitter = new EventEmitter();

  /** 发射插件域事件（PluginHost / PluginManager 调用） */
  emitEvent<K extends PluginEventName>(type: K, data: PluginEventMap[K]): void {
    this.emitter.emit(type, data);
  }

  /** 订阅插件域事件；返回 disposer（WSHandler stop 时撤销） */
  on<K extends PluginEventName>(type: K, handler: (data: PluginEventMap[K]) => void): () => void {
    const listener = (data: PluginEventMap[K]) => handler(data);
    this.emitter.on(type, listener);
    return () => {
      this.emitter.off(type, listener);
    };
  }
}

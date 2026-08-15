// ============================================================
// WebSocket Store —— 连接管理与消息收发
// ============================================================

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { WebSocketClient, type MessageHandler, type ConnectHandler } from '../services/websocket';

export const useWebSocketStore = defineStore('websocket', () => {
  // ── State ──
  const connected = ref(false);

  let wsClient: WebSocketClient;

  function getClient(): WebSocketClient {
    return wsClient;
  }

  function init(): void {
    // 幂等：避免重复创建 WebSocketClient 导致已注册的 handler 丢失
    if (wsClient) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsClient = new WebSocketClient(`${protocol}//${location.host}/ws`);
    wsClient.onConnect(() => { connected.value = true; });
    wsClient.onDisconnect(() => { connected.value = false; });
    wsClient.connect();
  }

  function onMessage(handler: MessageHandler): () => void {
    return wsClient.onMessage(handler);
  }

  function onConnect(handler: ConnectHandler): void {
    wsClient.onConnect(handler);
  }

  function send(type: string, data: any): void {
    wsClient.send(type, data);
  }

  return { connected, init, getClient, onMessage, onConnect, send };
});

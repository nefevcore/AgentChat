// ============================================================
// stores/websocket.ts —— WS 连接状态与转发（薄封装）
// ============================================================

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { WebSocketClient, type MessageHandler, type ConnectHandler } from '@/services/websocket';

export const useWebSocketStore = defineStore('websocket', () => {
  const connected = ref(false);

  let wsClient: WebSocketClient | null = null;

  function init(): void {
    if (wsClient) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsClient = new WebSocketClient(`${protocol}//${location.host}/ws`);
    wsClient.onConnect(() => { connected.value = true; });
    wsClient.onDisconnect(() => { connected.value = false; });
    wsClient.connect();
  }

  function onMessage(handler: MessageHandler): void {
    wsClient?.onMessage(handler);
  }

  function onConnect(handler: ConnectHandler): void {
    wsClient?.onConnect(handler);
  }

  function send(type: string, data: any): void {
    wsClient?.send(type, data);
  }

  return { connected, init, onMessage, onConnect, send };
});

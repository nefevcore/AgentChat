// ============================================================
// stream.ts —— 宿主流式订阅半边（B3 旁带消费面）
//
// 宿主转发链：壳 ipc 旁带帧 → StreamTap（宿主持连接）→ 回调注入
//（ws-bridge → webui 转发面）。与 IpcClient 同走壳监听地址——差异：
// 旁带帧无请求-应答配对（不进 pending 队列），逐帧直接回调。
// ============================================================
import * as net from 'node:net';
import { FrameDecoder, isStreamFrame, type StreamFrame } from 'ac-envelope-core';

export interface StreamTapHandle {
  close(): void;
}

/**
 * 连接壳监听地址并订阅 B3 旁带帧（瞬态——连接断裂即丢，不重连：
 * 壳死即丢语义；新壳 boot.ready 后重新 tap）。
 */
export function tapShellStream(address: string, onStream: (frame: StreamFrame) => void): Promise<StreamTapHandle> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address, () => {
      resolve({ close: () => socket.destroy() });
    });
    socket.once('error', reject);
    const decoder = new FrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (isStreamFrame(frame)) onStream(frame);
      }
    });
  });
}



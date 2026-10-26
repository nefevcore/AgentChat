// ============================================================
// issue.ts —— R-1 发送方签发面
//
// uuid = 会话出生证明：首条消息的发送方生成 UUIDv7（时间有序——
// 会话列表排序 / 文件局部性友好），随首消息投递，零往返零回写。
// requestId = 投递幂等键，每封独立生成（UUIDv4 即可）。
// 「webui → 宿主代 user 签发」的物理载体（R-1 实例化清单）。
// ============================================================
import * as crypto from 'node:crypto';

/** UUIDv7（时间有序——48bit unix 毫秒 + 随机；手工构造，无外部依赖） */
export function uuidv7(): string {
  const ts = Date.now();
  const bytes = crypto.randomBytes(16);
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

/** 会话身份键签发（R-1：首条消息发送方生成，之后不变） */
export function issueConversationId(): string {
  return uuidv7();
}

/** 投递幂等键签发（每封独立） */
export function issueRequestId(): string {
  return crypto.randomUUID();
}

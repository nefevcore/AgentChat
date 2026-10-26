// ============================================================
// frame.ts —— ipc 长度前缀帧（协议规格 B2）
//
// 跨进程通道（unix socket / named pipe）帧 = 同构 JSON + 长度前缀：
//   [4 字节大端载荷长度][JSON utf8 字节]
// 载荷不限于信封——B3 流式旁带（瞬态 token 帧）同走 ipc 连接，帧层
// 只管切字节流不管语义（协议一套、通道多种；不是所有字节流都配当
// 信件，但都配走帧）。
// ============================================================

/** 帧头字节数（32-bit 大端长度前缀） */
export const FRAME_HEADER_BYTES = 4;

/** 单帧载荷上限（fail-loud 防护：超限即通道污染，抛错断连而非缓冲膨胀） */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** 编码一帧（任意 JSON 可序列化载荷） */
export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`帧载荷 ${body.length}B 超上限 ${MAX_FRAME_BYTES}B`);
  }
  const head = Buffer.alloc(FRAME_HEADER_BYTES);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** 流式解码器：喂入任意切块（粘包/半包皆可），按帧切出完整载荷 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  /** 喂入一块字节，返回其中完整帧的载荷数组（0..n 条） */
  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    for (;;) {
      if (this.buf.length < FRAME_HEADER_BYTES) break;
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        throw new Error(`帧头声明 ${len}B 超上限 ${MAX_FRAME_BYTES}B——通道污染，断连`);
      }
      if (this.buf.length < FRAME_HEADER_BYTES + len) break;
      out.push(JSON.parse(this.buf.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + len).toString('utf8')));
      this.buf = this.buf.subarray(FRAME_HEADER_BYTES + len);
    }
    return out;
  }
}

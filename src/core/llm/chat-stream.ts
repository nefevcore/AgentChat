// ============================================================
// ChatStream — 流式响应的统一抽象
//
// 灵感来自 pi-ai 的 EventStream，同时是：
//   1. AsyncIterable<StreamToken> — for await 逐 token 消费
//   2. Promise-like (.result())       — 只取最终结果
//
// 每个 StreamToken 携带 partial（到当前为止的完整累计），
// 消费者无需自己拼接 delta。
// ============================================================

import { LLMResponse, StreamToken } from '@core/types';

export { StreamToken };

export class ChatStream implements AsyncIterable<StreamToken> {
  private _queue: StreamToken[] = [];
  private _waiters: Array<() => void> = [];
  private _done = false;
  private _resultPromise: Promise<LLMResponse>;
  private _resultResolve!: (r: LLMResponse) => void;

  constructor() {
    this._resultPromise = new Promise(r => { this._resultResolve = r; });
  }

  /** 推送一个 token */
  push(token: StreamToken): void {
    if (this._done) return;
    this._queue.push(token);
    this._waiters.shift()?.();
  }

  /** 标记流结束 */
  done(result: LLMResponse): void {
    if (this._done) return;
    this._done = true;
    this._resultResolve(result);
    for (const w of this._waiters) w();
    this._waiters = [];
  }

  /**
   * 通过流协议传递错误（符合"错误进流"契约）。
   * 先推送 error token 确保 for-await 消费者能看到，再标记流结束。
   */
  error(result: LLMResponse, errMsg?: string): void {
    if (this._done) return;
    this.push({
      type: 'error',
      error: errMsg ?? result.content ?? 'LLM 调用失败',
      partial: { content: result.content ?? '', reasoning: result.reasoning ?? '' },
    });
    this.done(result);
  }

  /** 等待最终结果 */
  async result(): Promise<LLMResponse> {
    return this._resultPromise;
  }

  /** 逐 token 消费 */
  async *[Symbol.asyncIterator](): AsyncIterator<StreamToken> {
    let index = 0;
    while (true) {
      if (index < this._queue.length) {
        yield this._queue[index++];
      } else if (this._done) {
        return;
      } else {
        await new Promise<void>(resolve => { this._waiters.push(resolve); });
      }
    }
  }
}

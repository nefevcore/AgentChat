// ============================================================
// ac-client-runtime/src/rpc.ts —— 客户端 RPC 契约面（M27 S3/D7）
//
// 行 client 半边调宿主 RPC 的统一面（D22 契约归属：接口住运行时包，
// 实现由 webui 宿主装载——wireRpc 单例的薄壳服务）。行 client 不
// import webui 内部模块，只依赖本契约 + inject 声明。
// ============================================================

/** 宿主 RPC 调用面（webui 宿主实现：'rpc' 服务） */
export interface RpcClientFace {
  /**
   * 调用宿主 RPC 方法（与 wireRpc.call 同语义：等连接 + 60s 缺省超时）。
   * requestId/timeoutMs 可选透传（长 run 专属超时——conversation/deliver
   * 整轮收束语义；最小桩实现可忽略）。
   */
  call<T>(method: string, params?: unknown, requestId?: string, timeoutMs?: number): Promise<T>;
  /**
   * 订阅宿主事件帧（D20 运输前置：线帧直转，type = 事件名、args = 参数序
   * ——行 client 域投影的刷新时机面；事件词汇 cordis 化随 D20 后续分层）。
   * @returns 撤销订阅的 disposer
   */
  onEvent(handler: (type: string, args: unknown[]) => void): () => void;
  /**
   * 连接建立回调（M27.2-2：conversation 核心的 wire 生命周期面——
   * 重连后的恢复链；可选成员：最小桩实现（测试 rpcStub）无需提供）。
   * @returns 撤销订阅的 disposer（实现无 disposer 时可返回 noop）
   */
  onOpen?(handler: () => void): () => void;
  /**
   * RPC ack 帧回调（M27.2-2：conversation 核心的在途请求对账面；
   * 可选成员：最小桩实现无需提供）。载荷 = 线 ack 帧（requestId/kind/info）。
   * @returns 撤销订阅的 disposer
   */
  onAck?(handler: (ack: { requestId: string; kind: string; info?: Record<string, unknown> }) => void): () => void;
}

declare module './context.ts' {
  interface ClientContext {
    /** 宿主 RPC 调用面（webui 宿主提供；行 client 半边 inject 消费） */
    rpc: RpcClientFace;
  }
}

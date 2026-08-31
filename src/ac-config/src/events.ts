// ============================================================
// ac-config/src/events.ts —— 配置域事件目录（声明合并，零运行时）
//
// 谁 emit 谁声明：config/* 事件的分发方是本包的 ConfigService。
// ============================================================
import type {} from '@agentchat/cordis';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 配置已变更（set/merge/reload 之后）。
     * 订阅刷新模式（替代 src 原地 mutate 保引用技巧）：订阅方收到事件后
     * 【重查 ctx.config 服务】拿新值，不要缓存旧引用。
     * 载荷 = 配置文件路径。
     * @mode emit
     * @scope host
     */
    'config/changed'(path: string): void;
  }
}

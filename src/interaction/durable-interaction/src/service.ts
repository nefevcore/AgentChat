// ============================================================
// @agentchat/durable-interaction/src/service.ts —— cordis Service
//
// ctx.durableInteraction：通用持久化暂停点服务。
// 领域无关：只提供 open/reply/close/get/list/listOpen/clear，
// 并通过 ctx 事件发布 opened/replied/closed 通知。
// ============================================================

import { Service, type Context } from '@agentchat/cordis';
import {
  MemoryDurableInteractionStore,
  JsonlDurableInteractionStore,
} from './store';
import type {
  DurableInteraction,
  DurableInteractionFilter,
  DurableInteractionInput,
  DurableInteractionStore,
  JsonValue,
  ReplyOutcome,
} from './types';

export interface DurableInteractionConfig {
  /** 后端：memory（默认，嵌入式/测试）或 jsonl（append-only 持久化） */
  backend?: 'memory' | 'jsonl';
  /** jsonl 后端文件路径（相对路径按 process.cwd() 解析） */
  file?: string;
  /** jsonl 后端每次 append 后 fsync；缺省 true */
  fsync?: boolean;
}

export class DurableInteractionService extends Service {
  private store: DurableInteractionStore;

  constructor(ctx: Context, config: DurableInteractionConfig = {}) {
    super(ctx, 'durableInteraction');
    this.store = this.createStore(config);
  }

  /** 切换后端（旧后端 dispose；新后端立即恢复持久投影） */
  configure(config: DurableInteractionConfig): void {
    this.store.dispose();
    this.store = this.createStore(config);
  }

  /** 打开一个持久化暂停点；返回前已落盘（jsonl 后端） */
  open(input: DurableInteractionInput): DurableInteraction {
    const record = this.store.open(input);
    this.ctx.emit('durable-interaction/opened', record);
    return record;
  }

  /** 回答：先落盘再返回；duplicate 返回原回答（幂等） */
  reply(id: string, answer: JsonValue): ReplyOutcome {
    const outcome = this.store.reply(id, answer);
    if (outcome.status === 'ok' && outcome.interaction) {
      this.ctx.emit('durable-interaction/replied', outcome.interaction);
    }
    return outcome;
  }

  /** 关闭（timeout / aborted / consumed 等） */
  close(id: string, reason?: string): boolean {
    const closed = this.store.close(id, reason);
    if (closed) {
      const record = this.store.get(id);
      if (record) this.ctx.emit('durable-interaction/closed', record);
    }
    return closed;
  }

  get(id: string): DurableInteraction | undefined {
    return this.store.get(id);
  }

  list(filter?: DurableInteractionFilter): DurableInteraction[] {
    return this.store.list(filter);
  }

  listOpen(filter?: DurableInteractionFilter): DurableInteraction[] {
    return this.store.listOpen(filter);
  }

  /** 重启恢复后仍有待回答的交互数量 */
  get openCount(): number {
    return this.store.listOpen().length;
  }

  clear(): number {
    return this.store.clear();
  }

  dispose(): void {
    this.store.dispose();
  }

  private createStore(config: DurableInteractionConfig): DurableInteractionStore {
    if (config.backend === 'jsonl') {
      if (!config.file) throw new Error('durable-interaction: jsonl 后端需要配置 file 路径');
      return new JsonlDurableInteractionStore(config.file, { fsync: config.fsync ?? true });
    }
    return new MemoryDurableInteractionStore();
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 通用持久化交互/暂停点服务（@agentchat/durable-interaction 插件行提供） */
    durableInteraction: DurableInteractionService;
  }

  interface Events {
    'durable-interaction/opened'(payload: DurableInteraction): void;
    'durable-interaction/replied'(payload: DurableInteraction): void;
    'durable-interaction/closed'(payload: DurableInteraction): void;
  }
}

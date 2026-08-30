// ============================================================
// ac-durable-interaction/src/service.ts —— cordis Service（src 原样平移）
//
// ctx.durableInteraction：通用持久化暂停点服务。
// 领域无关：open/reply/close/get/list/listOpen/clear +
// durable-interaction/{opened,replied,closed} 三事件（谁 emit 谁声明）。
// ============================================================

import { Service, type Context } from '@agentchat/cordis';
import * as path from 'node:path';
import { MemoryDurableInteractionStore, JsonlDurableInteractionStore } from './store.ts';
import type {
  DurableInteraction,
  DurableInteractionFilter,
  DurableInteractionInput,
  DurableInteractionStore,
  JsonValue,
  ReplyOutcome,
} from './types.ts';

export interface DurableInteractionConfig {
  /** 数据根目录（缺省 './data'，相对 cwd；jsonl 文件 = <root>/interactions.jsonl） */
  root?: string;
  /** 后端：memory（缺省，嵌入式/测试）或 jsonl（append-only 持久化） */
  backend?: 'memory' | 'jsonl';
  /** jsonl 后端文件路径（缺省 <root>/interactions.jsonl） */
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
      const file = config.file ?? path.resolve(config.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data', 'interactions.jsonl');
      return new JsonlDurableInteractionStore(file, { fsync: config.fsync ?? true });
    }
    return new MemoryDurableInteractionStore();
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 通用持久化交互/暂停点服务（ac-durable-interaction 行提供） */
    durableInteraction: DurableInteractionService;
  }

  interface Events {
    /**
     * 交互打开通知（write-ahead：落盘后才发）。UI/广播据此渲染提问。
     * @mode emit
     * @scope host
     */
    'durable-interaction/opened'(payload: DurableInteraction): void;
    /**
     * 交互回答通知（先落盘再通知；duplicate 不发）。等待中的工具据此唤醒；
     * late-reply 场景宿主据此发 sender:'event' 信封唤醒 Agent。
     * @mode emit
     * @scope host
     */
    'durable-interaction/replied'(payload: DurableInteraction): void;
    /**
     * 交互关闭通知（timeout / aborted / consumed）。
     * @mode emit
     * @scope host
     */
    'durable-interaction/closed'(payload: DurableInteraction): void;
  }
}

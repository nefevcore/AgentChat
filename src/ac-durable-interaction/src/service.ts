// ============================================================
// ac-durable-interaction/src/service.ts —— cordis Service（src 原样平移）
//
// ctx.durableInteraction：通用持久化暂停点服务。
// 领域无关：open/reply/close/get/list/listOpen/clear +
// durable-interaction/{opened,replied,closed} 三事件（谁 emit 谁声明）。
// 缺省 jsonl 落盘（2026-09-12 修正，见 createStore 注释）。
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
  /** 数据根目录（缺省 AGENTCHAT_DATA_ROOT ?? './data'；jsonl 文件 = <root>/interactions.jsonl） */
  root?: string;
  /** 后端：jsonl（缺省，append-only 持久化）或 memory（嵌入式/单测隔离——显式声明才不落盘） */
  backend?: 'memory' | 'jsonl';
  /** jsonl 后端文件路径（缺省 <root>/interactions.jsonl） */
  file?: string;
  /** jsonl 后端每次 append 后 fsync；缺省 true */
  fsync?: boolean;
  /**
   * 终态记录保留期（毫秒）：sweep 时删除 updatedAt 早于 now - retentionMs
   * 的 answered/closed 记录（pending 永不清理——write-ahead 恢复源）。
   * 缺省 7 天；`0` = 立即清理终态；`null` = 不清理（纯 append-only）。
   */
  retentionMs?: number | null;
  /**
   * sweep 延迟（毫秒）：写口（open/reply/close）后推迟触发，摊平密集
   * ask_questions 轮次（一次折叠 N 次写入）。缺省 60s。
   */
  sweepDelayMs?: number;
}

/** 终态记录保留期缺省：一周 */
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** sweep 触发延迟缺省（写口后一次性定时器，摊平密集写入） */
const DEFAULT_SWEEP_DELAY_MS = 60 * 1000;

export class DurableInteractionService extends Service {
  private store: DurableInteractionStore;
  private readonly sweepDelayMs: number;
  /** 挂起中的 sweep 定时器（一次性；空闲 = undefined，零定时器） */
  private sweepTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(ctx: Context, config: DurableInteractionConfig = {}) {
    super(ctx, 'durableInteraction');
    this.store = this.createStore(config);
    this.sweepDelayMs = config.sweepDelayMs ?? DEFAULT_SWEEP_DELAY_MS;
  }

  /** 打开一个持久化暂停点；返回前已落盘（jsonl 后端） */
  open(input: DurableInteractionInput): DurableInteraction {
    const record = this.store.open(input);
    this.ctx.emit('durable-interaction/opened', record);
    this.scheduleSweep();
    return record;
  }

  /** 回答：先落盘再返回；duplicate 返回原回答（幂等） */
  reply(id: string, answer: JsonValue): ReplyOutcome {
    const outcome = this.store.reply(id, answer);
    if (outcome.status === 'ok' && outcome.interaction) {
      this.ctx.emit('durable-interaction/replied', outcome.interaction);
      this.scheduleSweep();
    }
    return outcome;
  }

  /** 关闭（timeout / aborted / consumed 等） */
  close(id: string, reason?: string): boolean {
    const closed = this.store.close(id, reason);
    if (closed) {
      const record = this.store.get(id);
      if (record) this.ctx.emit('durable-interaction/closed', record);
      this.scheduleSweep();
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

  clear(): number {
    return this.store.clear();
  }

  /**
   * 手动触发一次清理（构造时已自动清一次积压；本方法供诊断/测试用）。
   * memory 后端无 sweep 面，返回 0。
   */
  sweep(now?: number): number {
    return this.store.sweep?.(now) ?? 0;
  }

  dispose(): void {
    // 先跑挂起的 sweep（把写口后的折叠收掉）再拆定时器
    if (this.sweepTimer !== undefined) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.store.dispose();
  }

  /**
   * 写口后的懒 sweep（一次性定时器；空闲零定时器——pnpm dev 自退前提）。
   * 挂起期间再来写口则不动（首个定时器到期一次折叠全部写入）。
   * 定时器不 unref：60s 后折叠是已发生写入的收尾，属服务承诺。
   */
  private scheduleSweep(): void {
    if (this.sweepTimer !== undefined) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined;
      try {
        this.store.sweep?.();
      } catch (err: unknown) {
        this.ctx.logger.warn(`[durable-interaction] sweep 失败（下次写口重试）: ${String(err)}`);
      }
    }, this.sweepDelayMs);
  }

  private createStore(config: DurableInteractionConfig): DurableInteractionStore {
    // 缺省 jsonl（2026-09-12 反馈修正：Single 会话 ask_questions 后端重启后
    // 无法继续回复）：生产装配（cordis.yml / ac-app TREE）裸行无 config，
    // 旧缺省 memory 使"durable"挂起交互实际不持久——后端重启 pending 全丢，
    // 前端 interaction/list 恢复链无从恢复。与 ac-session 等持久化行惯例
    // 对齐：缺省落盘（root ?? env ?? './data'，boot.ts 锚定数据根），显式
    // backend:'memory' 才走内存（嵌入式/单测隔离）。
    if (config.backend === 'memory') {
      return new MemoryDurableInteractionStore();
    }
    const file = config.file ?? path.resolve(config.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data', 'interactions.jsonl');
    // retentionMs：undefined = 一周缺省；null = 显式关闭清理（纯 append-only）
    const retentionMs = config.retentionMs === null ? undefined : config.retentionMs ?? DEFAULT_RETENTION_MS;
    return new JsonlDurableInteractionStore(file, {
      fsync: config.fsync ?? true,
      retentionMs,
    });
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

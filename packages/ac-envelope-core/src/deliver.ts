// ============================================================
// deliver.ts —— 对等投递纯库（盘面会合 §一/§三，cr-861）
//
// 双层会合：活体会合（对端 activation.lock 的 transportHint 直连投
// 递）失败或无锁 → 离线会合（原子写对端 sessions/<对桶>/inbox/，
// 落盘即完成送达——只剩「接收方何时来取」，等是合法状态）。正确性
// 全在盘面与协议层（requestId 幂等在接收方、budget 防自激随信走），
// 本库零 cordis 依赖、零进程假设，每个壳内嵌一份；邮局是它的第一个
// 增值消费者（连接池/重试/ensureHook 拉起/uuid 全局校验）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readActivationLock } from './lock.ts';
import type { Envelope } from './envelope.ts';
import { IpcClient } from './ipc.ts';

/** 投递结果（channel 语义与邮局 DispatchResult 对齐——纯库不认邮局类型） */
export type DeliverResult =
  | { channel: 'direct'; fresh: boolean }
  | { channel: 'inbox'; requestId: string }

/** 会合寻址面：端点 id → 持锁 agent 目录（agents/<id> / children 父缀等）。
 *  路径代数单源——调用方注入（壳知道 child 域，主线知道 agent 域）。 */
export interface RendezvousPaths {
  /** 端点 agent 目录（activation.lock 所在） */
  agentDirOf(endpoint: string): string;
  /** 接收方对桶会话目录（sessions/<conversationId>——inbox 落点） */
  sessionDirOf(endpoint: string, conversationId: string): string;
}

/**
 * 双层会合投递（对等——无邮局假设）：
 *   1) 活体会合：读对端 activation.lock，有锁即连 transportHint 投信，
 *      等 ack（fresh=false 即幂等命中，仍是成功）；
 *   2) 离线会合：锁缺席 / 连接失败（陈锁）→ tmp+rename 原子写对端
 *      inbox/<requestId>.json（文件名即幂等键——单发送方单文件，多发送
 *      方并发不冲突），落盘即送达。不猜：锁在而连不上 = 收件人死了，
 *      信等人；陈锁清理归宿主接管链。
 */
export async function deliver(
  paths: RendezvousPaths,
  envelope: Envelope,
  options: { connectTimeoutMs?: number } = {},
): Promise<DeliverResult> {
  const lock = readActivationLock(paths.agentDirOf(envelope.to));
  if (lock !== null) {
    const client = new IpcClient();
    try {
      await withTimeout(client.connect(lock.transportHint), options.connectTimeoutMs ?? 5_000);
      const ack = await client.send(envelope) as { fresh?: boolean };
      return { channel: 'direct', fresh: ack.fresh !== false };
    } catch {
      // 陈锁/对端垂死——直投不可达，落第 2 层
    } finally {
      client.close();
    }
  }
  const dir = path.join(paths.sessionDirOf(envelope.to, conversationIdOf(envelope)), 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, envelope.requestId + '.json');
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(envelope), 'utf-8');
  fs.renameSync(tmp, file);
  return { channel: 'inbox', requestId: envelope.requestId };
}

/** 会话键：信封不带 conversationId——uuid 即会话身份（一次会话一个），
 *  对桶目录即 sessions/<uuid>（接收方 inbox 落点与账本同址域）。 */
function conversationIdOf(envelope: Envelope): string {
  return envelope.uuid;
}

/** Promise 超时包装（连接卡死防挂——投递面永不无限等） */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ipc connect 超时 ' + ms + 'ms')), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
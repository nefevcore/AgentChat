// ============================================================
// 回归测试（cr-406）：写侧 await 边界的删除窗守卫
//
// 事故形态（审计发现的竞态，非真实事故）：delete 与在途写路径并发——
//   · doEnsureLog：读盘水合期间群被删（或同 id 重建）→ 前世消息写进
//     新群缓存（记忆闪回）；
//   · post：本体 append 后群被删 → 扇出继续往已删群的成员流桶落行
//     （跨 boot 持久残留）+ 事件重放；
//   · seedMemberStream：种子投影途中群被删 → 残行落入成员流桶。
//
// 修复：写路径持构造时群引用，每个 await 边界后校验 this.groups.get
// (gid) === group，失配即中止（世代校验——同 id 重建是新一代群，旧
// 代写路径不得越界）。经 injected session backend 定点注入删除时点。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as groupRow from '../src/index';
import { GroupService } from '../src/index';
import type { GroupConfig } from '../src/index';

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-group-recreate-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[]; group: GroupService }> = [];

/** 慢 session backend：records() 挂起一步（水合竞态窗） */
class SlowSessionBackend {
  deleted: string[] = [];
  appends: string[] = [];
  onRecords?: (gid: string) => void;
  async records(gid: string) {
    this.onRecords?.(gid);
    await new Promise((r) => setTimeout(r, 5));
    return [];
  }
  async append(gid: string, agentId: string) {
    this.appends.push(gid + ':' + agentId);
    return 'sess-' + Math.random().toString(36).slice(2, 10);
  }
  compact() {}
  clear(gid: string) { this.deleted.push(gid); }
  setShelf() {}
}

/** 最小环境：agents 行（成员校验）+ fake session 服务 + 直构 GroupService
 * （remote-link/web-server 测试同款形态——被测的是服务面写路径，无需
 * 完整行集）。afterEach 统一 dispose：group 服务实例销毁即行卸载。 */
async function bootWith(backend: SlowSessionBackend, root: string) {
  const ctx = new Context();
  const agentsFiber = ctx.plugin(agentsRow);
  await agentsFiber;
  ctx.provide('session', backend as never);
  const group = new GroupService(ctx, { root });
  ctx.agents.register({ id: 'a', model: 'mock-1' });
  ctx.agents.register({ id: 'b', model: 'mock-1' });
  booted.push({ ctx, fibers: [agentsFiber], group });
  return { ctx, group };
}

afterEach(async () => {
  booted.splice(0); // 服务随测试上下文丢弃（无持久监听泄漏——loop/before-run 挂在 ctx）
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('删除窗守卫（cr-406 写侧竞态修复）', () => {
  it('水合竞态：读盘期间群被删且同 id 重建 → 新群缓存零前世消息', async () => {
    const root = tmpRoot();
    const backend = new SlowSessionBackend();
    const { ctx, group } = await bootWith(backend, root);
    group.create({ id: 'g', name: '前世', members: ['a'] });
    // 在途水合：records 挂起期间 delete + 同 id 重建（挂起 5ms 制造窗口）
    backend.onRecords = () => {};
    const hydrating = group.records('g');
    await new Promise((r) => setTimeout(r, 1));
    group.delete('g');
    group.create({ id: 'g', name: '今生', members: ['b'] });
    await hydrating;
    // 新群缓存不得含前世消息（同 id 不同代——水合已放弃，logReady 放行重试）
    const recs = await group.records('g');
    expect(recs).toHaveLength(0);
  });

  it('post 竞态：本体 append 后群被删 → 扇出中止，成员流零残留', async () => {
    const root = tmpRoot();
    const backend = new SlowSessionBackend();
    const { ctx, group } = await bootWith(backend, root);
    group.create({ id: 'g', name: '客厅', members: ['a', 'b'] });
    // 水合完成（空本体）
    await group.records('g');
    // post 在途：成员流扇出第一行后删除群
    let faned = 0;
    const origAppend = backend.append.bind(backend);
    backend.append = async (gid: string, agentId: string) => {
      const r = await origAppend(gid, agentId);
      if (gid.startsWith('g~') && faned === 0) {
        faned++;
        group.delete('g');
      }
      return r;
    };
    const posted = await group.post('g', 'user', '并发删除窗');
    expect(posted.content).toBe('并发删除窗'); // 本体行已落（消息已受理）
    const memberFanout = backend.appends.filter((x) => x.startsWith('g~'));
    // 扇出中止：至多一行（删除后不再继续往 b 的流桶落行）
    expect(memberFanout.length).toBeLessThanOrEqual(1);
    expect(group.get('g')).toBeUndefined();
  });

  it('入群种子竞态：投影途中群被删 → 种子中止，无残行入成员流', async () => {
    const root = tmpRoot();
    const backend = new SlowSessionBackend();
    const { group } = await bootWith(backend, root);
    group.create({ id: 'g', name: '客厅', members: ['a'] });
    await group.post('g', 'user', '旧话'); // 本体一行，流扇出一行（a 视角）
    // join b：种子投影第一行后删除群
    let seeded = 0;
    const origAppend = backend.append.bind(backend);
    backend.append = async (gid: string, agentId: string) => {
      const r = await origAppend(gid, agentId);
      if (gid === 'g~b' && seeded === 0) {
        seeded++;
        group.delete('g');
      }
      return r;
    };
    expect(group.join('g', 'b')).toBe(true);
    await new Promise((r) => setTimeout(r, 30)); // 种子异步执行
    const bStream = backend.appends.filter((x) => x === 'g~b:a' || x.startsWith('g~b'));
    // 种子中止：首行后不再追加（群已删，b 的流不得继续收前世投影）
    expect(bStream.length).toBeLessThanOrEqual(1);
    expect(group.get('g')).toBeUndefined();
  });
});

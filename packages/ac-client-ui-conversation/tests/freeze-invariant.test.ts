// ============================================================
// freeze-invariant.test.ts —— cr-1292 冻结消息 reactive invariant
//
// 复现链（restart_host converge 重拉时视角宿主崩溃退位的根因）：
//   直播占位（普通对象）→ 写入 dialogs 深层 reactive（ref 深包装）
//   → mergeHistory L941 rawMessages = nextRaw.map(freezeMsg)
//   → freezeMsg 冻结的是【vue proxy】（属性只读不可配置）
//   → 后续经 reactive 容器读 toolCalls：get trap 返回深层包装 ≠ 原值
//   → Proxy invariant TypeError（'get' on proxy）
// 修复 = freezeMsg 剥壳（__v_raw 鸭子法）再冻结。
// ============================================================
import { describe, it, expect } from 'vitest';
import { ref, reactive } from 'vue';
import { freezeMsg, buildTurns, closeAllStreaming, closeRunningToolCalls } from 'ac-client-ui-conversation/client/feed.ts';
import type { ChatMessage } from 'ac-client-ui-conversation/client/types.ts';

const liveMsg = (id: string, withTools = true): ChatMessage => ({
  id, role: 'agent', content: '直播正文', timestamp: 1000, agent_id: 'a',
  ...(withTools ? { toolCalls: [{ id: 'tc-' + id, name: 'read', arguments: '{}', result: '' } as never] } : {}),
} as ChatMessage);

describe('cr-1292 freezeMsg 剥 reactive 壳', () => {
  it('冻结 vue reactive proxy 引用后，深层 reactive 读取不抛 invariant', () => {
    // dialogs 深层 reactive（ref 深包装——feed-core 真实形态）
    const dialogs = ref<Record<string, { rawMessages: ChatMessage[] }>>({});
    dialogs.value['d1'] = { rawMessages: [] };
    const d = dialogs.value['d1'];
    // 直播行写入（普通对象 → vue 包 proxy）
    d.rawMessages = [liveMsg('m1')];
    const proxied = d.rawMessages[0] as unknown as { __v_raw?: unknown };
    expect(proxied.__v_raw).toBeDefined(); // 前置：确认确实是 reactive proxy
    // merge 写回（freezeMsg 旧实现 = Object.freeze(proxy) 即崩溃形态）
    const merged = [liveMsg('m0'), d.rawMessages[0]];
    d.rawMessages = merged.map(freezeMsg);
    // 崩溃点复现路径：经 reactive 容器读 toolCalls（buildTurns empty 判定同款）
    expect(() => {
      for (const m of d.rawMessages) {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        m.toolCalls?.length;
      }
    }).not.toThrow();
  });

  it('freezeMsg(proxy) 冻结的是剥壳后的 raw 对象（非 proxy 本身）', () => {
    const arr = reactive([liveMsg('m2')]);
    const proxied = arr[0] as ChatMessage;
    const frozen = freezeMsg(proxied);
    expect(Object.isFrozen(frozen)).toBe(true);
    // 冻结产物 = raw 对象（非 vue proxy——proxy 被剥掉）
    expect((frozen as unknown as { __v_raw?: unknown }).__v_raw).toBeUndefined();
    // 普通对象恒等通过
    const plain = liveMsg('m3');
    expect(freezeMsg(plain)).toBe(plain);
  });

  it('cr-1293 收口换身经 freezeMsg：收口后消息仍冻结（入位不变量不撕开）', () => {
    const msgs: ChatMessage[] = [
      liveMsg('m10'), // 会被 freezeMsg 冻结吗——直接构造冻结输入
    ];
    msgs[0] = freezeMsg({ ...msgs[0], isStreaming: true });
    const changed = closeAllStreaming(msgs);
    expect(changed).toBe(true);
    expect(msgs[0].isStreaming).toBe(false);
    expect(Object.isFrozen(msgs[0])).toBe(true); // 收口后仍冻结——防线不撕开
    // 原地写被拒（漏改必抛）
    expect(() => { (msgs[0] as { content: string }).content = 'tampered'; }).toThrow();
  });

  it('cr-1293 工具卡收口（closeRunningToolCalls）换身同冻结', () => {
    const msgs: ChatMessage[] = [freezeMsg({
      ...liveMsg('m11'),
      toolCalls: [{ id: 'tc1', name: 'read', arguments: '{}', result: '', running: true } as never],
      isStreaming: true,
    } as ChatMessage)];
    const changed = closeRunningToolCalls(msgs);
    expect(changed).toBe(true);
    expect(Object.isFrozen(msgs[0])).toBe(true);
    expect((msgs[0].toolCalls as never as Array<{ running?: boolean }>).every((tc) => tc.running !== true)).toBe(true);
  });

  it('崩溃形态端到端：冻结链产物经 buildTurns 消费（empty 判定读 toolCalls）', () => {
    const dialogs = ref<Record<string, { rawMessages: ChatMessage[] }>>({});
    dialogs.value['d1'] = { rawMessages: [] };
    const d = dialogs.value['d1'];
    d.rawMessages = [liveMsg('m4')];
    d.rawMessages = [liveMsg('m0'), ...d.rawMessages].map(freezeMsg);
    // 不抛 + 轮结构正常
    const turns = buildTurns([...d.rawMessages], false);
    expect(turns.at(-1)?.steps).toHaveLength(2);
  });
});

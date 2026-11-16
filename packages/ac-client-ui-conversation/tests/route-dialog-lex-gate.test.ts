// ============================================================
// route-dialog-lex-gate.test.ts —— routeDialog 兜底分支词法闸回归
//（cr-1137）
//
// 需求锚：presence（knownSingles/knownGroups）是异步 RPC 拉取后才填充的
// 前端副本——刷新/首载窗口期内 single 会话帧（uuid 形 conv）与群 run
// 过程帧（g- 前缀）到达时，兜底分支 directDialog(agent) 宽进：unread
// +1 落到 pair:agent|user → 名册 Agent 徽章亮起但点进去无对应消息
//（「徽章赋予到其他会话」）。词法闸后这些帧被丢弃——presence 就绪后
// 正常路由；对桶/直连（裸 agentId）不受影响。
//
// 手法：chatPresence 为模块级单例，直接增删集合驱动路由（与
// settlement-converge.test 的 routeDialog 断言同姿势，无需 feed 实例）。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { routeDialog, chatPresence } from '../client/chatOps.ts';
import { directDialog, singleDialog, groupDialog } from '../client/feed.ts';

const UUID = '3f2b8c1a-9d4e-4f7a-b2c6-1e8a5d0f9b31';

beforeEach(() => {
  chatPresence.knownSingles.clear();
  chatPresence.knownGroups.clear();
});

describe('cr-1137 · routeDialog 兜底分支词法闸', () => {
  it('uuid 形 conv 在 knownSingles 未就绪时被丢弃（不再误落 direct 对桶）', () => {
    const r = routeDialog('alpha', UUID);
    expect(r).toBeNull();
  });

  it('knownSingles 就绪后同帧正常路由 single 分区', () => {
    chatPresence.knownSingles.add(UUID);
    const r = routeDialog('alpha', UUID);
    expect(r?.dialogId).toBe(singleDialog(UUID));
  });

  it('g- 前缀（群键）在 knownGroups 未就绪时被丢弃', () => {
    const r = routeDialog('beta', 'g-m0abcd12');
    expect(r).toBeNull();
  });

  it('sub_ 前缀（子 Agent 会话键）被丢弃——不落 direct 幻影分区', () => {
    const r = routeDialog('sub_9x1', 'sub_9x1', 'sub_9x1', '');
    expect(r).toBeNull();
  });

  it('裸 agentId（loop 直连 run，无会话键）仍路由 direct 对桶', () => {
    const r = routeDialog('alpha', undefined);
    expect(r?.dialogId).toBe(directDialog('alpha'));
  });

  it('对桶键 a~b（含 viewer 与矩阵只读视角）不受闸影响', () => {
    expect(routeDialog('beta', 'beta~gamma')?.dialogId).toBe('pair:beta|gamma');
    expect(routeDialog('alpha', 'alpha~user')?.dialogId).toBe(directDialog('alpha'));
  });

  it('agent 缺席的 uuid 形 conv（无身份帧）同样丢弃', () => {
    expect(routeDialog(undefined, UUID)).toBeNull();
  });

  it('knownGroups 就绪后群 run 过程帧路由群分区（行为不变）', () => {
    chatPresence.knownGroups.add('g-m0abcd12');
    const r = routeDialog('beta', 'g-m0abcd12');
    expect(r?.dialogId).toBe(groupDialog('g-m0abcd12'));
  });
});

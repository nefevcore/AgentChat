// ============================================================
// ac-client-ui-agents/tests/sampling-keys-parity.test.ts ——
// LLM_SAMPLING_KEYS 前端镜像交叉锁定（cr-329）
//
// rosterApi 的透传白名单是 ac-agents/service.ts 同名 Set 的纯手工镜像
// （前端不依赖后端包——行独立形态）。后端白名单加键而镜像未跟 →
// Agent 面保存时新采样键被静默丢弃（用户改了参数不生效）；本测试把
// 走散窗口压到 CI 一轮（同 ac-webui-extensions slotCatalog 锁定先例）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { LLM_SAMPLING_KEYS as FRONTEND_KEYS } from '../client/rosterApi.ts';
import { LLM_SAMPLING_KEYS as BACKEND_KEYS } from 'ac-agents';

describe('cr-329 · LLM_SAMPLING_KEYS 前端镜像 = ac-agents 白名单单源', () => {
  it('键集逐键一致（后端加键 → 前端透传遗漏即红；前端多键 → 协议注入面扩大即红）', () => {
    expect(new Set(FRONTEND_KEYS)).toEqual(BACKEND_KEYS);
  });
});

// ============================================================
// ac-plugin-registry：保留字常量表一致性锁定（F13/G1）
//
// boot 全 TREE（bootTree，与 cordis.yml 行集一致）对照实际注册面：
//   · 工具 / LLM provider 精确相等（出厂行全部无条件注册）
//   · Agent 实际面 ⊆ 表（admin 等条件物化的条目允许表为超集）
// 出厂行新增注册名未更新 ac-plugin-core/src/reserved.ts = 本测试红灯
// （装载期无人报错——护栏漏风只能靠这里挡）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootTree } from 'ac-app';
import {
  BUILTIN_AGENT_IDS,
  BUILTIN_LLM_PROVIDER_NAMES,
  BUILTIN_TOOL_NAMES,
} from 'ac-plugin-core';

const roots: string[] = [];

afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('保留字常量表一致性（boot 全 TREE 锁定，G1）', () => {
  it('工具注册面 === BUILTIN_TOOL_NAMES', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'ac-reserved-'));
    roots.push(dataRoot);
    const prev = process.env.AGENTCHAT_DATA_ROOT;
    process.env.AGENTCHAT_DATA_ROOT = dataRoot;
    try {
      const { ctx, fibers } = await bootTree();
      try {
        const actual = ctx.tools.list().map((t) => t.name).sort();
        expect([...new Set(actual)]).toEqual([...BUILTIN_TOOL_NAMES].sort());
      } finally {
        for (const fiber of [...fibers.values()].reverse()) {
          if (fiber.uid !== null) await fiber.dispose().catch(() => undefined);
        }
      }
    } finally {
      if (prev === undefined) delete process.env.AGENTCHAT_DATA_ROOT;
      else process.env.AGENTCHAT_DATA_ROOT = prev;
    }
  }, 30000);

  it('LLM provider 注册面 === BUILTIN_LLM_PROVIDER_NAMES（fixture 经配置注册——种子已移除）；Agent 面 ⊆ BUILTIN_AGENT_IDS', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'ac-reserved-'));
    roots.push(dataRoot);
    // 三连接 fixture（种子已移除：注册面只来自 config；保留字表仍锁名防动态插件抢注）
    await writeFile(
      join(dataRoot, 'config.json'),
      JSON.stringify({
        llmProviders: {
          openai: { base_url: 'https://api.openai.com/v1' },
          deepseek: { base_url: 'https://api.deepseek.com/' },
          glm: { base_url: 'https://open.bigmodel.cn/api/paas/v4' },
        },
      }),
      'utf8',
    );
    const prev = process.env.AGENTCHAT_DATA_ROOT;
    process.env.AGENTCHAT_DATA_ROOT = dataRoot;
    try {
      const { ctx, fibers } = await bootTree();
      try {
        expect([...ctx.llm.providers()].sort()).toEqual([...BUILTIN_LLM_PROVIDER_NAMES].sort());
        const agents = ctx.agents.list().map((a) => a.id);
        for (const id of agents) {
          expect(BUILTIN_AGENT_IDS).toContain(id);
        }
        expect(agents).toEqual(expect.arrayContaining(['user', '__standard__']));
      } finally {
        for (const fiber of [...fibers.values()].reverse()) {
          if (fiber.uid !== null) await fiber.dispose().catch(() => undefined);
        }
      }
    } finally {
      if (prev === undefined) delete process.env.AGENTCHAT_DATA_ROOT;
      else process.env.AGENTCHAT_DATA_ROOT = prev;
    }
  }, 30000);
});

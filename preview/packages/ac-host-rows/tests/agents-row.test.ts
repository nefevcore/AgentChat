// ============================================================
// 宿主 agents 行单测（cr-540）：身份编辑面唯一写口——配置轴原子写 +
// entries/ 机制数据 + 文档 + 头像 + 模板创建（skip-if-present / preset 剥除）
// + transient 合成不落盘 + 词法闸 fail-loud。数据根恒 preview/sandbox。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context } from '@agentchat/cordis';
import { makeAgentsHostRow, AgentsEditService, TEMPLATE_DIR } from '../src/index.ts';

const ROOT = path.join('preview', 'sandbox', 'test-host-agents-' + process.pid);
beforeEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** null = 显式省略模板目录（行不在集形态——缺省参数不能用 undefined 表达） */
async function boot(templatesDir: string | null = TEMPLATE_DIR) {
  const ctx = new Context();
  const fiber = ctx.plugin(makeAgentsHostRow({ dataRoot: ROOT, ...(templatesDir !== null ? { templatesDir } : {}) }));
  await fiber;
  return {
    agents: (ctx as unknown as { agents: AgentsEditService }).agents,
    async dispose() { await fiber.dispose(); },
  };
}

describe('宿主 agents 编辑面（身份文集唯一写口）', () => {
  it('配置轴：saveAgent 原子落盘 + 读回 + 目录清单 + removeAgent 删整树', async () => {
    const h = await boot();
    try {
      h.agents.saveAgent({ id: 'alpha', model: 'mock', name: '甲' });
      h.agents.saveAgent({ id: 'beta', model: 'mock' });
      expect(h.agents.agentIds()).toEqual(['alpha', 'beta']);
      expect(h.agents.getAgent('alpha')?.name).toBe('甲');
      expect(h.agents.listAgents().map((c) => c.id)).toEqual(['alpha', 'beta']);
      // 落盘布局单源：agents/<id>/config.json（无临时文件残留）
      const dir = path.join(ROOT, 'agents', 'alpha');
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')).model).toBe('mock');
      expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
      // 删身份 = 删整树（含 entries / 文档）
      h.agents.saveEntry('beta', 'timer', { entries: [] });
      expect(h.agents.removeAgent('beta')).toBe(true);
      expect(h.agents.removeAgent('beta')).toBe(false);
      expect(fs.existsSync(path.join(ROOT, 'agents', 'beta'))).toBe(false);
      expect(h.agents.agentIds()).toEqual(['alpha']);
      // 路径穿越 fail-loud
      expect(() => h.agents.saveAgent({ id: '../evil', model: 'm' })).toThrow();
      expect(() => h.agents.getAgent('../evil')).toThrow();
    } finally {
      await h.dispose();
    }
  });

  it('entries：entries/<key>.json 布局（timers 行直读同路径）+ 往返 + 键词法闸', async () => {
    const h = await boot();
    try {
      h.agents.saveAgent({ id: 'alpha', model: 'mock' });
      h.agents.saveEntry('alpha', 'timer', { entries: [{ id: 'e1' }] });
      h.agents.saveEntry('alpha', 'goal', [{ id: 'g1' }]);
      const file = path.join(ROOT, 'agents', 'alpha', 'entries', 'timer.json');
      expect(fs.existsSync(file)).toBe(true);
      expect(h.agents.readEntry<{ entries: Array<{ id: string }> }>('alpha', 'timer')?.entries[0].id).toBe('e1');
      expect(h.agents.entryKeys('alpha')).toEqual(['goal', 'timer']);
      expect(h.agents.removeEntry('alpha', 'goal')).toBe(true);
      expect(h.agents.removeEntry('alpha', 'goal')).toBe(false);
      expect(h.agents.entryKeys('alpha')).toEqual(['timer']);
      expect(h.agents.readEntry('alpha', 'absent')).toBeUndefined();
      expect(() => h.agents.saveEntry('alpha', '../evil', {})).toThrow(/非法/);
      expect(() => h.agents.saveEntry('alpha', 'UpCase', {})).toThrow(/非法/);
    } finally {
      await h.dispose();
    }
  });

  it('文档：AGENT.md 唯一写口（尾换行归一）+ 非法名拒写', async () => {
    const h = await boot();
    try {
      h.agents.saveAgent({ id: 'alpha', model: 'mock' });
      h.agents.saveDoc('alpha', 'AGENT.md', '---\ntitle: 甲\n---\n\n人设正文');
      expect(h.agents.readDoc('alpha', 'AGENT.md')).toBe('---\ntitle: 甲\n---\n\n人设正文\n');
      expect(h.agents.removeDoc('alpha', 'AGENT.md')).toBe(true);
      expect(h.agents.removeDoc('alpha', 'AGENT.md')).toBe(false);
      expect(h.agents.readDoc('alpha', 'AGENT.md')).toBeUndefined();
      expect(() => h.agents.saveDoc('alpha', '../evil.md', 'x')).toThrow(/非法/);
      expect(() => h.agents.saveDoc('alpha', 'sub/AGENT.md', 'x')).toThrow(/非法/);
      expect(() => h.agents.saveDoc('alpha', 'config.json', 'x')).toThrow(/非法/);
    } finally {
      await h.dispose();
    }
  });

  it('头像：扩展名归一小写 + 旧扩展名残留回收 + 探测/删除', async () => {
    const h = await boot();
    try {
      h.agents.saveAgent({ id: 'alpha', model: 'mock' });
      h.agents.saveAvatar('alpha', Buffer.from('x'), '.PNG');
      const AVATAR = (ext: string) => path.resolve(ROOT, 'agents', 'alpha', `avatar.${ext}`);
      expect(h.agents.avatarPath('alpha')).toBe(AVATAR('png'));
      h.agents.saveAvatar('alpha', Buffer.from('y'), '.webp');
      expect(h.agents.avatarPath('alpha')).toBe(AVATAR('webp'));
      expect(h.agents.removeAvatar('alpha')).toBe(true);
      expect(h.agents.removeAvatar('alpha')).toBe(false);
      expect(h.agents.avatarPath('alpha')).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });

  it('模板面：createFromTemplate 写文集（preset 剥除）+ skip-if-present（用户数据优先）', async () => {
    const h = await boot();
    try {
      const created = h.agents.createFromTemplate('standard', 'helper');
      expect(created.id).toBe('helper');
      expect(created.preset).toBeUndefined(); // 创建物是真实身份，不进预设名册
      expect(created.name).toBe('标准模式');
      expect(h.agents.getAgent('helper')?.preset).toBeUndefined();
      // 用户改过之后重入：不覆盖（幂等 skip-if-present）
      h.agents.saveAgent({ ...h.agents.getAgent('helper')!, name: '我的助手' });
      const again = h.agents.createFromTemplate('standard', 'helper');
      expect(again.name).toBe('我的助手');
      // 覆盖项（如模型引用）在模板之上生效
      const overridden = h.agents.createFromTemplate('dsh-minimal', 'mini', { model: 'mock-1', provider: 'p1' });
      expect(overridden.model).toBe('mock-1');
      expect(overridden.provider).toBe('p1');
      expect(overridden.tools).toEqual(['str-replace-editor', 'shell-tools']);
      expect(() => h.agents.createFromTemplate('nope', 'x')).toThrow(/模板不存在/);
    } finally {
      await h.dispose();
    }
  });

  it('transient 合成不落盘（宿主从模板合成 argv 传临时壳）；行缺席 = 模板面良定义降级', async () => {
    const h = await boot();
    try {
      const transient = h.agents.transientConfigOf('creator', 'tmp-shell');
      expect(transient.id).toBe('tmp-shell');
      expect(transient.system).toContain('插件开发指南');
      expect(fs.existsSync(path.join(ROOT, 'agents', 'tmp-shell'))).toBe(false);
      expect(h.agents.templates().map((t) => t.id)).toEqual(['standard', 'dsh-minimal', 'creator', 'abap-dev']);
    } finally {
      await h.dispose();
    }
    // preset-builtin 行不在集（boot 不注入模板目录）：CRUD 照常，模板面报不可用
    const bare = await boot(null);
    try {
      expect(bare.agents.templates()).toEqual([]);
      bare.agents.saveAgent({ id: 'plain', model: 'm' });
      expect(bare.agents.getAgent('plain')?.model).toBe('m');
      expect(() => bare.agents.createFromTemplate('standard', 'x')).toThrow(/模板面不可用/);
    } finally {
      await bare.dispose();
    }
  });
});

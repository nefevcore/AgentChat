// ============================================================
// ac-llm-pool 测试：配置唯一事实源（种子已移除）——空池零注册 ·
// base_url 必要条件 · 热更 diff · 行卸载回收 · boot 重名 fail-loud
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber, Service } from '@agentchat/cordis';
import * as llmRow from 'ac-llm';
import * as configRow from 'ac-config';
import * as poolRow from '../src/index.ts';
import { desiredProviders, normalizePoolModels } from '../src/index.ts';

const tmps: string[] = [];
const booted: { ctx: Context; fibers: Fiber[] }[] = [];

function tmpRoot(pool?: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-llm-pool-'));
  tmps.push(dir);
  if (pool !== undefined) {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ llmProviders: pool }), 'utf8');
  }
  return dir;
}

/** boot：llm + config(可选) + pool；返回 ctx 与 fiber 集（逆序回收） */
async function boot(root?: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = root !== undefined ? [llmRow, configRow, poolRow] : [llmRow, poolRow];
  for (const row of rows) {
    const fiber = root !== undefined && row === configRow
      ? ctx.plugin(row as any, { root })
      : ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

/** boot + workspace 桩（M4：真实物化路径只依赖 resolveFile 语义——
 *  构造真 WorkspaceService 会拉起 agentStore 默认 Agent 链，超出本域） */
class StubWorkspaceService extends Service {
  constructor(ctx: Context, private rootDir: string) {
    super(ctx, 'workspace');
  }
  resolveFile(relPath: string): string {
    if (!relPath.startsWith('files/')) throw new Error('越界');
    const file = path.resolve(this.rootDir, relPath);
    if (!fs.existsSync(file)) throw new Error('不存在');
    return file;
  }
}

/** boot + workspace（M4：真实 resolveFile 物化路径——LRU 缓存随行覆盖） */
async function bootWithWorkspace(root: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const workspace = new StubWorkspaceService(ctx, root);
  void workspace;
  for (const row of [llmRow, configRow, poolRow]) {
    const fiber = row === configRow ? ctx.plugin(row as any, { root }) : ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

async function disposeAll() {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
}

afterEach(async () => {
  await disposeAll();
  for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

describe('ac-llm-pool：注册面（连接池 = 唯一事实源）', () => {
  it('空池 → 零注册（未配置 = 不注册；无内置兜底）', async () => {
    const { ctx } = await boot(tmpRoot({}));
    expect(ctx.llm.providers()).toEqual([]);
  });

  it('无 config 行 → 零注册（配置面未装即无 provider）', async () => {
    const { ctx } = await boot();
    expect(ctx.llm.providers()).toEqual([]);
  });

  it('连接条目注册（base_url 必要条件）；models 进路由清单', async () => {
    const { ctx } = await boot(
      tmpRoot({
        myds: { base_url: 'https://my.example.com/v1', defaultModel: 'my-1', models: ['my-1', 'my-2'] },
        deepseek: { base_url: 'https://api.deepseek.com/', models: ['deepseek-v4-flash'] },
        'ds-flash': { provider: 'deepseek', model: 'deepseek-v4-flash' }, // 无 base_url：跳过
        $ref: { note: '内部键忽略' },
      }),
    );
    const names = ctx.llm.providers().sort();
    expect(names).toEqual(['deepseek', 'myds']);
    expect(ctx.llm.stats().find((s) => s.name === 'myds')?.models).toEqual(['my-1', 'my-2']);
    expect(ctx.llm.resolveProvider({ model: 'my-2' })).toBe('myds'); // 发现缓存进路由
    expect(ctx.llm.stats().find((s) => s.name === 'deepseek')?.baseUrl).toBe('https://api.deepseek.com/');
  });

  it('工厂接线：条目 base_url 真正进入请求 URL（全局 fetch 桩）', async () => {
    const root = tmpRoot({ myds: { base_url: 'https://my.example.com/v1', models: ['my-1'] } });
    const { ctx } = await boot(root);
    const captured: { url?: unknown } = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      captured.url = url;
      return new Response('stub', { status: 500 }); // stream 抛 HTTP 500 → catch 掉，只断言 URL
    }) as unknown as typeof fetch;
    try {
      await ctx.llm.chat({ model: 'my-1', messages: [{ role: 'user', content: 'q' }] }).catch(() => undefined);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(captured.url).toBe('https://my.example.com/v1/chat/completions');
  });
});

describe('ac-llm-pool：热更与生命周期', () => {
  it('config/changed → diff 撤/挂：新增条目注册、删除条目回收', async () => {
    const { ctx } = await boot(tmpRoot({ myds: { base_url: 'https://a/v1', models: ['a-1'] } }));
    expect(ctx.llm.providers()).toContain('myds');
    // 变更：换内容（models 变）→ 重挂；stats 反映新清单
    ctx.config.set('llmProviders', { myds: { base_url: 'https://a/v1', models: ['a-1', 'a-2'] } });
    expect(ctx.llm.stats().find((s) => s.name === 'myds')?.models).toEqual(['a-1', 'a-2']);
    // 删除条目 → 撤注册；无隐式兜底（零注册）
    ctx.config.set('llmProviders', {});
    expect(ctx.llm.providers()).toEqual([]);
  });

  it('行卸载 → 全部注册回收', async () => {
    const root = tmpRoot({ myds: { base_url: 'https://a/v1', models: ['a-1'] } });
    const { ctx, fibers } = await boot(root);
    expect(ctx.llm.providers()).toEqual(['myds']);
    const poolFiber = fibers[fibers.length - 1];
    await poolFiber.dispose();
    expect(ctx.llm.providers()).toEqual([]);
  });

  it('boot 期重名 fail-loud：外部先抢注 → pool 行 apply 抛错', async () => {
    const ctx = new Context();
    const llmFiber = ctx.plugin(llmRow);
    const configFiber = ctx.plugin(configRow as any, { root: tmpRoot({ deepseek: { base_url: 'https://x/v1' } }) });
    await llmFiber;
    await configFiber;
    ctx.llm.register('deepseek', () => ({ stream: async function* () {} }), { models: [] });
    // apply 抛错 → fiber 拒绝（boot fail-loud：错误可诊断，注册中止）
    let err: unknown;
    try {
      await ctx.plugin(poolRow as any);
    } catch (e: unknown) {
      err = e;
    }
    expect(err instanceof Error ? err.message : String(err)).toMatch(/已注册/);
    await llmFiber.dispose();
  });
});

describe('ac-llm-pool：visionModels（多模态一期）', () => {
  it('desiredProviders 解析 visionModels（非字符串项过滤；缺省空清单）', () => {
    const d = desiredProviders({
      ds: { base_url: 'https://a/v1', visionModels: ['deepseek-v4-flash-vision-exp', 42, null, ''] },
      plain: { base_url: 'https://b/v1' },
    })!;
    expect(d.get('ds')!.visionModels).toEqual(['deepseek-v4-flash-vision-exp']);
    expect(d.get('plain')!.visionModels).toEqual([]);
  });

  it('端到端：命中模型物化 image_url 块、未命中剥离；热更改清单重挂生效', async () => {
    const root = tmpRoot({
      myds: { base_url: 'https://a/v1', models: ['v-1', 't-1'], visionModels: ['v-1'] },
    });
    const { ctx } = await boot(root);
    const bodies: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response('stub', { status: 500 }); // 只断言请求体形状
    }) as unknown as typeof fetch;
    const att = [{ kind: 'image' as const, ref: 'https://cdn.example.com/x.png' }];
    try {
      // 命中 v-1：http 引用直传物化为 image_url 块
      await ctx.llm
        .chat({ model: 'v-1', messages: [{ role: 'user', content: 'q', attachments: att }] })
        .catch(() => undefined);
      expect(bodies[0].messages[0].content).toEqual([
        { type: 'text', text: 'q' },
        { type: 'image_url', image_url: { url: 'https://cdn.example.com/x.png' } },
      ]);
      // 未命中 t-1：attachments 剥离、content 保持字符串
      await ctx.llm
        .chat({ model: 't-1', messages: [{ role: 'user', content: 'q', attachments: att }] })
        .catch(() => undefined);
      expect(bodies[1].messages[0].content).toBe('q');
      expect(bodies[1].messages[0]).not.toHaveProperty('attachments');
      // 热更：t-1 加入清单 → 重挂后物化生效（visionModels 进内容签名）
      ctx.config.set('llmProviders', {
        myds: { base_url: 'https://a/v1', models: ['v-1', 't-1'], visionModels: ['v-1', 't-1'] },
      });
      await ctx.llm
        .chat({ model: 't-1', messages: [{ role: 'user', content: 'q', attachments: att }] })
        .catch(() => undefined);
      expect(Array.isArray(bodies[2].messages[0].content)).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('真实 workspace 物化（M4 LRU）：文件 → data: URL，重复物化命中缓存同值', async () => {
    // 上传一张真图进 workspace（saveUpload 服务方法）
    const root = tmpRoot({
      myds: { base_url: 'https://a/v1', models: ['v-1'], visionModels: ['v-1'] },
    });
    const png = Buffer.from(
      // 1×1 PNG（合法文件头即可——物化只读字节不看内容）
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const { ctx } = await bootWithWorkspace(root);
    const rel = 'files/user/_tmp/dot.png';
    fs.mkdirSync(path.join(root, 'files/user/_tmp'), { recursive: true });
    fs.writeFileSync(path.join(root, rel), png);
    const up = { path: rel };

    const bodies: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response('stub', { status: 500 });
    }) as unknown as typeof fetch;
    try {
      const att = [{ kind: 'image' as const, ref: up.path }];
      // 同一引用两次物化（第二次经 LRU 缓存）——请求体逐字节同值
      await ctx.llm.chat({ model: 'v-1', messages: [{ role: 'user', content: 'q', attachments: att }] }).catch(() => undefined);
      await ctx.llm.chat({ model: 'v-1', messages: [{ role: 'user', content: 'q', attachments: att }] }).catch(() => undefined);
      const b1 = bodies[0].messages[0].content as any[];
      const b2 = bodies[1].messages[0].content as any[];
      expect(b1[1].image_url.url).toMatch(/^data:image\/png;base64,/);
      expect(b1[1].image_url.url).toBe(b2[1].image_url.url);
      // 文件被覆写（mtime/size 变）→ 缓存失效重新物化
      fs.writeFileSync(path.join(root, up.path), Buffer.concat([png, png]));
      await ctx.llm.chat({ model: 'v-1', messages: [{ role: 'user', content: 'q', attachments: att }] }).catch(() => undefined);
      const b3 = (bodies[2].messages[0].content as any[])[1].image_url.url;
      expect(b3).not.toBe(b1[1].image_url.url);
      // 非 MIME 表扩展名（.exe）→ 不物化 → 降级占位
      fs.writeFileSync(path.join(root, 'files/user/_tmp/bad.exe'), Buffer.from('x'));
      await ctx.llm.chat({
        model: 'v-1',
        messages: [{ role: 'user', content: 'q', attachments: [{ kind: 'image', ref: 'files/user/_tmp/bad.exe', filename: 'bad.exe' }] }],
      }).catch(() => undefined);
      const b4 = bodies[3].messages[0].content as any[];
      expect(b4[1]).toEqual({ type: 'text', text: '[图片无法加载: bad.exe]' });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('模型能力元数据（models 宽容双形态 + vision 并集门控）', () => {
  it('normalizePoolModels：裸名/对象双形态归一，非法项丢弃、按名去重', () => {
    expect(normalizePoolModels([
      'a',
      { model: 'b', vision: true },
      { model: 'c', hidden: true },
      { model: 'd', vision: 'yes' },   // 非布尔 true → 忽略该标志
      { model: '' },                    // 空名丢弃
      42, null, 'x',                    // 非法项丢弃
      'a',                              // 重复（首个胜）
    ])).toEqual([
      { model: 'a' },
      { model: 'b', vision: true },
      { model: 'c', hidden: true },
      { model: 'd' },
      { model: 'x' },
    ]);
    expect(normalizePoolModels(undefined)).toEqual([]);
  });

  it('desiredProviders：对象形态 models 进路由清单 + modelMeta 提取', () => {
    const d = desiredProviders({
      ds: {
        base_url: 'https://a/v1',
        models: ['t-1', { model: 'v-1', vision: true }, { model: 'h-1', hidden: true }],
      },
    })!;
    expect(d.get('ds')!.models).toEqual(['t-1', 'v-1', 'h-1']); // 裸名进路由（hidden 不影响）
    expect(d.get('ds')!.modelMeta).toEqual({ 'v-1': { vision: true }, 'h-1': { hidden: true } });
  });

  it('vision 并集门控：models[].vision 标志与显式 visionModels 同效物化；热更探测标志即时生效', async () => {
    const root = tmpRoot({
      myds: { base_url: 'https://a/v1', models: [{ model: 'v-1', vision: true }, 't-1'] },
    });
    const { ctx } = await boot(root);
    const bodies: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response('stub', { status: 500 });
    }) as unknown as typeof fetch;
    const att = [{ kind: 'image' as const, ref: 'https://cdn.example.com/x.png' }];
    try {
      // v-1：探测标志 vision:true → 物化（未配置 visionModels）
      await ctx.llm.chat({ model: 'v-1', messages: [{ role: 'user', content: 'q', attachments: att }] }).catch(() => undefined);
      expect(Array.isArray(bodies[0].messages[0].content)).toBe(true);
      // t-1：无标志 → 剥离（fail-closed）
      await ctx.llm.chat({ model: 't-1', messages: [{ role: 'user', content: 'q', attachments: att }] }).catch(() => undefined);
      expect(bodies[1].messages[0].content).toBe('q');
      // 热更：t-1 补探测标志 → 重挂后物化（modelMeta 进内容签名）
      ctx.config.set('llmProviders', {
        myds: { base_url: 'https://a/v1', models: [{ model: 'v-1', vision: true }, { model: 't-1', vision: true }] },
      });
      await ctx.llm.chat({ model: 't-1', messages: [{ role: 'user', content: 'q', attachments: att }] }).catch(() => undefined);
      expect(Array.isArray(bodies[2].messages[0].content)).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('stats 透出 modelMeta（llm/providers → 前端徽章/过滤数据源）', async () => {
    const { ctx } = await boot(
      tmpRoot({ myds: { base_url: 'https://a/v1', models: ['t-1', { model: 'v-1', vision: true }, { model: 'h-1', hidden: true }] } }),
    );
    const stat = ctx.llm.stats().find((s) => s.name === 'myds')!;
    expect(stat.models).toEqual(['t-1', 'v-1', 'h-1']);
    expect(stat.modelMeta).toEqual({ 'v-1': { vision: true }, 'h-1': { hidden: true } });
  });

  it('注册 meta.visionModels 并集透出 + visionOf 与适配层 matcher 对拍（两处单源锁死）', async () => {
    const { ctx } = await boot(
      tmpRoot({
        myds: {
          base_url: 'https://a/v1',
          visionModels: ['explicit-v'],
          models: [{ model: 'probed-v', vision: true }, 't-1'],
        },
      }),
    );
    const stat = ctx.llm.stats().find((s) => s.name === 'myds')!;
    // 有效并集：显式清单 ∪ 探测标志
    expect(stat.visionModels).toEqual(['explicit-v', 'probed-v']);
    // visionOf 判定（系统提示词消费面）
    expect(ctx.llm.visionOf('explicit-v', 'myds')).toBe(true);
    expect(ctx.llm.visionOf('probed-v', 'myds')).toBe(true);
    expect(ctx.llm.visionOf('t-1', 'myds')).toBe(false);
    // 与适配层纯库 matcher 逐组对拍（ac-llm 本地实现同口径——防两处漂移）
    const { modelMatchesPatterns } = await import('ac-openai-completions');
    for (const model of ['explicit-v', 'explicit-v-mini', 'probed-v', 't-1', 'x']) {
      expect(ctx.llm.visionOf(model, 'myds')).toBe(modelMatchesPatterns(model, stat.visionModels));
    }
  });
});

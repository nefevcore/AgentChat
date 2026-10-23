// ============================================================
// dev.ts —— preview 宿主 dev 启动器（8.5e 联调一手脚本；cr-551 换轨
// 生产链：dev 面与 supervisor.mjs 的 worker 同为 bootHost——编排面/监护
// 面/按需拉起全链一致，dev 联调即生产形态验证）
//
// bootHost（45 行宿主树 + web 表面 + 编排面〔supervise 句柄池 + 邮局
// ensure 钩子 + re-tap〕）→ 指定 agent 即时拉起（mock provider——dev
// 面无凭据环境）。数据根恒 preview/sandbox/dev-home（红线）；端口 3840
//（与主线 3830 错开——vite dev proxy 缺省指向）。vite dev server：
//   pnpm --filter ac-ui-app dev   → http://localhost:3841/
// ============================================================
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootHost } from './boot.ts';
import type { OrchestratorHandle } from './orchestrator.ts';
import type { SuperviseHandle } from './supervise.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.resolve(HERE, '../../sandbox/dev-home');

export interface DevHostResult {
  port: number;
  /** mock 壳 agentId → transportHint */
  agents: Map<string, string>;
  /** 编排面（按需拉起/监护句柄池——dev 与生产同链） */
  supervisors: OrchestratorHandle;
  /** 即时拉起壳的监护句柄（agentId → handle） */
  handles: Map<string, SuperviseHandle>;
  close(): Promise<void>;
}

/**
 * 拉起 dev 宿主 + 若干 mock 壳。缺省拉起 alpha / beta 两壳（1v1 会话演示
 * 面）；传 [] 则仅宿主（来件按需拉起——编排面 ensure 钩子在位）。
 */
export async function bootDevHost(agentIds: string[] = ['alpha', 'beta']): Promise<DevHostResult> {
  const fs = await import('node:fs');
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  for (const id of agentIds) {
    const dir = path.join(DATA_ROOT, 'agents', id);
    fs.mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, 'config.json');
    if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ id, model: 'mock' }), 'utf-8');
  }

  const host = await bootHost({
    dataRoot: DATA_ROOT,
    catalogFile: path.resolve(HERE, '../catalog/row-catalog.json'),
    port: 3840,
    // dev 注入 mock 档：supervise 链与生产同构，仅 provider 档不同
    ...(process.env.PREVIEW_DEV_REAL_PROVIDER === undefined ? { mockProvider: true } : {}),
  });
  if (host.supervisors === null) throw new Error('dev 面编排面缺席（orchestrate:false？）');
  const supervisors = host.supervisors;
  const agents = new Map<string, string>();
  for (const id of agentIds) {
    const sup = await supervisors.ensureAgent(id);
    const hint = sup.superviseEvents.find((e) => e.type === 'adopted')?.transportHint ?? '';
    agents.set(id, hint);
  }
  return {
    port: host.web.port,
    agents,
    supervisors,
    handles: supervisors.handles(),
    async close() {
      await host.close();
    },
  };
}

// ---- CLI 直跑（node --experimental-strip-types preview/apps/host/dev.ts）----
if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  void bootDevHost().then((dev) => {
    console.log('[dev] preview 宿主 http://127.0.0.1:' + dev.port + '/  （数据根 ' + DATA_ROOT + '）');
    console.log('[dev] mock 壳：' + [...dev.agents.keys()].join(', '));
    console.log('[dev] vite dev：cd preview/apps/ui && npx vite   → http://localhost:3841/');
    console.log('[dev] Ctrl-C 退出');
    const onExit = () => { void dev.close().finally(() => process.exit(0)); };
    process.on('SIGINT', onExit);
    process.on('SIGTERM', onExit);
  }).catch((err: unknown) => {
    console.error('[dev] 启动失败：', err);
    process.exit(1);
  });
}

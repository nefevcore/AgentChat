// ============================================================
// ac-app/src/boot.ts —— 官方启动器入口
//
// pnpm preview:boot = node --expose-internals --import tsx 本文件
// 职责：
//   1. 锚定数据根（M18 前端反馈 #10）：持久化目录 = 启动文件夹（不套
//      data/ 壳）。pnpm/npm 运行脚本时会把 cwd 切到 package.json 所在
//      的包根（在子目录敲 pnpm 也会被抬到仓库根）——真·启动文件夹经
//      INIT_CWD 环境变量取回（pnpm/npm 在脚本环境注入）；直跑 node
//      时无此变量，回落 process.cwd()。锚定结果写 AGENTCHAT_DATA_ROOT
//      （已设则尊重），各持久化行缺省读它；
//   2. chdir 到 src/（官方 bin.js 以 cwd 为 baseUrl，读 ./cordis.yml）；
//   3. **内联官方 bin.js 的 16 行**（M23 A2：Context → Loader → include）——
//      官方路径是动态 import 写死 config，不内联无法注入 patches。内联
//      先例：ac-app/src/boot-yml-main.ts。装载前读行偏好层
//      <AGENTCHAT_DATA_ROOT>/cordis.patch.yml（不存在/损坏 = warn + 空数组，
//      fail-soft——文件人可读可手工急救）注入 include config 的 patches。
//      出厂态不变量：cordis.yml 永不被运行时写入（include 挂 loader 内存
//      根树、Loader.write() 无文件 no-op——F10 守卫测试锁定）。
//   4. **进程级兜底（C1，2026-08-31 审计）**：unhandledRejection /
//      uncaughtException 记日志不退出。Node ≥15 默认把悬空 rejection
//      升级为进程崩溃，而宿主长跑面上散布 fire-and-forget（标题生成 /
//      插件装载扫描 / job cancel…）——单个装饰性功能的失败不得放大为
//      整宿主下线（对照旧轨 src/bootstrap.ts:53-58 同款兜底）。emit 面
//      的逐回调隔离已落 vendor events.ts；这里是最后一道网。
// ============================================================
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { Context } from '@agentchat/cordis';
import Loader from '@agentchat/cordis-loader';
import { readPatchFile, type PatchFileEntry } from 'ac-plugin-core';
import { acquireRuntimeLock, runtimeLockPath, EXIT_CONFIG } from 'ac-supervisor-core';

// ---- 进程级兜底（先于一切装载：装载期异常也被网住） ----
process.on('unhandledRejection', (reason) => {
  console.error('[boot] 未处理的 Promise 拒绝（已兜底，进程继续）:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[boot] 未捕获异常（已兜底，进程继续）:', err);
});

const launchCwd = path.resolve(process.env.INIT_CWD || process.cwd());
if (!process.env.AGENTCHAT_DATA_ROOT) {
  process.env.AGENTCHAT_DATA_ROOT = launchCwd;
}
console.log(`[boot] 启动文件夹（INIT_CWD 回落 cwd）: ${launchCwd}`);
console.log(`[boot] 持久化数据根（AGENTCHAT_DATA_ROOT）: ${process.env.AGENTCHAT_DATA_ROOT}`);

// ---- 进程级诊断报告（2026-09-05 OOM 事故取证）：fatal error（V8 OOM/
// abort 等）自动落诊断报告（JS/原生栈 + heap 统计；原生侧写出，不占 JS
// 堆）到数据根 reports/。等价于 NODE_OPTIONS="--report-on-fatalerror
// --diagnostic-dir=<数据根>/reports"，但内联生效——无需宿主（ac-desktop
// spawn）或开发脚本注入环境，packaged 与 dev 同一行为；常态零开销
// （仅 fatal 时写一份小报告）。与 NODE_OPTIONS 同名开关可叠加，不冲突。 ----
process.report.reportOnFatalError = true;
process.report.directory = path.join(process.env.AGENTCHAT_DATA_ROOT, 'reports');
console.log(`[boot] fatal 诊断报告目录（report-on-fatalerror）: ${process.report.directory}`);

const trackDir = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
console.log(`[boot] 装配根（chdir → cordis.yml 所在目录）: ${trackDir}`);

process.chdir(trackDir);

// ---- B4 单实例互斥：官方 boot 路径取 .runtime 锁 ----
// 锁语义曾只在 supervisor.mjs 接线——`preview:boot` 直启 + supervised 实例
// （或双开直启）会同数据根双写者静默共存：config.json 读改写互踩、
// singles 固定 .tmp 名互踩、会话 writer/compact 互相覆盖。supervised 形态
// 锁由 supervisor 持有（worker 再取必 EEXIST），故仅直启时获取。
if (process.env.AGENTCHAT_SUPERVISED !== '1') {
  const lockFile = runtimeLockPath(trackDir);
  try {
    const unlock = acquireRuntimeLock(lockFile);
    process.on('exit', () => unlock()); // 同步释放（硬杀走陈旧锁回收路径）
    console.log(`[boot] 已获取单实例锁: ${lockFile}`);
  } catch (err) {
    console.error(
      `[boot] 检测到另一实例正在运行（${lockFile} 已被锁定）。` +
        '同数据根双写者会互相覆盖（config/singles/会话文件）；确认另一实例（pnpm dev 直启或 dev:supervised）后重试。',
    );
    console.error(`[boot] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_CONFIG);
  }
}

// ---- 行偏好层读取（fail-soft；M23 A2 桥接） ----
let patches: PatchFileEntry[] = [];
{
  const read = readPatchFile(process.env.AGENTCHAT_DATA_ROOT!);
  patches = read.patches;
  for (const warning of read.warnings) console.warn(`[boot] cordis.patch.yml: ${warning}`);
  if (patches.length > 0) {
    console.log(`[boot] 行偏好层生效: ${patches.map((p) => `${p.id}${p.disabled === true ? '(停用)' : ''}`).join(', ')}`);
  }
}

// ---- 官方 bin.js 的 16 行内联（唯一差异：config.patches 注入） ----
const ctx = new Context();
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/';

// D2：装载失败 = 启动期配置/组合错误（不会自愈）→ exit 78。此前顶层
// await 无处置 → unhandled → exit 1 → supervisor 当崩溃退避重拉 ×5 →
// 熔断全下线：一行坏配置被误报为 crash，配置错误从不降级。78 协议在
// supervisor-core 早已就位，这里是缺失的 worker 发射点。
try {
  await ctx.plugin(Loader);
  await ctx.loader.create({
    name: '@agentchat/cordis-include',
    config: {
      path: './cordis.yml',
      ...(patches.length > 0 ? { patches } : {}),
    },
  });
} catch (err) {
  console.error(`[boot] 装载失败（配置/组合错误，不会自愈——退出码 ${EXIT_CONFIG}，supervisor 不重拉；修复配置后重启）:`);
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(EXIT_CONFIG);
}

// ---- M25 §3.4 / N1：boot 末一次性清扫（组合根认领点） ----
// 行序 ≠ 激活序（loader 并发创建行）——出厂行注册可能先于 ac-event-policy
// 就位（逃逸拦截），组合根收敛后对 _hooks 按停用集做单次清扫。程序化
// 路径（bootTree 无 loader、串行 await）由测试直调 sweep。
{
  const policy = ctx.get('eventPolicy', false) as { sweep(): number } | undefined;
  if (policy) {
    const removed = policy.sweep();
    if (removed > 0) console.log(`[boot] 事件治理清扫：移除 ${removed} 条已停用监听器`);
  }
}

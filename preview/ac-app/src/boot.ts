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
//   2. chdir 到 preview/（官方 bin.js 以 cwd 为 baseUrl，读 ./cordis.yml）；
//   3. **内联官方 bin.js 的 16 行**（M23 A2：Context → Loader → include）——
//      官方路径是动态 import 写死 config，不内联无法注入 patches。内联
//      先例：ac-app/src/boot-yml-main.ts。装载前读行偏好层
//      <AGENTCHAT_DATA_ROOT>/cordis.patch.yml（不存在/损坏 = warn + 空数组，
//      fail-soft——文件人可读可手工急救）注入 include config 的 patches。
//      出厂态不变量：cordis.yml 永不被运行时写入（include 挂 loader 内存
//      根树、Loader.write() 无文件 no-op——F10 守卫测试锁定）。
// ============================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { Context } from '@agentchat/cordis';
import { pathToFileURL } from 'node:url';
import Loader from '@agentchat/cordis-loader';
import { readPatchFile, type PatchFileEntry } from 'ac-plugin-core';

const launchCwd = path.resolve(process.env.INIT_CWD || process.cwd());
if (!process.env.AGENTCHAT_DATA_ROOT) {
  process.env.AGENTCHAT_DATA_ROOT = launchCwd;
}
console.log(`[boot] 启动文件夹（INIT_CWD 回落 cwd）: ${launchCwd}`);
console.log(`[boot] 持久化数据根（AGENTCHAT_DATA_ROOT）: ${process.env.AGENTCHAT_DATA_ROOT}`);
console.log(`[boot] 装配根（chdir → cordis.yml 所在目录）: ${fileURLToPath(new URL('../../', import.meta.url))}`);

process.chdir(path.resolve(fileURLToPath(new URL('../../', import.meta.url))));

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

await ctx.plugin(Loader);
await ctx.loader.create({
  name: '@agentchat/cordis-include',
  config: {
    path: './cordis.yml',
    ...(patches.length > 0 ? { patches } : {}),
  },
});

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

// ============================================================
// scripts/run-tests.mjs —— 测试编排（分档运行）
//
// 档位：
//   unit         只跑快用例（*.test.ts 去掉集成件）—— 本地日常循环
//   integration  只跑集成件（*.integration.test.ts，限流 8 路）
//   all          全量单次运行（缺省；CI/发布门用，与改造前逐字等价）
//   watch        unit 档 watch 模式
//
// 为什么 all 不做成「unit + integration 两段串行」：实测全量墙钟由单个
// 最长文件决定（shell-tools 自身 ~36s），两段串行 = 21s + 33s = 54s，
// 反而比单次全并发（~44s）慢——分档的价值在【快循环】与【定向跑限流】，
// 不在给全量门提速。
//
// 为什么档位不用 vitest projects（单进程内并发跑各 project）：globalSetup
//（scripts/vitest-global-setup.mjs）在【模块加载期】rmSync 共享测试数据根
// workspace/test，而各 worker 的 cwd 正是其下分桶（workspace/test/wN——见
// vitest-setup-chdir.mjs）。projects 并发触发各自的 globalSetup → 一边
// worker 驻留 wN，另一边把整棵树删掉：Windows 句柄被占即 EPERM，Linux 上
// worker cwd 失效。故分档只能是【进程级隔离】。
//
// 附加参数透传：node scripts/run-tests.mjs unit --reporter=verbose
// ============================================================
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
// 显式用仓库根的 vitest 入口：包目录下（如 src/webui 声明 vite ^5）局部
// vitest 会绑到不兼容的 vite 版本（vitest 4 的 peer 要求 vite ^6），
// 根入口恒定解析到根依赖树。
const VITEST_ENTRY = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

// 参数形态：run-tests.mjs [档位] [vitest 过滤参数…]
//   档位：unit | integration | all | watch（缺省 all）
//   其余 token 透传 vitest 作过滤器（root 相对路径子串，如 src/ac-math）。
// 包内委派（package.json scripts.test = "node ../../scripts/run-tests.mjs .")：
//   vitest 的过滤器只认【root 相对路径】的子串匹配（绝对路径/包内相对
//   路径均不命中）——「.」占位由本脚本换算成 root 相对包路径注入。
const MODES = new Set(['unit', 'integration', 'all', 'watch']);
const argv = process.argv.slice(2);
let mode = 'all';
let passthrough = [];
for (let i = 0; i < argv.length; i++) {
  const t = argv[i];
  if (MODES.has(t)) { mode = t; continue; }
  if (t === '.') {
    // 包内占位：cwd（= 包目录）换算 root 相对路径（posix 形）
    const rel = relative(REPO_ROOT, process.cwd()).split(sep).join('/');
    if (rel && !rel.startsWith('..')) passthrough.push(rel);
    continue;
  }
  passthrough = argv.slice(i); // 首个 vitest 参数起整体透传
  break;
}

/** 起一个 vitest 进程（profile 经 env 注入——配置据此选 include/exclude） */
function runVitest(profile, watch) {
  return new Promise((resolve) => {
    const args = [VITEST_ENTRY];
    if (!watch) args.push('run');
    args.push(...passthrough);
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, VITEST_PROFILE: profile },
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

// pnpm -r test 不受支持（也不应支持）：127 包并行起 vitest 进程会在
// 共享测试数据根 workspace/test 上互相踩踏（globalSetup 模块加载期
// rmSync 重建，见 vitest-global-setup.mjs）——pnpm 任务图还因「同脚本
// 委派」判环 ERR_PNPM_TASK_CYCLE。全仓测试走根目录 pnpm test（单次
// vitest，worker 级分桶隔离）；包内 test 脚本 = 定向跑本包用例。
let code = 0;
if (mode === 'unit') {
  code = await runVitest('unit', false);
} else if (mode === 'integration') {
  code = await runVitest('integration', false);
} else if (mode === 'watch') {
  code = await runVitest('unit', true);
} else if (mode === 'all') {
  code = await runVitest('all', false);
} else {
  console.error(`未知档位 "${mode}"——可用：unit | integration | all | watch`);
  process.exit(2);
}
// mode 到此必为合法值（else 分支已 exit）

process.exit(code);

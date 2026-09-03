// ============================================================
// scripts/vitest-setup-chdir.mjs —— vitest setupFiles：测试进程数据根重定位
//
// process.chdir(<repo>/workspace/test)：所有服务的 './data' 缺省链
// （root ?? env ?? './data'，相对 cwd 解析）整体落到集中管理的
// workspace/test/data；**不设 AGENTCHAT_DATA_ROOT**——ac-group/
// ac-conversation 的"env 未设 = 纯内存态"语义是多数单测的隐含前提，
// 全局设 env 会打开持久化造成跨测试踩踏（曾致 9 红）。
// 生产入口（boot.ts/chat.ts）自行锚定 env，不受影响。
// ============================================================
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const TEST_ROOT = join(REPO_ROOT, 'workspace', 'test');

mkdirSync(TEST_ROOT, { recursive: true });
process.chdir(TEST_ROOT);

// ============================================================
// rowOptionsFor 单测（cr-754）：fs/shell 族沙箱基准注入退役——
// WorkspaceShim 恒在场且优先，行 options workdir 恒被遮蔽（cr-589
// 的 sandbox/<agentId> 注入是死配置）。行 options 只剩各行自身锚点。
// 数据根恒 sandbox 独立目录（红线）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { rowOptionsFor } from '../src/index.ts';

const ROOT = path.resolve('sandbox/row-options-test-' + process.pid);
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('rowOptionsFor（cr-754 沙箱基准退役）', () => {
  it('fs/shell 四行不再注 workdir——基准单源 = WorkspaceShim files/<agentId>', () => {
    const opts = rowOptionsFor(ROOT, path.join(ROOT, 'agents', 'alpha'));
    expect(opts['fs-tools']).toBeUndefined();
    expect(opts['fs-search']).toBeUndefined();
    expect(opts['str-replace-editor']).toBeUndefined();
    // cr-718：任务日志锚数据根 .runtime/tmp（%TEMP% 拒写环境下后台任务仍可用）
    expect(opts['shell-tools']).toEqual({ logDir: path.join(ROOT, '.runtime', 'tmp') });
    // 死目录物种不再生产：sandbox/<agentId> 不建
    expect(fs.existsSync(path.join(ROOT, 'sandbox'))).toBe(false);
  });

  it('既有行面不受扰（root 锚点照旧）', () => {
    const opts = rowOptionsFor(ROOT);
    expect(opts['config']).toEqual({ root: ROOT });
    expect(opts['durable-interaction']).toEqual({ root: path.join(ROOT, 'agents', '_shell') });
  });
});

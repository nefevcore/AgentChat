// ============================================================
// rowOptionsFor 单测（cr-589）：pwsh/fs 族沙箱 workdir 基准 = per-agent
// 专用空间（<dataRoot>/sandbox/<agentId>，mkdir 保障）；agentId 缺席 =
// 不传（行回落自身缺省）。数据根恒 preview/sandbox 独立目录（红线）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { rowOptionsFor } from '../src/index.ts';

const ROOT = path.resolve('preview/sandbox/row-options-test-' + process.pid);
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('rowOptionsFor（cr-589 pwsh/fs 沙箱基准）', () => {
  it('agentId 给定：四行 workdir = <dataRoot>/sandbox/<agentId>（目录建出）；其余行不受扰', () => {
    const opts = rowOptionsFor(ROOT, path.join(ROOT, 'agents', 'alpha'), 'alpha');
    const expectDir = path.join(ROOT, 'sandbox', 'alpha');
    expect(fs.existsSync(expectDir)).toBe(true); // pwsh 以 cwd spawn——目录须存在
    expect(opts['fs-tools']).toEqual({ workdir: expectDir });
    expect(opts['fs-search']).toEqual({ workdir: expectDir });
    expect(opts['str-replace-editor']).toEqual({ workdir: expectDir });
    expect(opts['shell-tools']).toEqual({ workdir: expectDir });
    // 既有行面不受扰（root 锚点照旧）
    expect(opts['config']).toEqual({ root: ROOT });
    expect(opts['durable-interaction']).toEqual({ root: path.join(ROOT, 'agents', 'alpha') });
  });

  it('agentId 缺席：四行空 options（行回落 process.cwd() 缺省——兼容旧装配面）', () => {
    const opts = rowOptionsFor(ROOT);
    expect(opts['fs-tools']).toEqual({});
    expect(opts['shell-tools']).toEqual({});
    expect(fs.existsSync(path.join(ROOT, 'sandbox'))).toBe(false);
  });
});

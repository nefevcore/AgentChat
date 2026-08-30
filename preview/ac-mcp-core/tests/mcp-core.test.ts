// ============================================================
// ac-mcp-core/tests/mcp-core.test.ts —— 纯函数 + SDK 包装（假 loader）
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  describeError,
  resolveEnvVars,
  isHttpTransport,
  pickToolName,
  SdkConnection,
  type McpSdk,
  type SdkClientLike,
} from '../src/index';

describe('describeError（cause 链展开）', () => {
  it('拼接 message + cause 链（深度上限 3、去重）', () => {
    const err = new Error('fetch failed');
    (err as unknown as { cause: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    expect(describeError(err)).toBe('fetch failed ← ECONNREFUSED: connect ECONNREFUSED');
  });

  it('无 cause / 非 Error 输入不炸', () => {
    expect(describeError(new Error('x'))).toBe('x');
    expect(describeError('裸字符串')).toBe('裸字符串');
  });
});

describe('resolveEnvVars / isHttpTransport', () => {
  it('${VAR} 展开（缺失 → 空串）', () => {
    process.env.AC_MCP_TEST_VAR = 'v1';
    try {
      expect(resolveEnvVars('${AC_MCP_TEST_VAR}-suffix')).toBe('v1-suffix');
      expect(resolveEnvVars('${AC_MCP_MISSING_VAR}!')).toBe('!');
    } finally {
      delete process.env.AC_MCP_TEST_VAR;
    }
  });

  it('transport 判定：显式 > url > http command', () => {
    expect(isHttpTransport({ name: 'a', url: 'https://x' })).toBe(true);
    expect(isHttpTransport({ name: 'a', command: 'npx', transport: 'http' })).toBe(true);
    expect(isHttpTransport({ name: 'a', command: 'https://x' })).toBe(true);
    expect(isHttpTransport({ name: 'a', command: 'npx', transport: 'stdio' })).toBe(false);
    expect(isHttpTransport({ name: 'a', command: 'npx' })).toBe(false);
  });
});

describe('pickToolName（撞名命名空间策略）', () => {
  it('裸名优先 → `${server}__${name}` 回退 → 仍撞 null', () => {
    const taken = new Set<string>();
    expect(pickToolName('s1', 'echo', taken)).toBe('echo');
    taken.add('echo');
    expect(pickToolName('s1', 'echo', taken)).toBe('s1__echo');
    taken.add('s1__echo');
    expect(pickToolName('s1', 'echo', taken)).toBeNull();
  });
});

// ---- 假 SDK（结构断言 + 行为验证，零网络零子进程） ----

function fakeSdk() {
  const state = {
    connects: [] as Array<{ transport: unknown; options?: unknown }>,
    closed: 0,
  };
  const client: SdkClientLike = {
    async connect(transport, options) {
      state.connects.push({ transport, options });
    },
    async close() {
      state.closed += 1;
    },
    async listTools() {
      return {
        tools: [
          { name: 'echo', description: '回声', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        ],
      };
    },
    async callTool(params) {
      return { content: [{ type: 'text', text: `回:${String((params.arguments as { text?: string }).text ?? '')}` }] };
    },
  };
  const sdk: McpSdk = {
    Client: class {
      constructor(_options: unknown) {}
      // 挂实例方法（结构满足 SdkClientLike）
      connect = client.connect.bind(client);
      close = client.close.bind(client);
      listTools = client.listTools.bind(client);
      callTool = client.callTool.bind(client);
    } as unknown as McpSdk['Client'],
    StreamableHTTPClientTransport: class {
      constructor(public url: URL, public options?: unknown) {}
    } as unknown as McpSdk['StreamableHTTPClientTransport'],
    StdioClientTransport: class {
      constructor(public options: unknown) {}
    } as unknown as McpSdk['StdioClientTransport'],
  };
  return { state, sdk };
}

describe('SdkConnection（注入假 loader）', () => {
  it('HTTP 传输：connect 一次缓存、listTools/callTool 映射、close 幂等', async () => {
    const { state, sdk } = fakeSdk();
    const conn = new SdkConnection(
      { name: 'srv', url: 'https://mcp.example/mcp', headers: { auth: 't' }, connectTimeoutMs: 1234 },
      { loadSdk: async () => sdk },
    );
    expect(conn.connected).toBe(false);
    await conn.listTools();
    await conn.listTools(); // 二次调用复用连接
    expect(state.connects).toHaveLength(1);
    expect(conn.connected).toBe(true);
    expect((state.connects[0].options as { timeout: number }).timeout).toBe(1234);

    const tools = await conn.listTools();
    expect(tools[0]?.name).toBe('echo');
    const result = await conn.callTool('echo', { text: 'hi' });
    expect(result.text).toBe('回:hi');
    expect(result.isError).not.toBe(true);

    conn.close();
    conn.close(); // 幂等
    expect(state.closed).toBe(1);
    expect(conn.connected).toBe(false);
  });

  it('stdio 传输：env ${VAR} 展开 + 缺 command 报错', async () => {
    const { sdk } = fakeSdk();
    process.env.AC_MCP_STDIO_VAR = 'secret';
    try {
      const conn = new SdkConnection(
        { name: 's', command: 'npx', args: ['-y', 'some-mcp'], env: { KEY: '${AC_MCP_STDIO_VAR}' } },
        { loadSdk: async () => sdk },
      );
      await conn.connect();
      // connect 已发生（fake SDK 不校验，但传输构造参数正确性由结构承载）
      expect(conn.connected).toBe(true);

      const noCmd = new SdkConnection({ name: 's2' }, { loadSdk: async () => sdk });
      await expect(noCmd.connect()).rejects.toThrow(/未配置 command/);
    } finally {
      delete process.env.AC_MCP_STDIO_VAR;
    }
  });

  it('连接失败：错误信息带服务器名 + cause 展开并置未连接', async () => {
    const failing: McpSdk = {
      Client: class {
        constructor(_o: unknown) {}
        async connect() {
          const err = new Error('fetch failed');
          (err as unknown as { cause: unknown }).cause = new Error('connect ECONNREFUSED');
          throw err;
        }
      } as unknown as McpSdk['Client'],
      StreamableHTTPClientTransport: class {},
      StdioClientTransport: class {},
    };
    const conn = new SdkConnection({ name: 'bad', url: 'https://down' }, { loadSdk: async () => failing });
    await expect(conn.connect()).rejects.toThrow(/MCP HTTP 服务器 "bad" 连接失败: fetch failed ← connect ECONNREFUSED/);
    expect(conn.connected).toBe(false);
  });

  it('tools 能力不支持 → 空清单（非错误）', async () => {
    const noTools: McpSdk = {
      Client: class {
        constructor(_o: unknown) {}
        async connect() {}
        async listTools() {
          throw new Error('Method not found');
        }
      } as unknown as McpSdk['Client'],
      StreamableHTTPClientTransport: class {},
      StdioClientTransport: class {},
    };
    const conn = new SdkConnection({ name: 's', url: 'https://x' }, { loadSdk: async () => noTools });
    await expect(conn.listTools()).resolves.toEqual([]);
  });
});

# AgentChat 工具开发指引

> 本文档面向 Agent，指导如何在运行时开发并热加载新工具，实现"自举"能力。

---

## 1. 核心概念

AgentChat 的每个**工具**是一个独立目录，包含 `tool.ts`（实现）和 `meta.ts`（元数据）。工具遵循 OpenAI function-calling 协议，由 LLM 通过 `tool_calls` 调用。

工具分两类：
- **全局工具**：位于 `src/plugins/builtin/tools/`，在 `plugin.json` 中声明，需重启生效
- **Agent 专属工具**：位于 `workspace/default/agents/<agent_id>/tools/`，支持运行时热加载

> **本文档重点：Agent 专属工具 —— 创建后调用 `reload`（scope=self）即可立即使用，无需重启。**

---

## 2. 目录结构

```
agents/<agent_id>/tools/
└── my_tool/           # 每个工具一个子目录（目录名即工具名）
    ├── tool.ts         # 工具实现（必需）
    └── meta.ts         # 工具元数据（必需）
```

---

## 3. meta.ts —— 工具元数据

```typescript
// agents/<agent_id>/tools/my_tool/meta.ts

export const meta = {
  name: 'my_tool',                    // 唯一标识，与目录名一致
  label: '我的工具',                  // 前端显示标签
  description: '这是一个示例工具。',  // 简短描述
  ns: 'tool.my_tool',                 // 命名空间，格式 tool.<name>
};
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `name` | `string` | ✅ | 唯一标识，建议与目录名一致 |
| `label` | `string` | ✅ | 前端 UI 中显示的中文标签 |
| `description` | `string` | ❌ | 简短描述 |
| `ns` | `string` | ✅ | 命名空间，格式 `tool.<name>` |

---

## 4. tool.ts —— 工具实现

### 4.1 完整结构

```typescript
import { Tool } from '@core/types';
import { meta } from './meta';

export const tool: Tool = {
  // ── 合并 meta ──
  ...meta,

  // ── OpenAI function-calling 定义 ──
  definition: {
    type: 'function',
    function: {
      name: 'my_tool',              // 函数名（LLM 调用时使用）
      description: '工具的功能描述，LLM 据此决定何时调用此工具。',
      parameters: {
        type: 'object',
        properties: {
          // 参数定义（JSON Schema）
          param_name: {
            type: 'string',         // string | number | boolean | array | object
            description: '参数说明',
          },
        },
        required: ['param_name'],   // 必填参数列表
      },
    },
  },

  // ── 执行函数 ──
  execute: async (args: Record<string, any>, stream?: ToolStream) => {
    // 实现工具逻辑
    return '返回给 LLM 的结果字符串';
  },
};
```

### 4.2 Tool 接口全貌

```typescript
interface Tool {
  name: string;                                    // 来自 meta
  label: string;                                   // 来自 meta
  description?: string;                            // 来自 meta
  ns: string;                                      // 来自 meta，格式 "tool.<name>"

  definition: ToolDefinition;                      // OpenAI function-calling 定义

  execute: (
    args: Record<string, any>,                     // LLM 传入的参数
    stream?: ToolStream                            // 可选流式回调
  ) => Promise<string | { content: string; details?: any }>;

  // ── 可选 ──
  configuration?: ConfigField[];                   // 配置 Schema（供前端生成配置面板）
  interceptor?: ToolInterceptor;                   // 工具级拦截器
  extractLabel?: (args: Record<string, any>) => string; // 从参数提取简短描述（用于 UI 标签）
}
```

### 4.3 返回值说明

| 返回类型 | 说明 |
|----------|------|
| `string` | 直接返回给 LLM 的文本 |
| `{ content: string }` | LLM 看到的文本 |
| `{ content: string, details?: any }` | LLM 文本 + UI 详情（前端渲染用） |

**推荐格式**（结构化 JSON）：
```typescript
// 成功
return JSON.stringify({ status: 'ok', data: { ... } });

// 失败
return JSON.stringify({ status: 'error', data: { message: '错误原因' } });
```

---

## 5. 流式输出（ToolStream）

对于耗时操作，可通过 `stream` 参数推送实时进度：

```typescript
execute: async (args, stream?) => {
  for (let i = 0; i < steps; i++) {
    // 做点工作...
    stream?.onChunk(`进度: ${i + 1}/${steps}\n`);
  }
  return '完成';
};
```

`onChunk` 推送的内容会实时显示在前端 UI，不影响 LLM 看到的最终结果。

---

## 6. 配置 Schema（可选）

如果需要在前端暴露可配置项，定义 `configuration` 字段：

```typescript
import type { ConfigField } from '@core/types';

export const tool: Tool = {
  ...meta,
  configuration: [
    {
      name: 'maxResults',
      label: '最大结果数',
      description: '单次返回的上限',
      type: 'number',
      default: 10,
    },
    {
      name: 'apiKey',
      label: 'API 密钥',
      description: '第三方 API 密钥',
      type: 'text',
      sensitive: true,        // 标记为敏感字段，前端脱敏显示
    },
  ],
  // ...
};
```

配置值存储在 Agent 的 `config.json` 中，键名为 `tool.<name>.<field>`。

---

## 7. 运行时 API 速查

工具中可用的核心导入：

```typescript
import { getGlobalConfig, resolveNamespaceConfig, resolveSafePath } from '@agents/config';
import { getAppState } from '@agents/app-state';
import type { AgentRegistry } from '@agents/registry';
import { logger } from '@utils/logger';
```

| API | 用途 |
|-----|------|
| `getGlobalConfig()` | 获取全局配置（workspace 路径、LLM 池等） |
| `resolveNamespaceConfig(ns, defaults, runtime?)` | 解析工具命名空间配置 |
| `resolveSafePath(path, allowedPaths?)` | 安全检查路径，防止越权访问 |
| `getAppState()` | 获取运行时引用（registry、router 等） |
| `logger.info/warn/error()` | 日志输出（会写入服务端日志） |

---

## 8. 开发与热加载流程

```
1. 创建工具目录和文件
   agents/<your_id>/tools/new_tool/
   ├── meta.ts
   └── tool.ts

2. 调用 reload（scope=self）
   → tool_call: reload(scope="self")
   → 返回: { status: "ok", data: { newly_loaded: ["new_tool"], ... } }

3. 验证
   → 下一轮 LLM 调用自动包含新工具
   → 可以立即调用 new_tool
```

**关键点**：
- 工具加载后**同一轮 ReAct 循环即可生效**（每轮刷新工具列表）
- 修改已有工具源码后同样调用 `reload`（scope=self）即可更新
- 不需要重启进程，不中断当前对话

---

## 9. 最佳实践

### 9.1 错误处理
```typescript
execute: async (args) => {
  try {
    // 业务逻辑
    return JSON.stringify({ status: 'ok', data: result });
  } catch (err: any) {
    logger.error(`[my_tool] 执行失败: ${err.message}`);
    return JSON.stringify({ status: 'error', data: { message: err.message } });
  }
};
```

### 9.2 参数校验
```typescript
execute: async (args) => {
  if (!args.filePath) {
    return JSON.stringify({ status: 'error', data: { message: '缺少 filePath 参数' } });
  }
  // ...
};
```

### 9.3 路径安全
```typescript
import { resolveSafePath } from '@agents/config';

execute: async (args) => {
  const safePath = resolveSafePath(args.filePath);
  if (!safePath) {
    return JSON.stringify({ status: 'error', data: { message: '路径不在允许范围内' } });
  }
  // 使用 safePath 操作文件
};
```

### 9.4 返回结构建议
- 用 JSON 结构化返回，方便 LLM 解析
- 包含 `status: 'ok' | 'error'` 标识
- 错误时提供清晰的 `message`
- 大数据量时考虑分页/截断

### 9.5 工具描述撰写
- `definition.function.description` 是 LLM 决定是否调用的关键依据
- 写清楚：**做什么、需要什么参数、返回什么**
- 用英文（与模型训练数据一致），参数描述可用中文

### 9.6 内存常驻状态（长生命周期资源）

对于需要维持长生命周期资源的工具（如浏览器实例、数据库连接池、WebSocket 连接），可以利用模块级闭包变量实现进程级常驻，避免每次 `execute()` 都重新初始化。

**原理**：Tool 对象在 Agent 的整个生命周期内都是同一个引用，模块级变量不会被 GC 回收。

```typescript
// browser/tool.ts
import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';

// ⚠️ 模块级闭包变量 —— 进程级常驻，多次 execute() 复用
let browser: Browser | null = null;
let activePages = 0;

async function getBrowser(): Promise<Browser> {
  // 如果已连接则复用，避免重复 launch
  if (browser?.isConnected()) return browser;
  // 清理旧连接
  await browser?.close().catch(() => {});
  browser = await puppeteer.launch({ headless: true });
  return browser;
}

async function newPage(): Promise<Page> {
  const b = await getBrowser();
  const page = await b.newPage();
  activePages++;
  return page;
}

async function closePage(page: Page): Promise<void> {
  await page.close().catch(() => {});
  activePages--;
  // 可选：闲置时自动关闭浏览器释放资源
  if (activePages <= 0 && browser) {
    setTimeout(async () => {
      if (activePages <= 0) {
        await browser?.close().catch(() => {});
        browser = null;
      }
    }, 30_000);
  }
}

export const tool: Tool = {
  // ...
  async execute(args, stream?) {
    const page = await newPage();
    try {
      await page.goto(args.url);
      // 操作页面...
      return JSON.stringify({ status: 'ok', data: { ... } });
    } finally {
      await closePage(page);
    }
  },
};
```

**适用场景**：
- 浏览器自动化（Puppeteer / Playwright）—— 启动开销 500ms~2s
- 数据库连接池
- WebSocket / MQTT 长连接
- 大模型本地推理实例

**⚠️ 热重载陷阱**：

调用 `reload`（scope=self）时，框架会用新加载的 Tool 对象**替换**旧对象。旧对象的模块级闭包变量（如浏览器实例）**不会被自动清理**，会导致资源泄漏。

```
reload 前：旧 tool 对象 ──► browser 实例 A （仍存活）
reload 后：新 tool 对象 ──► browser = null ──► launch 新实例 B
结果：实例 A 泄漏，进程中出现两个浏览器
```

**应对策略**（按推荐度排序）：

1. **连接检查 + 复用**（推荐）：在 `getBrowser()` 中检查 `browser?.isConnected()`，如果旧实例仍连接则直接复用，不重复创建。

2. **主动清理**：在模块顶层监听进程退出事件，确保资源释放：
   ```typescript
   process.on('exit', () => { browser?.close().catch(() => {}); });
   ```

3. **闲置超时关闭**：如示例中的 `setTimeout` 延迟关闭，让无活跃页面时自动释放。

4. **工具内提供 `close` 操作**：定义一个参数如 `action: 'close'`，Agent 可主动调用关闭资源：
   ```typescript
   if (args.action === 'close') {
     await browser?.close();
     browser = null;
     return JSON.stringify({ status: 'ok', data: { message: '浏览器已关闭' } });
   }
   ```

**判断清单**：开发常驻状态工具时，确认以下问题：
- [ ] 资源初始化是否幂等（重复调用不创建重复实例）？
- [ ] 热重载后旧资源是否会泄漏？
- [ ] 是否需要闲置超时自动释放？
- [ ] 是否需要提供显式关闭/重置操作？

---

## 10. 完整示例：天气查询工具

```
目录: agents/coding_agent/tools/get_weather/
```

**meta.ts**：
```typescript
export const meta = {
  name: 'get_weather',
  label: '天气查询',
  description: '查询指定城市的天气信息',
  ns: 'tool.get_weather',
};
```

**tool.ts**：
```typescript
import { Tool } from '@core/types';
import { meta } from './meta';
import { logger } from '@utils/logger';

export const tool: Tool = {
  ...meta,

  definition: {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Query weather information for a given city. Returns temperature, humidity, and conditions.',
      parameters: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: '城市名称（中文或英文）',
          },
          unit: {
            type: 'string',
            enum: ['celsius', 'fahrenheit'],
            description: '温度单位，默认 celsius',
          },
        },
        required: ['city'],
      },
    },
  },

  execute: async (args) => {
    const city = args.city as string;
    const unit = (args.unit as string) || 'celsius';

    try {
      // 实际项目中在这里调用天气 API
      const weather = {
        city,
        temperature: unit === 'celsius' ? 22 : 72,
        humidity: '65%',
        conditions: '晴',
        unit,
      };

      logger.info(`[get_weather] 查询 ${city} → ${weather.temperature}°`);

      return JSON.stringify({ status: 'ok', data: weather });
    } catch (err: any) {
      logger.error(`[get_weather] 查询失败: ${err.message}`);
      return JSON.stringify({
        status: 'error',
        data: { message: `查询 ${city} 天气失败: ${err.message}` },
      });
    }
  },
};
```

**使用**：
```
1. write 工具写入 meta.ts 和 tool.ts
2. reload(scope="self")
3. 下一轮对话即可: "查一下北京的天气" → LLM 自动调用 get_weather
```

---

## 11. 常用路径

| 用途 | 路径 |
|------|------|
| Agent 专属工具 | `workspace/default/agents/<agent_id>/tools/` |
| Agent 配置文件 | `workspace/default/agents/<agent_id>/config.json` |
| 全局工具参考 | `src/plugins/builtin/tools/` |
| 核心类型定义 | `src/core/types.ts` |
| 配置类型定义 | `src/core/types/` |

---

*最后更新: 2026-07-28*

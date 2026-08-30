# 工具能力标签扩展设计（记录，暂不实施）

> 状态：**设计记录** · 当前未实施
> 版本：v0.6.3（2026-08-16）
> 关联实现：`src/core/agent-config/src/index.ts`（能力词汇表）、`src/tools/tools/src/service.ts`（requires 解析）
> 注：`register_tool` 已于 2026-08-20 移除（动态能力收敛到 register_plugin 插件路径）；文中涉及 register_tool 的"当前行为"条目按写作时点保留，仅存参考价值。

---

## 1. 背景

v0.6.3 把工具能力标签收敛为四个受控词汇：

```ts
TOOL_CAPABILITIES = ['base', 'dev', 'admin', 'conductor']
```

- `base`：隐式基础能力层（旧 `agent` 读取时自动归一化为 `base`）
- `dev`：开发调试能力
- `admin`：平台管理能力
- `conductor`：编排/调度能力

与此同时，架构上出现了一个开放性问题：**第三方插件作者想引入自定义能力词汇怎么办？**

本文记录当前实际行为、已知问题与未来推荐方案，暂不实施。

---

## 2. 当前实际行为

严格来说，`TOOL_CAPABILITIES` 只是**保留词汇 + 内置工具盘点基准**，并不是全局硬门禁：

| 路径 | 当前行为 |
|------|----------|
| 源码插件声明 `requires: ['vip']` | ✅ 可用。Agent 配置 `tags: ['vip']` 后即可命中 |
| WebUI 标签徽章 | ✅ `AgentPane` 会扫描工具目录里的全部 requires，自动把 `vip` 显示成徽章（排在 `base/admin/dev/conductor` 之后） |
| `update_agent_profile` / `security-check` | ✅ `tags` 仍接受任意字符串 |
| 运行时 `register_tool` | ❌ 已限制为只能 `base/dev/admin/conductor`，自定义词汇会被拒绝 |

因此：

- **源码插件**的自定义能力词汇当前“隐式可用”
- **运行时注册工具**的自定义能力词汇当前“不可用”

---

## 3. 已知问题

1. **没有元数据**：自定义词汇 `vip` 在 UI 上只能显示 `vip · vip`，没有中文说明，Agent/用户不知道它代表什么。
2. **发现依赖注册表**：插件装载后，`requires: ['vip']` 会出现在工具目录里，UI 能发现；插件卸载后 `vip` 会变成孤立死标签留在 Agent 配置里，无法追溯来源。
3. **没有冲突保护**：两个插件都用 `qa` 可能语义不同，互相污染。
4. **动态注册被卡死**：第三方无法在 `register_tool` 中注册带新词汇的运行时工具。
5. **没有归属校验**：源码插件可以声明任意 requires，catalog 阶段不做提示，插件作者容易拼错或“偷偷造词”。

---

## 4. 推荐方案：两层能力词汇模型（暂不实施）

把能力词汇分成两层：

```ts
// 第一层：保留基础词汇（内置工具使用，固定含义，插件不可重定义）
['base', 'dev', 'admin', 'conductor']

// 第二层：插件声明的自定义能力（开放扩展）
PluginManifest.capabilities?: Array<{
  name: string;                 // 如 'audit'，命名规则校验
  label?: string;               // UI 显示，如 '审计'
  description?: string;         // hover 说明
}>
```

### 4.1 后端 catalog / AssemblyView 透出

- 插件 catalog 汇总 `manifest.capabilities`
- `AssemblyView` 新增 `capabilities` 字段
- 与工具目录的 `requires` 反查合并（同现有 `provides` 反查模式）
- 未声明但被源码插件引用的能力词汇，catalog 阶段给出 warning（自查用）

### 4.2 UI 展示

- 标签徽章优先用 manifest 的 `label` / `description` 展示
- 自定义标签输入框升级为「已知能力」下拉 + 自由输入兜底
- 保留四个基础词汇固定展示，不允许插件 manifest 重定义

### 4.3 动态注册白名单扩展

`register_tool` 允许的 requires 变为：

```text
保留词汇（base/dev/admin/conductor）
∪
当前已装载插件在 manifest 中声明的 capabilities
```

未声明的词汇拒绝注册，防止拼写错误与隐性造词。

### 4.4 插件卸载提示（可选）

插件卸载时，检查还有哪些 Agent 使用了该插件声明的能力标签，输出提示：

```text
插件 "audit-tools" 声明的能力标签 "audit" 仍被 Agent A/B 使用，卸载后该标签会失效。
```

---

## 5. 决策

- **当前不做**：核心门禁保持现状，源码插件的自定义 requires 继续隐式可用。
- **后续触发条件**：当出现「第三方插件需要自定义能力词汇」或「插件市场需要能力治理」时，按第 4 节实施。
- **最小实施范围**（届时）：
  1. manifest 增加 `capabilities` 声明 + 校验
  2. catalog / AssemblyView 透出 capabilities
  3. UI 标签徽章显示 label / description
  4. `register_tool` 白名单改为「保留词 ∪ 已声明能力」
  5. 插件卸载时输出未使用提示（可选）

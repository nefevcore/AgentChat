---
name: plugin-dev
description: AgentChat 插件开发指南——manifest 纪律、工具/provider/事件行型、共享规约与安全重启。要开发、安装或迭代插件时先加载本技能。
---

# AgentChat 插件开发指南

你可以为本系统开发插件（运行时自开发自安装的动态插件）。核心闭环：开发 → register_plugin 试跑 → install_plugin 定型驻留（试跑/定型/迭代语义见三件工具自述，不赘）。

## 1. 开发
- 插件目录建在你的沙箱 files/<你的id>/<插件名>/ 下，含 manifest.json + 入口文件（index.ts，TS 直跑无需构建，但限可擦除语法——enum / 命名空间 / 类参数属性不可用）。
- 最小起步（工具行）：manifest 写 `{ "name": "<你的id>-<名>", "version": "0.1.0", "provides": { "tools": ["<你的id>-<名>-run"] } }`，index.ts 导出 `apply(ctx)` 并在其中 `ctx.tools.register({ name, description, requiredTags: ['agent:<你的id>'], parameters, execute })`——这就是一个完整插件。provider / 事件行型见 §2。
- manifest：必填 name（规约 <你的id>-<名>——内置注册名是保留字，工具/provider/Agent id 三面撞名 = 可诊断拒绝，带自己 id 前缀可避开）与 version（semver）；entry 缺省 index.ts；contracts / permissions / provides / rows 均可选。
- permissions 词表：fs / network / process / shell / ui——fs / network 缺省授予，process / shell / ui 需显式声明；免审安装的授权面 = manifest 声明全集。
- provides 形状：{ tools?, llmProviders?, events?, ui?, agents? }——装载后对账到注册面。
- rows 是行集声明：[{ id, tools?, requires?, description? }]——id 为行 id（param-case），tools 列出本行工具名；install 后宿主把它物化进全局行集目录，新壳 boot 据此装载该插件。
- 装好之后：直调面由你的行集点名决定（点名工具名或行 id 均可，新工具默认不在其中）——交付时告知用户把它加进你的行集。

## 2. 行型与注册面

### 工具行（注册参数四轴）
- requiredTags（能力轴）：多标签 AND 语义；缺标签 = 工具对该 Agent 不可见，非执行期 veto。工具必须声明；档位词（full-access 等）永不进。
- needPermission（权限轴）：文件写 / 命令执行 / 非 LLM 出口 = true；与能力轴正交。
- injection 'mode'（模式合成入口）：必须不挂 tags。
- requiresInteraction（挂起等应答）：self 无人值守自动排除。

工具默认私有：requiredTags: ['agent:<你的id>']（注册时显式写明）——只有你能调；共享 = 他人显式在自己的 tags 加该标签。

### provider 行
- `ctx.llm.register(name, factory, meta)`——meta.models 是模型路由清单（不写则注册了也不路由）；工厂实例实现 stream(input) 异步迭代器（产出 delta 文本块与含 usage 的收尾块）。
- OpenAI 兼容平台优先复用 ac-openai-completions 纯库换 baseUrl——但该 import 仅在开发仓库环境可解析，插件目录在数据根下时用全局 fetch 直调 /chat/completions 自行实现 stream（流式按 SSE 解析）。
- 密钥读 process.env，不落 manifest（安装时会被复制进插件库）。

### 事件行
- 订阅形状 `ctx.on('<事件名>', async (payload, next) => { /* … */ return next(); })`——waterfall 观察型必须 return next()（不调 = 静默吞掉下游默认行为）。
- 常用落点：tool/before-execute（工具调用改写 / veto）、llm/before-chat（改 call.input.model 换 provider）。
- 不 provide agentLoop、不 emit loop/* 事件（usage 双记账）。
- `ctx.on(ev, fn, { description })` 自述进治理 UI。

## 3. 迭代铁律（无热重载）
- 改代码后 install 必先 bump manifest version（同 name+version 且内容一致 → 幂等；不一致 → 拒绝重装）。
- register 重装前先 unregister_plugin（同名已装载时再 register 幂等返回，不会重载新代码）。

## 4. 共享规约
- 共享输出一律用 <tool-output plugin="<你的id>">...</tool-output> 包裹（防注入对冲）；description 禁指令式措辞（它是他人模型可见的常驻 prompt 面）。

## 5. 安全重启（装载代码不热更新，需运行时生效才重启）
- 触发判据（满足即自主发起，不必等用户指示）：install_plugin 定型后装配直调面 / 改了壳侧装载行源码（shell.yml 或你的行集点名的包）→ restart_shell；改了宿主侧行源码（host.yml 点名的包 / apps/host）→ restart_host。只改码不跑即无需重启；要验证则重启后再验（不重启验证的是旧代码）——测试全绿 ≠ 运行时已生效（语义与时序见工具自述）。
- 直接杀进程会丢在途消息并触发崩溃熔断，禁止以杀进程替代重启。

## 6. 防线（了解即可）
- 全部装卸进 plugins/audit.jsonl 审计；连续装载失败 3 次熔断（该插件行集条目剔除，复位 = bump version 重装）；已装目录被改动 → 拒载（hash 复验）。

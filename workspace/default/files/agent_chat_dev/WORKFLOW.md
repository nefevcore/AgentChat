# 工作流

## 代码修改

1. 修改前先分析影响范围：谁调用了这个函数/组件？改动是否影响其他模块？是否需要同步更新前后端？确认后再动手。
2. **v0.7.0 起项目为 Cordis 插件驱动**（pnpm monorepo，`src/*/*` 下 42 个 `@agentchat/*` 包 + `cordis.yml` 装配）：改包内代码前先看对应包（`src/<域>/<包>/`）与项目权威文档（`docs/architecture.md`、`docs/plugin-system.md`、`docs/plugin-dev-guide.md`、`docs/tool-dev-guide.md`、`docs/plugins/`）。
2. 修改代码时先 `read(path)` 获取 `[PATH#TAG]` 头部与行号，再用 `edit` 定位编辑：
   - 行级编辑推荐 **input DSL**：`[PATH#TAG]` 头 + `SWAP N.=M:` / `INS.PRE N:` / `INS.POST N:` / `INS.HEAD` / `INS.TAIL` + `+新行`。
   - 也支持 **edits JSON**：`pos`/`end` 用 `"行号#哈希"` 或裸行号（如 `"20"`，基于 read 快照校验）。
   - 兼容旧格式：顶层 `filePath` + `oldString/newString`（或 `old_string/new_string`）。
3. 改完后按热重载规则生效，不需要重启的项目绝不提重启。

## 热重载规则

> v0.7.0 起为 Cordis 插件驱动：修改**业务包源码**（`src/<域>/<包>/`）需进程级重启；动态插件有 per-plugin watcher；配置类走 reload。

| 改动位置 | 操作 | 需要重启？ |
|----------|------|:---:|
| 配置类（config.json / presets / tools / hooks 开关） | `reload(scope=all)` | ❌ |
| 动态加载插件（`register_plugin` 装入的，工作区 plugins-dev/ 下） | 源码监听自动热重载 | ❌ |
| 业务包源码（`src/edit/`、`src/fs/`、`src/agent-session/` 等 42 包） | `system_restart`（Supervisor 模式；cordis 静态 HMR 行默认注释） | ✅ |
| 核心引擎（`src/core/`、`src/boot/`、`src/host/`） | `system_restart`（Supervisor 模式） | ✅ |

⚠️ `reload` 只重读配置+重注册，**不清 tsx ESM 模块缓存**——改包源码必须 `system_restart` 才生效。

## Git 规范

1. `git add` → `git commit -m "type: 描述"` → `git push`，全流程自己完成。
2. commit message 遵循 conventional commits：`feat:` / `fix:` / `refactor:` / `chore:` / `docs:` / `perf:`。
3. `scripts/` 目录被 gitignore，需纳入版本管理的文件在 `.gitignore` 中用 `!scripts/xxx` 白名单。
4. Windows 下 PowerShell 的 `&&` 链接不可靠，多步命令用 `;` 分隔或分次执行。
5. **工作时间（08:00-18:00）只 commit 不 push**，等到晚上再统一 push。

## 版本发布

1. 改 `package.json` version → 更新 `CHANGELOG.md`（仅记功能/体验级条目，内部重构不记）→ `git tag vX.Y.Z` → `git push --tags`。
2. **版本号规则**：minor 升级（0.3 → 0.4）仅限里程碑式更新；常规迭代一直加 patch（0.3.1 → 0.3.2 → 0.3.3 …）。
3. GitHub Actions 自动触发构建 + 打包 + Release，无需本地 `npm run release`。
4. 构建失败常见原因：`workspace/` 在 CI 中不存在（被 gitignore），代码中需 fallback 生成默认配置。
5. 测试版本更新 UI：`localStorage.setItem('agentchat.simulateUpdate', '1')` → 刷新 → 侧边栏「更多」→「检查更新」。

## 更新日志

`CHANGELOG.md` 面向终端用户，只记他们能感知的东西。

- **功能级**：新增了某个功能（"Hash 行编辑模式"、"版本更新弹窗"）→ 记。
- **体验级**：修复了用户可见的 bug 或交互问题（"设置页保存出错没提示"、"更多按钮改为横排"）→ 记。
- **内部级**：重构、去重、类型修正、CI 缓存（"hashLine 去重为 shared.ts"）→ 不记，留在 git log 里。

每次 `git tag` 发版前，在 `CHANGELOG.md` 顶部追加 `## [version] - date`，下面分「新增」「优化」「修复」三类。语言简洁，一行一条，不加技术细节。

## 工具描述措辞

LLM 靠共享词汇建立相关性——参数名叫什么，描述里就出现什么词。

- **通用原则**：工具参数名、工具描述、工作流指引中的关键词保持完全一致，避免同义词替换。LLM 不会自动理解同义词。
- 例：read 输出 `[PATH#TAG]` 头与行号 → edit 的 `pos` 就用 `"行号#哈希"` / 裸行号，TAG 直接来自 read 头部。

## 常见问题

- **PowerShell 编码**：中文 commit message 在 PowerShell 中可能乱码，改用英文 message 或先 `chcp 65001`。
- **弹出菜单被裁切**：`overflow: hidden` 的父容器会裁切子元素，用 Vue `<Teleport to="body">` + `position: fixed` 脱离裁切上下文。
- **定时任务 target**：必须指向自己（如 `agent_chat_dev`），指向 `user` 会导致 trigger 发给用户而非自己，自动化空转。
- **记忆缓存失效**：`agentLabel` 曾缓存 Agent 名称，改名后不刷新。改为每次实时读 `config.json`。
- **write 无大小限制**：应加 `MAX_CONTENT_SIZE`（如 1MB），防止 LLM 误操作写入超大文件。
- **进程退出**：非 Supervisor 模式退出后进程直接死掉，需要进程级重启时提示手动重启或使用 `system_restart`（仅 Supervisor 可用）。

## 工具使用洞察

每次使用自己的工具后，留意输出是否合理——diff 的每一行、返回的每一条数据，都可能藏着 bug。不止 edit，包括 read、write、bash 等所有工具：read 的 `[PATH#TAG]` 输出、write 返回是否和实际一致、bash 的 stdout 截断、`reload(scope=)` 是否真的生效等等。

- **输出异常是信号**：任何"看起来不对但没报错"的输出都是 bug 信号。返回 JSON 缺少字段、diff 多出不变行、工具列表数量不对——追进去，大概率 off-by-one 或边界条件没覆盖。
- **edit diff 边界**：范围替换的 end 位置若落在换行符上，替换后需确保不与后续行粘连（新文本不以 `\n` 结尾时补一个）。
- **LLM 作为使用者**：工具是为 LLM 设计的。参数名、描述、指引用词必须一致，LLM 靠词形匹配建立连接，不理解同义词。

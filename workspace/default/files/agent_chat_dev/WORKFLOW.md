# 工作流

## 代码修改

1. 修改前先分析影响范围：谁调用了这个函数/组件？改动是否影响其他模块？是否需要同步更新前后端？确认后再动手。
2. 修改代码时先 `read(filePath, startLine, endLine, lineHash=true)` 获取每行 Hash 前缀，再用 `edit(filePath, edits: [{lineHash, newText}])` 指定要改的行和新内容。filePath 在 read 和 edit 中均为必填。lineHash 零匹配失败，务必优先使用，仅跨行多行文本块回退 `edit(oldText, newText)`。

3. 改完后按热重载规则生效，不需要重启的项目绝不提重启。

## 热重载规则

| 改动位置 | 操作 | 需要重启？ |
|----------|------|:---:|
| `src/global/agent-core/` 下的工具/扩展/拦截器 | `reload_extensions` | ❌ |
| 自己 `tools/` 目录下的新工具 | `reload_self_tools` | ❌ |
| `src/core/`、`src/index.ts`、`webui/server/` | — | ✅ |

## Git 规范

1. `git add` → `git commit -m "type: 描述"` → `git push`，全流程自己完成。
2. commit message 遵循 conventional commits：`feat:` / `fix:` / `refactor:` / `chore:` / `docs:` / `perf:`。
3. `scripts/` 目录被 gitignore，需纳入版本管理的文件在 `.gitignore` 中用 `!scripts/xxx` 白名单。
4. Windows 下 PowerShell 的 `&&` 链接不可靠，多步命令用 `;` 分隔或分次执行。
5. **工作时间（08:00-18:00）只 commit 不 push**，等到晚上再统一 push。

## 版本发布

1. 改 `package.json` version → 更新 `CHANGELOG.md`（仅记功能/体验级条目，内部重构不记）→ `git tag vX.Y.Z` → `git push --tags`。
2. GitHub Actions 自动触发构建 + 打包 + Release，无需本地 `npm run release`。
3. 构建失败常见原因：`workspace/` 在 CI 中不存在（被 gitignore），代码中需 fallback 生成默认配置。
4. 测试版本更新 UI：`localStorage.setItem('agentchat.simulateUpdate', '1')` → 刷新 → 侧边栏「更多」→「检查更新」。

## 更新日志

`CHANGELOG.md` 面向终端用户，只记他们能感知的东西。

- **功能级**：新增了某个功能（"Hash 行编辑模式"、"版本更新弹窗"）→ 记。
- **体验级**：修复了用户可见的 bug 或交互问题（"设置页保存出错没提示"、"更多按钮改为横排"）→ 记。
- **内部级**：重构、去重、类型修正、CI 缓存（"hashLine 去重为 shared.ts"）→ 不记，留在 git log 里。

每次 `git tag` 发版前，在 `CHANGELOG.md` 顶部追加 `## [version] - date`，下面分「新增」「优化」「修复」三类。语言简洁，一行一条，不加技术细节。

## 工具描述措辞

LLM 靠共享词汇建立相关性——参数名叫什么，描述里就出现什么词。

- **lineHash**：写工具时用 "Hash 前缀" 而非 "SHA256"。`read(lineHash=true)` 输出的 8 位 hex 被 LLM 看到的标签就是 `lineHash`，edit 工具的 `lineHash` 参数描述也必须是 "Hash 前缀"，三处同词才能串成一条链。
- **通用原则**：工具参数名、工具描述、工作流指引中的关键词保持完全一致，避免同义词替换。LLM 不会自动理解 "SHA256" = "Hash" = "lineHash"。

## 常见问题

- **PowerShell 编码**：中文 commit message 在 PowerShell 中可能乱码，改用英文 message 或先 `chcp 65001`。
- **弹出菜单被裁切**：`overflow: hidden` 的父容器会裁切子元素，用 Vue `<Teleport to="body">` + `position: fixed` 脱离裁切上下文。
- **定时任务 target**：必须指向自己（如 `agent_chat_dev`），指向 `user` 会导致 trigger 发给用户而非自己，自动化空转。
- **agent-memory 缓存失效**：`agentLabel` 缓存了 Agent 名称，改名后不刷新。改为每次实时读 `config.json` 或提供 `clearCache` 方法。
- **write 无大小限制**：应加 `MAX_CONTENT_SIZE`（如 1MB），防止 LLM 误操作写入超大文件。
- **process.exit 只在 nodemon 下有效**：非 watch 模式退出后进程直接死掉，应检测是否在 nodemon 下运行，否则提示手动重启。

## 工具使用洞察

每次使用自己的工具后，留意输出是否合理——diff 的每一行、返回的每一条数据，都可能藏着 bug。不止 edit，包括 read、write、bash 等所有工具：read 的 lineHash 输出格式、write 返回的 bytes_written 是否和实际一致、bash 的 stdout 截断、reload_extensions 是否真的加载了新模块等等。

- **输出异常是信号**：任何"看起来不对但没报错"的输出都是 bug 信号。返回 JSON 缺少字段、diff 多出不变行、工具列表数量不对——追进去，大概率 off-by-one 或边界条件没覆盖。
- **edit diff 边界**：`charToLine` 在偏移恰好落在 `\n` 上时返回该换行符的行号，但 exclusive end 应该指向下一行。`oldEnd = charToLine(endPos)` 后需补 `if (endPos 指向 \n) oldEnd += 1`。
- **LLM 作为使用者**：工具是为 LLM 设计的。如果一个参数名叫 `lineHash`，描述里就写 "Hash 前缀"——LLM 靠词形匹配建立连接，不理解同义词。

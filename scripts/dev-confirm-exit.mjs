// ============================================================
// dev-confirm-exit.mjs —— 给 `pnpm dev` 增加 Ctrl+C 退出确认
//
// 通过 `node --import` 在 dev 主进程启动前加载：
//   - 第一次 Ctrl+C：提示 确认退出 dev 吗？(y/N)
//   - 输入 y/yes：退出
//   - 输入 n 或其它内容（或再按一次 Ctrl+C）：取消，dev 继续运行
//   - 非 TTY 环境（CI 等）：不挂拦截，保持 Node 默认 Ctrl+C 行为
// ============================================================

import process from 'node:process'
import { isatty } from 'node:tty'

// Node 20+ 中 process.stdin.isTTY 已不可靠（Node 24 上为 undefined），
// 统一用 tty.isatty(fd) 判断是否为交互式终端。
const isInteractive = isatty(process.stdin.fd)

if (isInteractive) {
  let prompting = false
  let exiting = false
  let cleanupPrompt = null

  function cancelPrompt(message) {
    if (cleanupPrompt) {
      cleanupPrompt()
      cleanupPrompt = null
    }
    prompting = false
    process.stdout.write(`\n${message}\n`)
  }

  function handleSigint() {
    if (exiting) return

    // 正在确认时再次按 Ctrl+C = 取消退出
    if (prompting) {
      cancelPrompt('已取消退出，dev 继续运行')
      return
    }

    prompting = true
    const restorePaused = process.stdin.isPaused()
    process.stdout.write('\n确认退出 dev 吗？(y/N) ')

    process.stdin.resume()

    const onData = (chunk) => {
      const answer = String(chunk).trim().toLowerCase()
      const wasPrompting = prompting

      if (cleanupPrompt) {
        cleanupPrompt()
        cleanupPrompt = null
      }
      prompting = false

      process.stdout.write('\n')

      // 只处理确认提示期间的输入
      if (!wasPrompting) return

      if (answer === 'y' || answer === 'yes') {
        exiting = true
        process.stdout.write('正在退出 dev...\n')
        process.exit(0)
      }

      process.stdout.write('已取消退出，dev 继续运行\n')
    }

    cleanupPrompt = () => {
      process.stdin.off('data', onData)
      if (restorePaused) process.stdin.pause()
    }

    process.stdin.on('data', onData)
  }

  process.on('SIGINT', handleSigint)
}

import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // webui 前端测试的 @ 别名（与 webui/vite.config.ts 同源映射；
      // 后端包测试不使用 @，无碰撞）
      '@': fileURLToPath(new URL('./src/webui/src', import.meta.url)),
      // 同源迁移：@agentchat/protocol → 自包含垫片（与 webui/vite.config.ts
      // 及 webui/tsconfig.json paths 三处同源映射）
      '@agentchat/protocol': fileURLToPath(new URL('./src/webui/src/shims/@agentchat/protocol.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/tests/**/*.test.ts'],
    environment: 'node',
    // 凭据加密（PBKDF2 600k 迭代）与磁盘 IO 在全量并行下较慢；冷启动 transform 也耗时
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});

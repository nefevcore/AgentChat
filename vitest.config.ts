import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/tests/**/*.test.ts'],
    environment: 'node',
    // 凭据加密（PBKDF2 600k 迭代）与磁盘 IO 在全量并行下较慢；冷启动 transform 也耗时
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});

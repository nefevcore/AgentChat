import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@routing': path.resolve(__dirname, 'src/routing'),
      '@llm': path.resolve(__dirname, 'src/llm'),
      '@discovery': path.resolve(__dirname, 'src/discovery'),
      '@plugins': path.resolve(__dirname, 'src/plugins'),
      '@services': path.resolve(__dirname, 'src/services'),
      '@rpc': path.resolve(__dirname, 'src/rpc'),
      '@infra': path.resolve(__dirname, 'src/infra'),
      '@shared': path.resolve(__dirname, 'shared'),
      '@utils': path.resolve(__dirname, 'src/utils'),
    },
  },
});

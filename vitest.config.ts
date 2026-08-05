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
      '@agents': path.resolve(__dirname, 'src/agents'),
      '@app': path.resolve(__dirname, 'src/app'),
      '@plugins': path.resolve(__dirname, 'src/plugins'),
      '@services': path.resolve(__dirname, 'src/services'),
      '@llm': path.resolve(__dirname, 'src/core/llm'),
      '@shared': path.resolve(__dirname, 'shared'),
      '@utils': path.resolve(__dirname, 'src/utils'),
    },
  },
});

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
      '@shared': path.resolve(__dirname, 'shared'),
      '@utils': path.resolve(__dirname, 'src/utils'),
    },
  },
});

import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'lib/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // lib/ modules are server-only in Next; tests run in plain node.
      'server-only': path.resolve(__dirname, 'tests/mocks/server-only.ts'),
    },
  },
});

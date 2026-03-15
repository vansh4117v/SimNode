import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

const pkg = (name: string) => path.resolve(__dirname, `packages/${name}/src/index.ts`);

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'tests/**/*.test.ts'],
    globals: true,
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      '@simnode/clock': pkg('clock'),
      '@simnode/random': pkg('random'),
      '@simnode/http-proxy': pkg('http-proxy'),
      '@simnode/scheduler': pkg('scheduler'),
      '@simnode/tcp': pkg('tcp'),
      '@simnode/pg-mock': pkg('pg-mock'),
      '@simnode/redis-mock': pkg('redis-mock'),
      '@simnode/filesystem': pkg('filesystem'),
      '@simnode/core': pkg('core'),
    },
  },
});

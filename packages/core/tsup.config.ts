import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['src/index.ts', 'src/cli.ts'], format: ['esm', 'cjs'], dts: false, clean: true, shims: true,
  sourcemap: true });

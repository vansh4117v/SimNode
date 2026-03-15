import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['src/index.ts'], format: ['esm', 'cjs'], dts: false, clean: true, shims: true,
  sourcemap: true });

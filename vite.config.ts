import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60_000,
    include: ['packages/**/*.test.ts', 'packages/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});

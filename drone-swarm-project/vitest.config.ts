import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['bundle/**/*.test.tsx'],
    environment: 'jsdom',
    setupFiles: ['bundle/test-setup.ts'],
    globals: false,
  },
});

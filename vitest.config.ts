import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = __dirname;

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: {
      // Tests import the workspace package by name. Resolve to source so we
      // don't need a pre-build step before running tests.
      'drone-core': path.join(rootDir, 'drone-core/src/index.ts'),
    },
  },
  test: {
    include: [
      'drone-core/test/**/*.test.ts',
      'drone-agent/test/**/*.test.ts',
      'drone-agent/test/**/*.test.tsx',
    ],
    // Exclude integration tests that require external services:
    // - Docker: e2e-swarm, coordinator-sync, spawn, inter-agent, agent-beacon
    // - LLM: subagent/dispatch (requires LLM to follow subagent.return instruction)
    exclude: [
      '**/e2e-swarm.test.ts',
      '**/coordinator-sync.test.ts',
      '**/spawn.test.ts',
      '**/inter-agent.test.ts',
      '**/agent-beacon.test.ts',
      '**/subagent/dispatch.test.ts',
    ],
    environment: 'node',
    setupFiles: ['drone-agent/test/setup-color.ts'],
    globals: false,
    // Force single fork to avoid hanging on process cleanup
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['drone-core/src/**/*.ts', 'drone-agent/src/**/*.ts'],
      exclude: [
        'drone-agent/src/tui/**',
        'drone-agent/src/index.ts',
        '**/*.d.ts',
      ],
    },
  },
});

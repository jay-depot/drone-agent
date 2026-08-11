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
    // Integration tests requiring external services:
    // - Docker services: e2e-swarm, coordinator-sync, spawn, inter-agent, agent-beacon
    // - LLM with subagent__return support: subagent/dispatch
    include: [
      'drone-agent/test/e2e-swarm.test.ts',
      'drone-agent/test/coordinator-sync.test.ts',
      'drone-agent/test/spawn.test.ts',
      'drone-agent/test/inter-agent.test.ts',
      'drone-agent/test/agent-beacon.test.ts',
      'drone-agent/test/subagent/dispatch.test.ts',
      'drone-agent/test/mcp.test.ts',
      'drone-agent/test/lsp-server-smoke.test.ts',
    ],
    environment: 'node',
    setupFiles: ['drone-agent/test/setup-color.ts'],
    globals: false,
    // Allow longer hook timeout for service discovery
    hookTimeout: 60000,
    testTimeout: 60000,
  },
});

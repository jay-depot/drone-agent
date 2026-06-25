/**
 * Test Runner for Swarm Integration Testing
 *
 * Executes the integration test suites against the swarm environment.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { vitest } from 'vitest';

// Get test file from command line or default to all tests
const testFile = process.argv[2] || resolve(__dirname, '../../test/agent-beacon.test.ts');
const testPattern = process.argv[3] || '.';

const logger = {
  info: (...args: unknown[]) => console.log(`[INFO]`, ...args),
  error: (...args: unknown[]) => console.error(`[ERROR]`, ...args),
};

async function main(): Promise<void> {
  logger.info('Starting integration test runner...');
  logger.info(`Coordinator: ${process.env.COORDINATOR_URL}`);
  logger.info(`Beacon: ${process.env.BEACON_URL}`);
  logger.info(`Agent: ${process.env.AGENT_URL}`);
  logger.info(`Echo LLM: ${process.env.ECHO_LLM_URL}`);

  // Create results directory
  const resultsDir = resolve(__dirname, '../../test-results');
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }

  // Run vitest programmatically
  const vitestConfig = {
    testTimeout: 30000,
    hookTimeout: 30000,
  };

  try {
    // Run vitest with the test file
    const vitestInstance = vitest({
      ...vitestConfig,
      include: [testFile],
      testNamePattern: testPattern,
      reporter: ['verbose'],
      outputFile: {
        json: resolve(resultsDir, 'results.json'),
      },
    });

    await vitestInstance.run();

    logger.info('Tests completed');
    process.exit(0);
  } catch (error) {
    logger.error('Test runner failed:', error);
    process.exit(1);
  }
}

main();
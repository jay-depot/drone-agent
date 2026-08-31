import pino from 'pino';

const logger = pino({ level: 'info' });

const COORDINATOR_URL = process.env.COORDINATOR_URL || 'https://localhost:3456';
const BEACON_URL = process.env.BEACON_URL || 'http://localhost:3457';
const AGENT_URL = process.env.AGENT_URL || 'http://localhost:3459';
const ECHO_LLM_URL = process.env.ECHO_LLM_URL || 'http://localhost:3458';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForService(
  url: string,
  name: string,
  maxAttempts = 30
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) {
        logger.info(`${name} is ready`);
        return true;
      }
    } catch {
      // Service not ready yet
    }
    await sleep(1000);
  }
  return false;
}

async function testCoordinatorHealth(): Promise<TestResult> {
  const start = Date.now();
  try {
    const response = await fetch(`${COORDINATOR_URL}/health`);
    if (response.ok) {
      return {
        name: 'coordinator-health',
        passed: true,
        duration: Date.now() - start,
      };
    }
    return {
      name: 'coordinator-health',
      passed: false,
      error: `Status: ${response.status}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: 'coordinator-health',
      passed: false,
      error: String(error),
      duration: Date.now() - start,
    };
  }
}

async function testBeaconHealth(): Promise<TestResult> {
  const start = Date.now();
  try {
    const response = await fetch(`${BEACON_URL}/health`);
    if (response.ok) {
      return {
        name: 'beacon-health',
        passed: true,
        duration: Date.now() - start,
      };
    }
    return {
      name: 'beacon-health',
      passed: false,
      error: `Status: ${response.status}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: 'beacon-health',
      passed: false,
      error: String(error),
      duration: Date.now() - start,
    };
  }
}

async function testEchoLlmHealth(): Promise<TestResult> {
  const start = Date.now();
  try {
    const response = await fetch(`${ECHO_LLM_URL}/health`);
    if (response.ok) {
      return {
        name: 'echo-llm-health',
        passed: true,
        duration: Date.now() - start,
      };
    }
    return {
      name: 'echo-llm-health',
      passed: false,
      error: `Status: ${response.status}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: 'echo-llm-health',
      passed: false,
      error: String(error),
      duration: Date.now() - start,
    };
  }
}

async function testEchoLlmChat(): Promise<TestResult> {
  const start = Date.now();
  try {
    const response = await fetch(`${ECHO_LLM_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'echo-model',
        messages: [{ role: 'user', content: 'Hello, this is a test' }],
      }),
    });

    if (!response.ok) {
      return {
        name: 'echo-llm-chat',
        passed: false,
        error: `Status: ${response.status}`,
        duration: Date.now() - start,
      };
    }

    const data = await response.json();
    if (data.choices && data.choices[0]?.message?.content) {
      return {
        name: 'echo-llm-chat',
        passed: true,
        duration: Date.now() - start,
      };
    }
    return {
      name: 'echo-llm-chat',
      passed: false,
      error: 'Invalid response format',
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: 'echo-llm-chat',
      passed: false,
      error: String(error),
      duration: Date.now() - start,
    };
  }
}

async function testBeaconRegistration(): Promise<TestResult> {
  const start = Date.now();
  try {
    // Try to register a beacon with the coordinator
    const beaconId = `test-beacon-${Date.now()}`;
    const response = await fetch(`${COORDINATOR_URL}/beacons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: beaconId,
        name: 'test-beacon',
        host: 'test-host',
        port: 3457,
      }),
    });

    if (response.ok || response.status === 201) {
      return {
        name: 'beacon-registration',
        passed: true,
        duration: Date.now() - start,
      };
    }
    return {
      name: 'beacon-registration',
      passed: false,
      error: `Status: ${response.status}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: 'beacon-registration',
      passed: false,
      error: String(error),
      duration: Date.now() - start,
    };
  }
}

async function testBeaconMemoryStore(): Promise<TestResult> {
  const start = Date.now();
  try {
    const testKey = `test-key-${Date.now()}`;
    const testValue = { message: 'test-value', timestamp: Date.now() };
    const namespace = 'default';

    // Store a memory
    const storeResponse = await fetch(`${BEACON_URL}/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: testKey,
        value: testValue,
        namespace: namespace,
        ttlSeconds: 60,
      }),
    });

    if (!storeResponse.ok) {
      return {
        name: 'beacon-memory-store',
        passed: false,
        error: `Store failed: ${storeResponse.status}`,
        duration: Date.now() - start,
      };
    }

    // Retrieve the memory using the correct route: GET /memory/key/:key?namespace=
    const getResponse = await fetch(
      `${BEACON_URL}/memory/key/${testKey}?namespace=${namespace}`
    );
    if (!getResponse.ok) {
      return {
        name: 'beacon-memory-store',
        passed: false,
        error: `Get failed: ${getResponse.status}`,
        duration: Date.now() - start,
      };
    }

    const retrieved = await getResponse.json();
    if (retrieved.value?.message === testValue.message) {
      return {
        name: 'beacon-memory-store',
        passed: true,
        duration: Date.now() - start,
      };
    }
    return {
      name: 'beacon-memory-store',
      passed: false,
      error: 'Value mismatch',
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: 'beacon-memory-store',
      passed: false,
      error: String(error),
      duration: Date.now() - start,
    };
  }
}

async function runTests(): Promise<void> {
  logger.info('Starting smoke tests...');
  logger.info(`Coordinator: ${COORDINATOR_URL}`);
  logger.info(`Beacon: ${BEACON_URL}`);
  logger.info(`Agent: ${AGENT_URL}`);
  logger.info(`Echo LLM: ${ECHO_LLM_URL}`);

  // Wait for services to be ready
  logger.info('Waiting for services to be ready...');

  const coordinatorReady = await waitForService(COORDINATOR_URL, 'Coordinator');
  const beaconReady = await waitForService(BEACON_URL, 'Beacon');
  const echoLlmReady = await waitForService(ECHO_LLM_URL, 'Echo LLM');

  if (!coordinatorReady || !beaconReady || !echoLlmReady) {
    logger.error('One or more services failed to start');
    process.exit(1);
  }

  // Run tests
  const tests = [
    testCoordinatorHealth,
    testBeaconHealth,
    testEchoLlmHealth,
    testEchoLlmChat,
    testBeaconRegistration,
    testBeaconMemoryStore,
  ];

  const results: TestResult[] = [];

  for (const test of tests) {
    const result = await test();
    results.push(result);
    if (result.passed) {
      logger.info(`✓ ${result.name} (${result.duration}ms)`);
    } else {
      logger.error(`✗ ${result.name}: ${result.error} (${result.duration}ms)`);
    }
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  logger.info(`\nResults: ${passed}/${total} tests passed`);

  if (failed > 0) {
    logger.error(`${failed} test(s) failed`);
    process.exit(1);
  }

  logger.info('All smoke tests passed!');
}

runTests().catch(error => {
  logger.error(error);
  process.exit(1);
});

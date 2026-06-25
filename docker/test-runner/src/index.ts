/**
 * Simple Test Runner for Swarm Integration Testing
 *
 * Tests the running swarm services directly.
 */

const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://localhost:3456';
const BEACON_URL = process.env.BEACON_URL || 'http://localhost:3457';
const AGENT_URL = process.env.AGENT_URL || 'http://localhost:3459';
const ECHO_LLM_URL = process.env.ECHO_LLM_URL || 'http://localhost:3458';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

async function log(msg: string): Promise<void> {
  console.log(msg);
}

async function checkHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
    log(`✓ ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
    log(`✗ ${name}: ${error}`);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Tests
async function testEchoLlmHealth(): Promise<void> {
  const healthy = await checkHealth(ECHO_LLM_URL);
  if (!healthy) throw new Error('Echo LLM not healthy');
}

async function testCoordinatorHealth(): Promise<void> {
  const healthy = await checkHealth(COORDINATOR_URL);
  if (!healthy) throw new Error('Coordinator not healthy');
}

async function testBeaconHealth(): Promise<void> {
  const healthy = await checkHealth(BEACON_URL);
  if (!healthy) throw new Error('Beacon not healthy');
}

async function testAgentHealth(): Promise<void> {
  const healthy = await checkHealth(AGENT_URL);
  if (!healthy) throw new Error('Agent not healthy');
}

async function testBeaconAgents(): Promise<void> {
  const response = await fetch(`${BEACON_URL}/agents`);
  if (!response.ok) throw new Error(`Failed to get agents: ${response.status}`);
  const agents = await response.json() as unknown[];
  log(`  Found ${agents.length} agent(s)`);
}

async function testBeaconPersonas(): Promise<void> {
  const response = await fetch(`${BEACON_URL}/personas`);
  if (!response.ok) throw new Error(`Failed to get personas: ${response.status}`);
  const personas = await response.json() as unknown[];
  log(`  Found ${personas.length} persona(s)`);
}

async function testEchoLlmChat(): Promise<void> {
  const response = await fetch(`${ECHO_LLM_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'echo-model',
      messages: [{ role: 'user', content: 'Hello' }],
    }),
  });
  if (!response.ok) throw new Error(`Echo LLM chat failed: ${response.status}`);
  const data = await response.json() as { choices?: { message?: { content?: string } }[] };
  if (!data.choices?.[0]?.message?.content) throw new Error('Invalid response');
}

async function main(): Promise<void> {
  log('Starting integration tests...\n');
  log(`Coordinator: ${COORDINATOR_URL}`);
  log(`Beacon: ${BEACON_URL}`);
  log(`Agent: ${AGENT_URL}`);
  log(`Echo LLM: ${ECHO_LLM_URL}\n`);

  // Wait for services to be ready
  log('Waiting for services...');
  await sleep(3000);

  // Run health checks
  log('\n=== Health Checks ===');
  await test('echo-llm-health', testEchoLlmHealth);
  await test('coordinator-health', testCoordinatorHealth);
  await test('beacon-health', testBeaconHealth);
  await test('agent-health', testAgentHealth);

  // Run API tests
  log('\n=== API Tests ===');
  await test('beacon-agents', testBeaconAgents);
  await test('beacon-personas', testBeaconPersonas);
  await test('echo-llm-chat', testEchoLlmChat);

  // Summary
  log('\n=== Summary ===');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  log(`${passed}/${results.length} tests passed`);

  if (failed > 0) {
    log(`\n${failed} test(s) failed:`);
    for (const r of results.filter(r => !r.passed)) {
      log(`  - ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }

  log('\nAll tests passed!');
  process.exit(0);
}

main().catch(error => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
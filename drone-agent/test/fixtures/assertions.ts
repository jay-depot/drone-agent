/**
 * Custom Assertions for Swarm Integration Testing
 *
 * Provides assertion utilities for verifying swarm state.
 */

import type { Agent, Message, Persona } from './index.js';

/**
 * AssertionError with detailed context
 */
export class AssertionError extends Error {
  constructor(
    message: string,
    public readonly context?: object
  ) {
    super(message);
    this.name = 'AssertionError';
  }
}

/**
 * Assert that a condition is true
 */
export function assert(
  condition: boolean,
  message: string,
  context?: object
): asserts condition {
  if (!condition) {
    throw new AssertionError(message, context);
  }
}

/**
 * Assert that a value is defined (not null or undefined)
 */
export function assertDefined<T>(
  value: T | null | undefined,
  message: string = 'Expected value to be defined'
): asserts value is T {
  if (value === null || value === undefined) {
    throw new AssertionError(message, { value });
  }
}

/**
 * Assert that two values are equal
 */
export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new AssertionError(
      message ??
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      { actual, expected }
    );
  }
}

/**
 * Assert that a value contains a substring
 */
export function assertContains(
  actual: string,
  substring: string,
  message?: string
): void {
  if (!actual.includes(substring)) {
    throw new AssertionError(
      message ?? `Expected "${actual}" to contain "${substring}"`,
      { actual, substring }
    );
  }
}

// ============ Agent Assertions ============

/**
 * Assert that an agent is registered with expected status
 */
export function assertAgentRegistered(
  agents: Agent[],
  agentId: string,
  options: { status?: Agent['status']; persona?: string } = {}
): void {
  const agent = agents.find(a => a.id === agentId);
  assertDefined(agent, `Agent ${agentId} not found`);

  if (options.status) {
    assertEqual(
      agent.status,
      options.status,
      `Expected agent status to be ${options.status}`
    );
  }

  if (options.persona) {
    assertEqual(
      agent.persona,
      options.persona,
      `Expected agent persona to be ${options.persona}`
    );
  }
}

/**
 * Assert that an agent is NOT registered
 */
export function assertAgentNotRegistered(
  agents: Agent[],
  agentId: string
): void {
  const agent = agents.find(a => a.id === agentId);
  if (agent) {
    throw new AssertionError(`Agent ${agentId} should not be registered`, {
      agent,
    });
  }
}

/**
 * Assert that an agent has recent activity
 */
export function assertAgentActive(
  agent: Agent,
  maxAgeMs: number = 60000
): void {
  const lastActivity = new Date(agent.lastActivity).getTime();
  const now = Date.now();
  const age = now - lastActivity;

  if (age > maxAgeMs) {
    throw new AssertionError(
      `Agent ${agent.id} last activity was ${age}ms ago (max: ${maxAgeMs}ms)`,
      { lastActivity: agent.lastActivity, age, maxAgeMs }
    );
  }
}

// ============ Persona Assertions ============

/**
 * Assert that a persona exists with expected properties
 */
export function assertPersonaExists(
  personas: Persona[],
  personaId: string,
  options: { name?: string; systemPrompt?: string } = {}
): void {
  const persona = personas.find(p => p.id === personaId);
  assertDefined(persona, `Persona ${personaId} not found`);

  if (options.name) {
    assertEqual(
      persona.name,
      options.name,
      `Expected persona name to be ${options.name}`
    );
  }

  if (options.systemPrompt) {
    assertContains(
      persona.systemPrompt ?? '',
      options.systemPrompt,
      'Expected persona system prompt to contain substring'
    );
  }
}

/**
 * Assert that a persona does NOT exist
 */
export function assertPersonaNotExists(
  personas: Persona[],
  personaId: string
): void {
  const persona = personas.find(p => p.id === personaId);
  if (persona) {
    throw new AssertionError(`Persona ${personaId} should not exist`, {
      persona,
    });
  }
}

// ============ Message Assertions ============

/**
 * Assert that a message was delivered
 */
export function assertMessageDelivered(
  messages: Message[],
  messageId: string
): void {
  const message = messages.find(m => m.id === messageId);
  assertDefined(message, `Message ${messageId} not found`);

  if (!message.delivered) {
    throw new AssertionError(`Message ${messageId} was not delivered`, {
      message,
    });
  }
}

/**
 * Assert that a message was read
 */
export function assertMessageRead(
  messages: Message[],
  messageId: string
): void {
  const message = messages.find(m => m.id === messageId);
  assertDefined(message, `Message ${messageId} not found`);

  assertDefined(message.readAt, `Message ${messageId} has not been read`);
}

/**
 * Assert that a message exists with expected properties
 */
export function assertMessageExists(
  messages: Message[],
  options: { fromAgentId?: string; toAgentId?: string; channel?: string }
): void {
  const message = messages.find(m => {
    if (options.fromAgentId && m.fromAgentId !== options.fromAgentId) return false;
    if (options.toAgentId && m.toAgentId !== options.toAgentId) return false;
    if (options.channel && m.channel !== options.channel) return false;
    return true;
  });

  assertDefined(message, `Message not found matching criteria`);
}

// ============ Collection Assertions ============

/**
 * Assert that a collection contains expected number of items
 */
export function assertLength<T>(
  collection: T[],
  length: number,
  message?: string
): void {
  if (collection.length !== length) {
    throw new AssertionError(
      message ??
        `Expected collection to have ${length} items, got ${collection.length}`,
      { expected: length, actual: collection.length }
    );
  }
}

/**
 * Assert that a collection is empty
 */
export function assertEmpty<T>(collection: T[], message?: string): void {
  assertLength(collection, 0, message ?? 'Expected collection to be empty');
}

/**
 * Assert that a collection is not empty
 */
export function assertNotEmpty<T>(collection: T[], message?: string): void {
  if (collection.length === 0) {
    throw new AssertionError(message ?? 'Expected collection to not be empty');
  }
}

/**
 * Assert that collection contains an item matching a predicate
 */
export function assertContainsMatching<T>(
  collection: T[],
  predicate: (item: T) => boolean,
  message?: string
): void {
  const found = collection.find(predicate);
  if (!found) {
    throw new AssertionError(
      message ?? 'Collection does not contain matching item',
      { collection }
    );
  }
}

/**
 * Assert that collection does NOT contain any items matching a predicate
 */
export function assertNotContainsMatching<T>(
  collection: T[],
  predicate: (item: T) => boolean,
  message?: string
): void {
  const found = collection.find(predicate);
  if (found) {
    throw new AssertionError(
      message ?? 'Collection should not contain matching item',
      { found }
    );
  }
}

// ============ Wait Helpers ============

/**
 * Wait for a condition to be true with timeout
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const { timeoutMs = 10000, intervalMs = 500 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const result = await condition();
    if (result) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  return false;
}

/**
 * Wait for an assertion to pass with timeout
 */
export async function waitForAssertion(
  assertion: () => void | Promise<void>,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const { timeoutMs = 10000, intervalMs = 500 } = options;
  const startTime = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - startTime < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (err) {
      lastError = err as Error;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  throw lastError ?? new Error('Assertion timed out');
}

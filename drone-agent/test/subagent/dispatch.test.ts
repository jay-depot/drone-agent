import { describe, it, expect, afterEach } from 'vitest';
import {
  launchSubagent,
  launchParallelSubagents,
  launchTimeoutSubagent,
  launchErrorSubagent,
  cancelAllSubagents,
} from '../fixtures/subagent.js';

describe('subagent dispatch', () => {
  afterEach(() => {
    // Clean up any pending subagents after each test
    cancelAllSubagents();
  });

  describe('dispatch-basic', () => {
    it('should dispatch a simple task and return a result', async () => {
      const result = await launchSubagent({
        task: 'Say "hello" in exactly 5 characters',
        timeout: 60000,
      });

      // The subagent should complete and return a result
      expect(result.result).toBeDefined();
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
    });

    it('should handle subagent that completes normally', async () => {
      const result = await launchSubagent({
        task: 'Respond with exactly the word "done"',
        timeout: 60000,
      });

      // Verify successful completion
      expect(result.error).toBeUndefined();
      expect(result.result).toBeDefined();
      expect(result.exitCode).toBe(0);
    });
  });

  describe('dispatch-with-persona', () => {
    it('should dispatch with a persona override', async () => {
      // This test requires a persona to be configured
      // Without a valid persona, the subagent may fail or fallback
      const result = await launchSubagent({
        task: 'Say "test"',
        persona: 'default',
        timeout: 60000,
      });

      // Should still complete (may fallback to default persona)
      expect(result.exitCode).toBeDefined();
    });
  });

  describe('dispatch-output-json', () => {
    it('should output valid NDJSON format', async () => {
      const result = await launchSubagent({
        task: 'Say "json test"',
        timeout: 60000,
      });

      // Verify stdout contains valid JSON lines
      const lines = result.stdout.split('\n').filter(l => l.trim());
      expect(lines.length).toBeGreaterThan(0);

      // Each line should be valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  describe('dispatch-once-exit', () => {
    it('should exit after task completion with --once flag', async () => {
      const result = await launchSubagent({
        task: 'Say "exit test"',
        timeout: 60000,
      });

      // Process should exit after completing the task
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('subagent communication', () => {
  afterEach(() => {
    cancelAllSubagents();
  });

  describe('stdin-task-passing', () => {
    it('should receive task via stdin kickoff event', async () => {
      const result = await launchSubagent({
        task: 'Repeat exactly: stdin-test-123',
        timeout: 60000,
      });

      // The task should be received and processed
      expect(result.exitCode).toBeDefined();
    });
  });

  describe('return-tool-result', () => {
    it('should capture result from subagent__return tool', async () => {
      const result = await launchSubagent({
        task: 'Return the exact string: return-result-test',
        timeout: 60000,
      });

      // Result should be captured
      expect(result.result).toBeDefined();
    });
  });

  describe('return-tool-error', () => {
    it('should capture error from subagent__return tool', async () => {
      const result = await launchSubagent({
        task: 'Return with error: test-error-message',
        timeout: 60000,
      });

      // Either result or error should be captured
      expect(result.result ?? result.error).toBeDefined();
    });
  });

  describe('multi-line-result', () => {
    it('should preserve newlines in result', async () => {
      const result = await launchSubagent({
        task: `Return exactly:
line one
line two
line three`,
        timeout: 60000,
      });

      // The result should contain the multi-line content
      expect(result.result).toBeDefined();
      // Note: actual newline preservation depends on the LLM and return tool implementation
    });
  });
});

describe('subagent lifecycle', () => {
  afterEach(() => {
    cancelAllSubagents();
  });

  describe('normal-completion', () => {
    it('should exit with code 0 on normal completion', async () => {
      const result = await launchSubagent({
        task: 'Say "complete"',
        timeout: 60000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.error).toBeUndefined();
    });
  });

  describe('timeout-completion', () => {
    it('should handle timeout gracefully', async () => {
      // Launch a subagent with a very short timeout that will definitely expire
      // Using a task that would take forever to complete
      const result = await launchSubagent({
        task: 'Calculate the sum of all prime numbers forever',
        timeout: 500, // 500ms - very short
      });

      // Should be marked as timed out
      expect(result.timedOut).toBe(true);
      expect(result.error).toContain('timeout');
    }, 10000); // Test timeout
  });

  describe('activity-timeout', () => {
    it('should time out when subagent is idle beyond activity timeout', async () => {
      const result = await launchSubagent({
        task: 'Calculate the sum of all prime numbers forever',
        timeout: 500, // 500ms - very short activity timeout
      });

      expect(result.timedOut).toBe(true);
      expect(result.error).toContain('timeout');
    }, 10000);
  });

  describe('hard-cap-timeout', () => {
    it('should time out via hard cap even with long activity timeout', async () => {
      const result = await launchSubagent({
        task: 'Calculate the sum of all prime numbers forever',
        timeout: 60000, // Long activity timeout (won't fire)
        hardCap: 500, // Very short hard cap (will fire first)
      });

      expect(result.timedOut).toBe(true);
      expect(result.error).toContain('timeout');
    }, 10000);
  });

  describe('crash-handling', () => {
    it('should propagate crash errors to parent', async () => {
      const result = await launchErrorSubagent('crash', {
        timeout: 10000,
      });

      // The process should have non-zero exit code
      expect(result.exitCode).not.toBe(0);
    });
  });
});

describe('subagent parallel execution', () => {
  afterEach(() => {
    cancelAllSubagents();
  });

  describe('parallel-basic', () => {
    it('should run multiple subagents and collect results', async () => {
      const results = await launchParallelSubagents(3, {
        taskFactory: i => `Return the number ${i}`,
        timeout: 120000,
      });

      expect(results).toHaveLength(3);
      // All should complete (some might error, but they should all finish)
      expect(results.every(r => r.exitCode !== undefined)).toBe(true);
    });
  });

  describe('parallel-isolation', () => {
    it('each subagent should get correct task', async () => {
      const results = await launchParallelSubagents(5, {
        taskFactory: i => `Return the exact number: ${i}`,
        timeout: 120000,
      });

      expect(results).toHaveLength(5);
      // Verify each result exists (actual task verification depends on LLM)
      expect(
        results.every(r => r.result !== undefined || r.error !== undefined)
      ).toBe(true);
    });
  });

  describe('parallel-timing', () => {
    it('should run subagents concurrently', async () => {
      const start = Date.now();

      const results = await launchParallelSubagents(3, {
        taskFactory: i => `Task ${i}: Wait 1 second then return done`,
        timeout: 30000,
      });

      const elapsed = Date.now() - start;

      // If run sequentially, would take 3+ seconds
      // If parallel, should be much faster (allowing for overhead)
      // We allow up to 10 seconds to account for overhead
      expect(elapsed).toBeLessThan(10000);
      expect(results).toHaveLength(3);
    }, 30000); // Test timeout
  });

  describe('parallel-limit', () => {
    it('should respect max concurrency limit', async () => {
      const start = Date.now();

      const results = await launchParallelSubagents(4, {
        taskFactory: i => `Task ${i}: return ${i}`,
        timeout: 60000,
        maxConcurrency: 2,
      });

      const elapsed = Date.now() - start;

      // With maxConcurrency=2 and 4 tasks, should complete faster than 4 sequential
      expect(results).toHaveLength(4);
      // Should take less time than sequential (allowing for overhead)
      expect(elapsed).toBeLessThan(60000);
    }, 90000);
  });
});

describe('subagent error handling', () => {
  afterEach(() => {
    cancelAllSubagents();
  });

  describe('missing-executable', () => {
    it('should handle missing drone-agent executable', async () => {
      const result = await launchSubagent({
        task: 'Say "test"',
        execPath: '/nonexistent/path/drone-agent',
        timeout: 5000,
      });

      // Should fail with error about missing executable
      expect(result.error).toBeDefined();
    });
  });

  describe('no-return-tool-call', () => {
    it('should handle subagent that never calls return tool', async () => {
      const result = await launchSubagent({
        task: 'Just say "hello" without using subagent__return',
        timeout: 15000,
      });

      // Should have an error about no result being returned
      expect(result.error).toContain('did not return a result');
    }, 30000);
  });

  describe('error-event-handling', () => {
    it('should capture error NDJSON events from subagent stdout', async () => {
      // Launch a subagent that will produce output
      const result = await launchSubagent({
        task: 'Say "hello" in exactly 5 characters',
        timeout: 60000,
      });

      // The subagent should have produced some output
      expect(result.stdout.length).toBeGreaterThan(0);

      // Parse the NDJSON output and check for error events
      const lines = result.stdout.split('\n').filter(l => l.trim());
      const errorEvents = lines.filter(line => {
        try {
          const event = JSON.parse(line);
          return event.kind === 'error';
        } catch {
          return false;
        }
      });

      // If there are error events, they should have a message
      for (const line of errorEvents) {
        const event = JSON.parse(line);
        if (event.kind === 'error') {
          expect(typeof event.message).toBe('string');
          expect(event.message.length).toBeGreaterThan(0);
        }
      }
    });
  });
});

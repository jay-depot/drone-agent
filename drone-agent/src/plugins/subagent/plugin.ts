import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { DronePlugin } from 'drone-core';
import { writeNdjsonEvent, type OutputEvent } from '../../output-handlers.js';

type RuntimeInfo = {
  subagentId?: string;
  persona?: string;
  isSubagent: boolean;
};

/**
 * Default timeout for subagent dispatch (5 minutes).
 */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Generate a unique subagent ID.
 */
function generateSubagentId(): string {
  return `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const subagentPlugin: DronePlugin = {
  metadata: {
    id: 'subagent',
    name: 'Subagent Dispatch',
    version: '0.1.0',
    description: 'Enables dispatching subagents for parallel task execution',
    defaultEnabled: true,
  },

  async register(ctx) {
    // Get runtime options to determine mode
    const runtime = ctx.request<RuntimeInfo>('runtime');

    if (runtime?.isSubagent) {
      // === SUBAGENT MODE ===
      // Register the return tool and the instruction prompt
      ctx.registerTool({
        name: 'subagent.return',
        description: 'Return the result to the parent agent',
        inputSchema: {
          type: 'object',
          properties: {
            result: { type: 'string', description: 'The result to send back' },
            error: { type: 'string', description: 'Optional error info' },
          },
          required: ['result'],
          additionalProperties: false,
        },
        execute: async input => {
          // Output proper NDJSON return event and exit
          const returnEvent: OutputEvent = {
            kind: 'return',
            subagentId: runtime.subagentId,
            result: input.result as string,
            error: input.error as string | undefined,
          };
          writeNdjsonEvent(returnEvent);
          process.exit(0);
        },
      });

      // Prompt fragment instructing the subagent to use the return tool
      ctx.registerPromptFragment({
        key: 'subagent-return-instruction',
        phase: 'header',
        render: async () =>
          `# Subagent Instructions\n\nYou are a subagent. When you have completed your task, you MUST call the subagent.return tool with the result. Do NOT output the result as a message — use the tool to return it.`,
      });

      ctx.logger.info(`subagent mode: ${runtime.subagentId}`);
    } else {
      // === MAIN AGENT MODE ===
      // Track pending subagents for parallel execution
      const pendingSubagents = new Map<
        string,
        {
          resolve: (jsonResult: string) => void;
          reject: (error: Error) => void;
          timeoutId: ReturnType<typeof setTimeout> | null;
        }
      >();

      ctx.registerTool({
        name: 'subagent__dispatch',
        description: 'Launch a subagent to handle a task in parallel',
        inputSchema: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: 'The prompt to send to subagent',
            },
            persona: {
              type: 'string',
              description: 'Optional persona override',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in ms (default: 300000)',
            },
          },
          required: ['task'],
          additionalProperties: false,
        },
        execute: async (input): Promise<string> => {
          const subagentId = generateSubagentId();
          const timeoutMs =
            (input.timeout as number | undefined) ?? DEFAULT_TIMEOUT_MS;

          // Build command args
          const args = ['--subagent-id', subagentId, '--output-json', '--once'];

          if (input.persona) {
            args.push('--persona', input.persona as string);
          }

          // Find the drone-agent executable
          const execPath = resolve(
            process.cwd(),
            'drone-agent',
            'bin',
            'drone-agent'
          );

          return new Promise((resolvePromise, rejectPromise) => {
            let timedOut = false;
            const collectedOutput: string[] = [];
            let exitCode: number | undefined;
            let stderr = '';

            // Spawn the subagent process
            const child = spawn(execPath, args, {
              stdio: ['pipe', 'pipe', 'pipe'],
              env: {
                ...process.env,
                DRONE_SUBAGENT_ID: subagentId,
                DRONE_PERSONA: input.persona as string | undefined,
              },
            });

            // Set up timeout
            const timeoutId = setTimeout(() => {
              timedOut = true;
              child.kill('SIGTERM');
              // Give it a moment to terminate gracefully, then force kill
              setTimeout(() => {
                if (!child.killed) {
                  child.kill('SIGKILL');
                }
              }, 1000);
            }, timeoutMs);

            // Track this pending subagent
            pendingSubagents.set(subagentId, {
              resolve: resolvePromise,
              reject: rejectPromise,
              timeoutId,
            });

            // Write kickoff to stdin
            const stdin = child.stdin;
            if (!stdin) {
              clearTimeout(timeoutId);
              pendingSubagents.delete(subagentId);
              rejectPromise(new Error('Failed to open stdin for subagent'));
              return;
            }

            const kickoffEvent = JSON.stringify({
              type: 'kickoff',
              task: input.task,
            });
            stdin.write(kickoffEvent + '\n');
            stdin.end();

            // Collect stdout
            child.stdout?.on('data', (data: Buffer) => {
              const lines = data
                .toString()
                .split('\n')
                .filter(l => l.trim());
              collectedOutput.push(...lines);
            });

            // Collect stderr
            child.stderr?.on('data', (data: Buffer) => {
              stderr += data.toString();
            });

            // Handle process exit
            child.on('close', code => {
              clearTimeout(timeoutId);
              pendingSubagents.delete(subagentId);

              exitCode = code ?? undefined;

              // Parse NDJSON output for return event
              let result: string | undefined;
              let error: string | undefined;

              for (const line of collectedOutput) {
                try {
                  const event = JSON.parse(line);
                  if (event.kind === 'return') {
                    result = event.result as string;
                    error = event.error as string | undefined;
                    break;
                  }
                } catch {
                  // Skip invalid JSON
                }
              }

              if (timedOut) {
                resolvePromise(
                  JSON.stringify({
                    error: 'Subagent timed out',
                    timedOut: true,
                    exitCode,
                  })
                );
              } else if (exitCode !== 0 && exitCode !== undefined) {
                resolvePromise(
                  JSON.stringify({
                    error:
                      error ||
                      `Subagent exited with code ${exitCode}${stderr ? `: ${stderr}` : ''}`,
                    exitCode,
                  })
                );
              } else if (!result) {
                resolvePromise(
                  JSON.stringify({
                    error: 'Subagent did not return a result',
                    exitCode,
                  })
                );
              } else {
                resolvePromise(JSON.stringify({ result, exitCode }));
              }
            });

            child.on('error', (err: Error) => {
              clearTimeout(timeoutId);
              pendingSubagents.delete(subagentId);
              rejectPromise(err);
            });
          });
        },
      });

      ctx.logger.info('main agent mode: subagent dispatch available');
    }
  },
};

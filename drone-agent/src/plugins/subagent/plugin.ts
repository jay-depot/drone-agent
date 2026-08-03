import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { DronePlugin } from 'drone-core';
import { SubagentDispatchBlock } from '../../tui/components/SubagentDispatchBlock.js';
import { writeNdjsonEvent, type OutputEvent } from '../../output-handlers.js';

type RuntimeInfo = {
  subagentId?: string;
  persona?: string;
  isSubagent: boolean;
};

/**
 * Default activity timeout for subagent dispatch (5 minutes).
 * Resets on any NDJSON progress event from the subagent.
 */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Hard cap for subagent execution (1 hour). Never resets.
 * Prevents runaway subagents even if they keep making progress.
 */
const HARD_CAP_MS = 3_600_000;

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
          activityTimer: ReturnType<typeof setTimeout> | null;
          hardCapTimer: ReturnType<typeof setTimeout> | null;
        }
      >();

      ctx.registerTool({
        name: 'dispatch',
        description:
          'Launch a subagent to handle a task in parallel. ' +
          'The subagent has an activity-based timeout (resets on any progress) ' +
          'with a hard cap of 1 hour to prevent runaway execution.',
        renderComponent: state => SubagentDispatchBlock({ state }),
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
              description:
                'Activity timeout in ms (default: 300000). Resets on any progress. Hard cap of 1 hour always applies.',
            },
          },
          required: ['task'],
          additionalProperties: false,
        },
        execute: async (input, onProgress): Promise<string> => {
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

            // Activity timeout — resets on any NDJSON event from subagent
            let activityTimer!: ReturnType<typeof setTimeout>;
            const startActivityTimer = () => {
              activityTimer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGTERM');
                // Give it a moment to terminate gracefully, then force kill
                setTimeout(() => {
                  if (!child.killed) {
                    child.kill('SIGKILL');
                  }
                }, 1000);
              }, timeoutMs);
            };
            startActivityTimer();

            // Hard cap — never resets, prevents runaway subagents
            const hardCapTimer = setTimeout(() => {
              timedOut = true;
              child.kill('SIGTERM');
              setTimeout(() => {
                if (!child.killed) {
                  child.kill('SIGKILL');
                }
              }, 1000);
            }, HARD_CAP_MS);

            // Track this pending subagent
            pendingSubagents.set(subagentId, {
              resolve: resolvePromise,
              reject: rejectPromise,
              activityTimer,
              hardCapTimer,
            });

            // Write kickoff to stdin
            const stdin = child.stdin;
            if (!stdin) {
              clearTimeout(activityTimer);
              clearTimeout(hardCapTimer);
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

              // Parse each line as NDJSON and emit progress events
              for (const line of lines) {
                try {
                  const event = JSON.parse(line);
                  // Any valid NDJSON event resets the activity timer
                  clearTimeout(activityTimer);
                  startActivityTimer();

                  if (
                    event.kind === 'reasoning' &&
                    typeof event.content === 'string'
                  ) {
                    onProgress?.(`reasoning:${event.content}`);
                  } else if (
                    event.kind === 'toolCall' &&
                    typeof event.name === 'string'
                  ) {
                    const args = JSON.stringify(event.input ?? {});
                    const truncated =
                      args.length > 80 ? args.slice(0, 77) + '...' : args;
                    onProgress?.(`tool:${event.name}(${truncated})`);
                  } else if (
                    event.kind === 'assistantMessage' &&
                    typeof event.content === 'string'
                  ) {
                    const truncated =
                      event.content.length > 120
                        ? event.content.slice(0, 117) + '...'
                        : event.content;
                    onProgress?.(`msg:${truncated}`);
                  } else if (
                    event.kind === 'return' &&
                    typeof event.result === 'string'
                  ) {
                    onProgress?.(`done:${event.result}`);
                  } else if (
                    event.kind === 'error' &&
                    typeof event.message === 'string'
                  ) {
                    onProgress?.(`error:${event.message}`);
                  }
                } catch {
                  // Skip invalid JSON
                }
              }
            });

            // Collect stderr
            child.stderr?.on('data', (data: Buffer) => {
              stderr += data.toString();
            });

            // Handle process exit
            child.on('close', code => {
              clearTimeout(activityTimer);
              clearTimeout(hardCapTimer);
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

              // Fallback: if no return event found, scan for last error event
              if (!result) {
                for (const line of collectedOutput) {
                  try {
                    const event = JSON.parse(line);
                    if (event.kind === 'error') {
                      error = event.message as string;
                    }
                  } catch {
                    // Skip invalid JSON
                  }
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
              clearTimeout(activityTimer);
              clearTimeout(hardCapTimer);
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

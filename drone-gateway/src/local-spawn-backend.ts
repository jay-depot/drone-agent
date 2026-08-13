import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { logger } from './logger.js';
import { resolveDroneExecutable } from 'drone-core';
import type { SpawnBackend } from './spawn-backend.js';
import type { SpawnSession } from './types.js';

/**
 * LocalSpawnBackend spawns `drone-agent` processes on the host.
 *
 * Each conversation gets a persistent agent process that communicates
 * via NDJSON over stdin/stdout. The agent runs with `--output-json`
 * (without `--once`), entering the JSON listen mode that reads `chat`
 * events from stdin and emits NDJSON events (including `turnComplete`)
 * to stdout.
 */
export class LocalSpawnBackend implements SpawnBackend {
    readonly type = 'local' as const;

    private agentPath: string;
    private sessions: Map<string, ManagedAgentSession> = new Map();

    constructor(agentPath?: string) {
        this.agentPath = agentPath || 'drone-agent';
    }

    async spawnSession(
        conversationId: string,
        personaId: string
    ): Promise<SpawnSession> {
        // Return existing session if one exists
        const existing = this.sessions.get(conversationId);
        if (existing) {
            return existing.session;
        }

        // Resolve agent binary path
        const resolvedPath = await resolveDroneExecutable({
            commandName: this.agentPath,
        });
        logger.info(
            `Spawning agent for conversation ${conversationId} using ${resolvedPath}`
        );

        const args: string[] = ['--output-json'];

        if (personaId) {
            args.push('--persona', personaId);
        }

        const childProcess = spawn(resolvedPath, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        const session: SpawnSession = {
            conversationId,
            personaId,
            processId: `pid-${childProcess.pid}`,
            startedAt: Date.now(),
        };

        const managed: ManagedAgentSession = {
            session,
            process: childProcess,
        };

        this.sessions.set(conversationId, managed);

        // Handle process exit
        childProcess.on('exit', (code, signal) => {
            logger.info(
                `Agent for conversation ${conversationId} exited: code=${code}, signal=${signal}`
            );
            this.sessions.delete(conversationId);
        });

        childProcess.on('error', err => {
            logger.error(
                `Agent for conversation ${conversationId} error: ${err.message}`
            );
            this.sessions.delete(conversationId);
        });

        return session;
    }

    async sendMessage(session: SpawnSession, message: string): Promise<string> {
        const managed = this.sessions.get(session.conversationId);
        if (!managed) {
            throw new Error(
                `No active session for conversation ${session.conversationId}`
            );
        }

        const { process: childProcess } = managed;

        if (!childProcess.stdin || !childProcess.stdout) {
            throw new Error('Agent process has no stdin/stdout');
        }

        // Send the chat event as NDJSON
        const chatEvent = JSON.stringify({ type: 'chat', message }) + '\n';
        childProcess.stdin.write(chatEvent);

        // Read NDJSON events from stdout until we get turnComplete
        const rl = createInterface({ input: childProcess.stdout });
        let lastAssistantMessage = '';

        try {
            for await (const line of rl) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                try {
                    const event = JSON.parse(trimmed);

                    switch (event.kind) {
                        case 'assistantMessage':
                            lastAssistantMessage = event.content;
                            break;
                        case 'turnComplete':
                            // Turn is done, return the last assistant message
                            return lastAssistantMessage;
                        case 'error':
                            logger.error(`Agent error: ${event.message}`);
                            break;
                        // Other events (toolCall, toolResult, reasoning) are informational
                    }
                } catch {
                    logger.warn(`Failed to parse NDJSON line: ${trimmed}`);
                }
            }
        } finally {
            rl.close();
        }

        // If we exhaust stdout without a turnComplete, return what we have
        return lastAssistantMessage;
    }

    async terminateSession(session: SpawnSession): Promise<void> {
        const managed = this.sessions.get(session.conversationId);
        if (!managed) {
            logger.warn(
                `No active session to terminate for conversation ${session.conversationId}`
            );
            return;
        }

        logger.info(`Terminating agent for conversation ${session.conversationId}`);
        managed.process.kill('SIGTERM');

        // Give it 5 seconds to exit gracefully, then SIGKILL
        setTimeout(() => {
            if (!managed.process.killed) {
                logger.warn(
                    `Agent for conversation ${session.conversationId} did not exit gracefully, sending SIGKILL`
                );
                managed.process.kill('SIGKILL');
            }
        }, 5000);

        this.sessions.delete(session.conversationId);
    }
}

interface ManagedAgentSession {
    session: SpawnSession;
    process: ChildProcess;
}

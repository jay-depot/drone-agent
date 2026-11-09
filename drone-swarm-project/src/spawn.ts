/**
 * Coordinator calls used by the scheduler: spawn a session and send it its
 * first instruction.
 *
 * The two-step launch works around the spawn path silently ignoring `--task`:
 * the node spawns with an `extensionHint`, then sends the rendered prompt to
 * the session once it appears (`sessionStarted`). `instructSession` retries to
 * cover the race where the coordinator has not yet registered the session.
 */

export interface SpawnDeps {
  fetch: typeof fetch;
  coordinatorUrl: string;
  logger?: (m: string) => void;
}

export interface SpawnInput {
  targetBeaconId: string;
  personaId: string;
  model?: string;
  workingDir?: string;
  extensionHint: string;
}

export interface SpawnResult {
  spawnId: string;
  agentId: string;
}

const INSTRUCT_RETRIES = 5;
const INSTRUCT_BACKOFF_MS = 500;

/** POST `/api/spawn` and return the spawned ids. Throws on a non-201 reply. */
export async function spawnSession(
  deps: SpawnDeps,
  input: SpawnInput
): Promise<SpawnResult> {
  const config: Record<string, unknown> = {
    extensionHint: input.extensionHint,
  };
  if (input.model !== undefined) config.model = input.model;
  if (input.workingDir !== undefined) config.workingDir = input.workingDir;

  const res = await deps.fetch(`${deps.coordinatorUrl}/api/spawn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetBeaconId: input.targetBeaconId,
      personaId: input.personaId,
      config,
    }),
  });
  if (res.status !== 201) {
    throw new Error(`spawn failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    spawnId?: string;
    agentId?: string;
    targetBeaconId?: string;
  };
  const agentId = body.agentId;
  if (!agentId) throw new Error('spawn response missing agentId');
  return { spawnId: body.spawnId ?? agentId, agentId };
}

/**
 * POST the first instruction to a session. Retries with exponential backoff on
 * a non-2xx reply (the session may not be registered with the coordinator yet).
 */
export async function instructSession(
  deps: SpawnDeps,
  input: { sessionId: string; content: string; retries?: number }
): Promise<boolean> {
  const retries = input.retries ?? INSTRUCT_RETRIES;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await deps.fetch(
        `${deps.coordinatorUrl}/api/sessions/${encodeURIComponent(input.sessionId)}/message`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: input.content }),
        }
      );
      if (res.ok) return true;
    } catch (err) {
      deps.logger?.(
        `instruct attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (attempt < retries) {
      await new Promise(resolve =>
        setTimeout(resolve, INSTRUCT_BACKOFF_MS * 2 ** attempt)
      );
    }
  }
  return false;
}

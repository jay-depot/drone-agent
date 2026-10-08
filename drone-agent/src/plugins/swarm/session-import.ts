import type {
  DroneChatMessage,
  DroneLlmCapability,
  DroneLlmProvider,
  DroneSessionImportConfig,
  DroneSlashCommandSessionManager,
} from 'drone-core';

/**
 * System prompt for summarizing an imported session chunk. Unlike
 * compaction's summary prompt (which prioritizes user requests + results),
 * this prioritizes PROCESS and RESULTS — what was done, how, and the steps —
 * because the goal is to resume work, not just recall outcomes.
 */
export const IMPORT_SUMMARY_SYSTEM_PROMPT =
  'You are a conversation summarizer for resuming an old session. Produce a ' +
  'concise summary of the transcript below. Aim for a brief bullet list. Do ' +
  'not include greetings or pleasantries. Stay under the requested token ' +
  'budget. Prioritize including information in the summary according to the ' +
  'following order from most to least important:\n' +
  '1. The process and steps taken — what was done, how, in what order, and ' +
  'the tools/actions used. Preserve concrete details about the work performed.\n' +
  '2. Results and outcomes — what was accomplished, decisions made, and ' +
  'outputs produced.\n' +
  '3. User input, instruction, questions, and decisions. Preserve these ' +
  'verbatim where they fit.\n' +
  '4. Any context needed to understand the work, and any other relevant ' +
  'information.\n\n' +
  'Detailed tool call arguments and raw tool output should be condensed to ' +
  'their essence. Provide a summary of what was done and the results, ' +
  'prioritizing the process so the work can be resumed.\n\n' +
  'If any information is missing or ambiguous, note that in the summary. Do ' +
  'not make anything up. If information is not in the transcript, skip it. ' +
  "If you can't just skip it, note it.";

/** Synthetic tool name used to inject imported context into the session. */
export const SESSION_IMPORT_TOOL = 'session_import';

/**
 * Fetch a session's transcript from the coordinator.
 * Returns the transcript string, or throws on failure.
 */
export async function fetchTranscript(
  baseUrl: string | undefined,
  sessionId: string
): Promise<string> {
  if (!baseUrl) {
    throw new Error('Beacon URL not configured.');
  }
  const res = await fetch(
    `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/transcript`
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch transcript: ${res.status}`);
  }
  const data = (await res.json()) as { transcript?: string };
  if (typeof data.transcript !== 'string' || data.transcript.length === 0) {
    throw new Error('Session has no transcript to import.');
  }
  return data.transcript;
}

/**
 * Split a transcript into up to `maxChunks` contiguous chronological chunks.
 *
 * The transcript is `--- Turn N ---` delimited. The metadata header (everything
 * before the first turn) is prepended to the first chunk so the summarizer has
 * session context. Returns an array of chunk strings.
 */
export function splitTranscriptIntoChunks(
  transcript: string,
  maxChunks: number
): string[] {
  const effectiveMax = Math.max(1, Math.floor(maxChunks));
  const turnMarker = /^--- Turn \d+ ---$/gm;

  // Find the boundaries of each turn section.
  const boundaries: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = turnMarker.exec(transcript)) !== null) {
    boundaries.push(match.index);
  }

  if (boundaries.length === 0) {
    // No turns — treat the whole transcript as one chunk.
    return [transcript];
  }

  // The header is everything before the first turn marker.
  const header = transcript.slice(0, boundaries[0]);

  // Build the list of turn sections (each includes its `--- Turn N ---` line).
  const turnSections: string[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i];
    const end =
      i + 1 < boundaries.length ? boundaries[i + 1] : transcript.length;
    turnSections.push(transcript.slice(start, end));
  }

  const chunkCount = Math.min(effectiveMax, turnSections.length);
  const perChunk = Math.ceil(turnSections.length / chunkCount);

  const chunks: string[] = [];
  for (let i = 0; i < turnSections.length; i += perChunk) {
    const slice = turnSections.slice(i, i + perChunk);
    const body = slice.join('');
    // Prepend the header to the first chunk only.
    chunks.push(i === 0 ? `${header}${body}` : body);
  }
  return chunks;
}

/**
 * Summarize a single transcript chunk with the clean LLM (no tools).
 * Returns the summary text.
 */
export async function summarizeChunk(
  provider: DroneLlmProvider,
  model: string,
  chunk: string,
  tokenBudget: number
): Promise<string> {
  const messages: DroneChatMessage[] = [
    { role: 'system', content: IMPORT_SUMMARY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Summarize the following session transcript in at most ${tokenBudget} tokens:\n\n${chunk}`,
    },
  ];
  const response = await provider.chat({ model, messages, tools: [] });
  return (response.message ?? '').trim();
}

/**
 * Inject a summarized chunk into the session as a synthetic `session_import`
 * tool-call/result pair. Because `appendAssistantMessage` creates a new turn
 * and `appendToolResult` appends to that turn, each chunk becomes its own
 * turn — giving safety-trim per-chunk degradability (oldest chunks dropped
 * first) and letting compaction re-summarize them as the session grows.
 */
export function injectChunk(
  sessionManager: DroneSlashCommandSessionManager,
  summary: string,
  sessionId: string,
  index: number,
  total: number
): void {
  const toolCallId = `session-import-${index}`;
  sessionManager.appendAssistantMessage('', [
    {
      id: toolCallId,
      name: SESSION_IMPORT_TOOL,
      arguments: {
        sessionId,
        chunk: index + 1,
        totalChunks: total,
      },
    },
  ]);
  sessionManager.appendToolResult(SESSION_IMPORT_TOOL, summary, toolCallId);
}

/** Defaults applied when `swarm.sessionImport` config is absent. */
const DEFAULT_MAX_CHUNKS = 5;
const DEFAULT_CHUNK_TOKEN_BUDGET_PERCENT = 12;

function normalizeImportConfig(config: DroneSessionImportConfig): {
  maxChunks: number;
  chunkTokenBudgetPercent: number;
} {
  return {
    maxChunks: config.maxChunks ?? DEFAULT_MAX_CHUNKS,
    chunkTokenBudgetPercent:
      config.chunkTokenBudgetPercent ?? DEFAULT_CHUNK_TOKEN_BUDGET_PERCENT,
  };
}

export type SessionImportDeps = {
  baseUrl: string | undefined;
  llm: DroneLlmCapability | undefined;
  sessionManager: DroneSlashCommandSessionManager | undefined;
  logger: { info: (message: string) => void; warn: (message: string) => void };
  config: DroneSessionImportConfig;
  getContextWindowTokens: () => Promise<number>;
  runAfterToolCallHooks: () => Promise<void>;
  /** Guard against importing a session into itself. */
  currentSessionId?: string;
};

/**
 * Recreate an old swarm session's context into the current session: fetch the
 * transcript, split it into chunks, summarize each with the clean LLM, and
 * inject each chunk as its own synthetic `session_import` tool-call/result
 * turn (per-chunk degradability under safety-trim). `onAfterToolCall` runs
 * between chunks so compaction can free space. Shared by the
 * `/swarm-session import` slash command and the `--swarm.session-import`
 * startup path.
 *
 * Never throws: failures are logged and reported via a terse one-line
 * `summary`.
 */
export async function runSessionImport(
  deps: SessionImportDeps,
  sessionId: string,
  opts: { from?: number } = {}
): Promise<{ ok: boolean; summary: string }> {
  const { maxChunks, chunkTokenBudgetPercent } = normalizeImportConfig(
    deps.config
  );
  const from = Math.max(1, Math.floor(opts.from ?? 1));

  if (sessionId === deps.currentSessionId) {
    const message = 'Cannot import the current session into itself.';
    deps.logger.warn(message);
    return { ok: false, summary: `session-import: ${message}` };
  }
  if (!deps.llm) {
    const message = 'LLM provider broker is not available.';
    deps.logger.warn(message);
    return { ok: false, summary: `session-import: ${message}` };
  }
  if (!deps.sessionManager) {
    const message = 'Session manager is not available in this host.';
    deps.logger.warn(message);
    return { ok: false, summary: `session-import: ${message}` };
  }

  let transcript: string;
  try {
    transcript = await fetchTranscript(deps.baseUrl, sessionId);
  } catch (err) {
    const message = `Failed to fetch transcript: ${err}`;
    deps.logger.warn(message);
    return { ok: false, summary: `session-import: ${message}` };
  }

  const chunks = splitTranscriptIntoChunks(transcript, maxChunks);
  const contextWindowTokens = await deps.getContextWindowTokens();
  const tokenBudget = Math.max(
    1,
    Math.floor(contextWindowTokens * (chunkTokenBudgetPercent / 100))
  );
  const provider = deps.llm.getActiveProvider();
  const model = deps.llm.getModel();

  if (from > chunks.length) {
    const message = `--from ${from} is out of range: session ${sessionId} was split into ${chunks.length} chunk(s).`;
    deps.logger.warn(message);
    return { ok: false, summary: `session-import: ${message}` };
  }

  deps.logger.info(
    `Importing session ${sessionId} in ${chunks.length} chunk(s) (${tokenBudget} tokens each), resuming from chunk ${from}...`
  );

  for (let i = from - 1; i < chunks.length; i++) {
    let summary: string;
    try {
      summary = await summarizeChunk(provider, model, chunks[i], tokenBudget);
    } catch (err) {
      deps.logger.warn(
        `Failed to summarize chunk ${i + 1}: ${err}\n` +
          `Import aborted: imported chunks ${from}..${i} of ${chunks.length}. ` +
          `Chunks ${i + 1}..${chunks.length} were NOT imported.\n` +
          `Resume with: /swarm-session import ${sessionId} --from ${i + 1}`
      );
      return {
        ok: false,
        summary: `session-import: imported chunks ${from}..${i} of ${chunks.length}; resume with --from ${i + 1}`,
      };
    }
    injectChunk(deps.sessionManager, summary, sessionId, i, chunks.length);
    deps.logger.info(`Imported chunk ${i + 1}/${chunks.length}.`);

    if (i < chunks.length - 1) {
      try {
        await deps.runAfterToolCallHooks();
      } catch (err) {
        deps.logger.warn(`onAfterToolCall hook error (non-fatal): ${err}`);
      }
    }
  }

  const imported = chunks.length - from + 1;
  deps.logger.info(
    `Imported chunks ${from}..${chunks.length} from session ${sessionId}.`
  );
  return {
    ok: true,
    summary: `session-import: imported ${imported} chunk(s) from ${sessionId}`,
  };
}

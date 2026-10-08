/**
 * Herdr pane reporter — a thin wrapper over `HERDR_BIN_PATH pane ...` that
 * reports agent state, the session resume command, and releases the pane.
 *
 * Every call is best-effort: failures are swallowed (optionally logged under
 * `--debug herdr`) so a missing or misbehaving Herdr never slows the agent.
 * Reports are coalesced to a single in-flight call, keeping only the latest
 * desired state, and carry a `--seq` that increases across process restarts
 * (a wall-clock value), so a restarted process cannot be silently dropped as
 * "not newer than" a previous run — and out-of-order deliveries cannot regress
 * Herdr's view.
 */

import { execFileAsync } from '../../shared/exec-async.js';

export type HerdrState = 'idle' | 'working';

export type HerdrReporterOptions = {
  /** Absolute path to the Herdr binary (`HERDR_BIN_PATH`). */
  binPath: string;
  /** Pane id (`HERDR_PANE_ID`). */
  paneId: string;
  /** Herdr `--source` id (fixed to `drone-agent`). */
  source: string;
  /** Herdr `--agent` label (the name shown in the sidebar). */
  agentLabel: string;
  /** Swarm session id, reported via `--agent-session-id`. */
  sessionId: string;
  /** Resume command argv, attached to the first state report. */
  resumeArgv?: string[];
  /** Verbose logging hook (enabled by `--debug herdr`). */
  debug?: (message: string) => void;
  /** Reporter timeout per call in milliseconds. */
  timeoutMs?: number;
};

export type HerdrReporter = {
  report: (state: HerdrState, extras?: { message?: string }) => void;
  release: () => Promise<void>;
};

export const DEFAULT_TIMEOUT_MS = 2000;

/** Attach `-- a b c` to the argv when a resume command is present. */
function withResumeArgv(argv: string[], resumeArgv?: string[]): string[] {
  if (!resumeArgv || resumeArgv.length === 0) return argv;
  return [...argv, '--', ...resumeArgv];
}

export function createReporter(options: HerdrReporterOptions): HerdrReporter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Herdr requires `--seq` to increase across process restarts, not just within
  // one process (see https://herdr.dev/docs/add-herdr-support/). A wall-clock
  // value guarantees a fresh process starts above any prior process's watermark;
  // Math.max(..., seq + 1) keeps it strictly increasing for same-millisecond
  // reports.
  let seq = 0;
  const nextSeq = (): number => (seq = Math.max(Date.now(), seq + 1));
  let inFlight = false;
  let desired: { argv: string[] } | null = null;
  let lastSent: string | null = null;
  let heldPane = false;

  const log = (message: string): void => options.debug?.(message);

  const run = async (argv: string[]): Promise<void> => {
    try {
      await execFileAsync(options.binPath, argv, { timeoutMs });
    } catch (err) {
      log(`herdr report failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const pump = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      while (desired && desired.argv.join('\u0000') !== lastSent) {
        const next = desired;
        desired = null;
        lastSent = next.argv.join('\u0000');
        await run(next.argv);
      }
    } finally {
      inFlight = false;
    }
  };

  const queue = (argv: string[]): void => {
    desired = { argv };
    void pump();
  };

  const report: HerdrReporter['report'] = (state, extras) => {
    const argv = [
      'pane',
      'report-agent',
      options.paneId,
      '--source',
      options.source,
      '--agent',
      options.agentLabel,
      '--state',
      state,
      '--seq',
      String(nextSeq()),
      '--agent-session-id',
      options.sessionId,
    ];
    if (extras?.message) {
      argv.push('--message', extras.message);
    }
    // The resume command rides the first state report, which also holds the
    // pane (Herdr rejects a resume command from a source that does not).
    const attachResume = !heldPane && options.resumeArgv !== undefined;
    heldPane = true;
    queue(attachResume ? withResumeArgv(argv, options.resumeArgv) : argv);
  };

  const release: HerdrReporter['release'] = async () => {
    const argv = [
      'pane',
      'release-agent',
      options.paneId,
      '--source',
      options.source,
      '--agent',
      options.agentLabel,
      '--seq',
      String(nextSeq()),
    ];
    await run(argv);
  };

  return { report, release };
}

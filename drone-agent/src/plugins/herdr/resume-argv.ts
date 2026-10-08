/**
 * Herdr resume-command construction and validation.
 *
 * Herdr restores a pane after a server restart by re-running the resume
 * command the agent reported. drone-agent's "resume" is a session *import*
 * (ADR 146): the new process mints a new swarm session id and recreates the
 * old session's context via `--swarm.session-import <id>`.
 *
 * Herdr's rules for the argv (https://herdr.dev/docs/add-herdr-support/):
 *  - the first word must be a plain command name on PATH, not a path;
 *  - no argument may contain an apostrophe or a control character;
 *  - at most 64 arguments and 8 KiB in total.
 */

export type ResumeArgvInput = {
  /** argv[0]; must be a plain name on PATH. */
  resumeCommand: string;
  /** The swarm session id to import. */
  sessionId: string;
  /** Active persona id, if any. */
  personaId: string | null;
  /** CLI --model override, only when explicitly set. */
  modelOverride?: string;
  /** CLI --beacon-host, only when explicitly set. */
  beaconHost?: string;
  /** CLI --beacon-port, only when explicitly set. */
  beaconPort?: number;
};

/**
 * Build the argv for the resume command. Deliberately omits `--session-id`,
 * `--spawn-id`, `--swarm`, `--once`, `--output-json`, and `--working-dir`:
 * carrying `--session-id` would make the resumed process self-import (and be
 * rejected by the self-import guard), `--swarm` would select listen-mode
 * instead of the TUI, and the rest are irrelevant to an interactive resume.
 */
export function buildResumeArgv(input: ResumeArgvInput): string[] {
  const argv = [input.resumeCommand, '--swarm.session-import', input.sessionId];
  if (input.personaId) {
    argv.push('--persona', input.personaId);
  }
  if (input.modelOverride) {
    argv.push('--model', input.modelOverride);
  }
  if (input.beaconHost) {
    argv.push('--beacon-host', input.beaconHost);
  }
  if (input.beaconPort !== undefined) {
    argv.push('--beacon-port', String(input.beaconPort));
  }
  return argv;
}

const MAX_ARGS = 64;
const MAX_BYTES = 8192;
const PATH_SEPARATOR = /[/\\]/;

/** True when `value` contains an ASCII control character (0x00–0x1f or 0x7f). */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate an argv against Herdr's resume-command rules. Returns
 * `{ ok: true }` when the command is acceptable, else `{ ok: false, reason }`
 * with a human-readable explanation.
 */
export function validateResumeArgv(argv: string[]): {
  ok: boolean;
  reason?: string;
} {
  if (argv.length === 0) {
    return { ok: false, reason: 'resume command is empty' };
  }
  if (PATH_SEPARATOR.test(argv[0])) {
    return {
      ok: false,
      reason: 'resume command must be a plain name on PATH, not a path',
    };
  }
  if (argv.length > MAX_ARGS) {
    return {
      ok: false,
      reason: `resume command has ${argv.length} arguments (max ${MAX_ARGS})`,
    };
  }
  for (const arg of argv) {
    if (arg.includes("'")) {
      return {
        ok: false,
        reason: 'resume command argument contains an apostrophe',
      };
    }
    if (hasControlCharacter(arg)) {
      return {
        ok: false,
        reason: 'resume command argument contains a control character',
      };
    }
  }
  const bytes = argv.reduce(
    (sum, arg) => sum + Buffer.byteLength(arg, 'utf8'),
    0
  );
  if (bytes > MAX_BYTES) {
    return {
      ok: false,
      reason: `resume command is ${bytes} bytes (max ${MAX_BYTES})`,
    };
  }
  return { ok: true };
}

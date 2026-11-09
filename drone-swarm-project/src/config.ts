import os from 'node:os';
import path from 'node:path';

/** Resolved configuration for the `drone-swarm-project` node. */
export interface ProjectConfig {
  coordinatorUrl: string;
  dataDir: string;
  id: string;
  injectToolsIntoAllSessions: boolean;
  maxConcurrentSessions: number;
  maxDailySessions: number;
  preApprovalTokenPath?: string;
}

const ENV_PREFIX = 'DRONE_SWARM_PROJECT_';

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value !== 'false' && value !== '0';
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Parse `--pre-approval-token-path` from argv. Accepts both the `=value` and
 * space-separated forms.
 */
export function parsePreApprovalTokenPath(
  argv: string[] = process.argv.slice(2)
): string | undefined {
  const flag = '--pre-approval-token-path';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === flag) return argv[i + 1];
    if (arg?.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

/** Resolve config from env (and argv) with sensible defaults. */
export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2)
): ProjectConfig {
  const preApprovalTokenPath = parsePreApprovalTokenPath(argv);
  return {
    coordinatorUrl:
      env[`${ENV_PREFIX}COORDINATOR_URL`] ?? 'http://127.0.0.1:8080',
    dataDir:
      env[`${ENV_PREFIX}DATA_DIR`] ??
      path.join(os.homedir(), '.drone-agent', 'drone-swarm-project'),
    id: env[`${ENV_PREFIX}ID`] ?? 'drone-swarm-project',
    injectToolsIntoAllSessions: parseBool(
      env[`${ENV_PREFIX}INJECT_TOOLS`],
      true
    ),
    maxConcurrentSessions: parseNumber(
      env[`${ENV_PREFIX}MAX_CONCURRENT`],
      1
    ),
    maxDailySessions: parseNumber(env[`${ENV_PREFIX}MAX_DAILY`], 12),
    ...(preApprovalTokenPath ? { preApprovalTokenPath } : {}),
  };
}

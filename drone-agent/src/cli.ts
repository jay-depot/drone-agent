export type CliOptions = {
  debugSubsystems: string[];
  once: boolean;
  outputPlain: boolean;
  outputJson: boolean;
  modelOverride?: string;
  configDir?: string;
  pluginOverrides: string[];
  // NEW:
  subagentId?: string;
  persona?: string;
  workflow?: {
    pluginId: string;
    workflowName: string;
    args: Record<string, string>;
  };
  /** Override session.retry.maxRetries (e.g. for long-running headless agents). */
  retryMaxRetries?: number;
  /** Override session.retry.maxWaitMs (e.g. for long-running headless agents). */
  retryMaxWaitMs?: number;
};

export type CliInvocation =
  | {
      kind: 'tool';
      toolName: string;
      input: Record<string, unknown>;
      options: CliOptions;
    }
  | {
      kind: 'chat';
      prompt: string;
      options: CliOptions;
    }
  | {
      kind: 'workflow';
      options: CliOptions & {
        workflow: NonNullable<CliOptions['workflow']>;
      };
    }
  | {
      kind: 'default';
      options: CliOptions;
    }
  | {
      kind: 'migrate';
      migrateOptions: MigrateCliOptions;
      options: CliOptions;
    };

/**
 * CLI options for the `migrate` subcommand.
 */
export type MigrateCliOptions = {
  /** List all migratable assets. */
  list?: boolean;
  /** Asset type to migrate. */
  type?: string;
  /** Specific asset id to migrate. */
  id?: string;
  /** Source scope (for batch or demote). */
  from?: string;
  /** Target scope. */
  to?: string;
  /** When true, delete source after successful copy. */
  move?: boolean;
  /** Backup path — write raw asset file before migrating. */
  backupTo?: string;
  /** When true, pull from swarm to local (demote). */
  pull?: boolean;
  /** Source scope for pull operations. */
  scope?: string;
  /** Beacon host override. */
  beaconHost?: string;
  /** Beacon port override. */
  beaconPort?: number;
};

/**
 * Create a default CliOptions object with all flags set to their defaults.
 */
function createDefaultCliOptions(): CliOptions {
  return {
    once: false,
    outputPlain: false,
    outputJson: false,
    pluginOverrides: [],
    debugSubsystems: [],
  };
}

/**
 * Parse command-line arguments into a structured CliInvocation.
 */
export function parseCliArgs(argv: string[]): CliInvocation {
  // Check for `migrate` subcommand first (before processing -- options)
  if (argv.length > 0 && argv[0] === 'migrate') {
    return parseMigrateSubcommand(argv.slice(1));
  }

  const options: CliOptions = createDefaultCliOptions();

  const positionalArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--once') {
      options.once = true;
    } else if (arg === '--output-plain') {
      if (options.outputJson) {
        throw new Error(
          'Cannot use --output-plain and --output-json at the same time.'
        );
      }
      options.outputPlain = true;
    } else if (arg === '--output-json') {
      if (options.outputPlain) {
        throw new Error(
          'Cannot use --output-plain and --output-json at the same time.'
        );
      }
      options.outputJson = true;
    } else if (arg === '--model' && i + 1 < argv.length) {
      options.modelOverride = argv[++i];
    } else if (arg === '--config-dir' && i + 1 < argv.length) {
      options.configDir = argv[++i];
    } else if (arg === '--plugin' && i + 1 < argv.length) {
      // Support comma-separated plugin names: --plugin bootstrap,lsp,git
      // Also support repeated flags: --plugin bootstrap --plugin lsp
      for (const name of argv[++i].split(',')) {
        const trimmed = name.trim();
        if (trimmed.length > 0) {
          options.pluginOverrides.push(trimmed);
        }
      }
    } else if (arg === '--debug' && i + 1 < argv.length) {
      for (const name of argv[++i].split(',')) {
        const trimmed = name.trim();
        if (trimmed.length > 0) {
          options.debugSubsystems.push(trimmed);
        }
      }
      // NEW: subagent mode flags
    } else if (arg === '--subagent-id' && i + 1 < argv.length) {
      options.subagentId = argv[++i];
    } else if (arg === '--persona' && i + 1 < argv.length) {
      options.persona = argv[++i];
    } else if (arg === '--retry-max-retries' && i + 1 < argv.length) {
      const raw = argv[++i];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --retry-max-retries value: ${raw}`);
      }
      options.retryMaxRetries = parsed;
    } else if (arg === '--retry-max-wait-ms' && i + 1 < argv.length) {
      const raw = argv[++i];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --retry-max-wait-ms value: ${raw}`);
      }
      options.retryMaxWaitMs = parsed;
    } else if (arg === '--workflow' && i + 1 < argv.length) {
      const raw = argv[++i];
      const parts = raw.split('__');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(
          `Invalid workflow format: ${raw}. Expected <plugin>__<workflow>`
        );
      }
      const workflowArgs: Record<string, string> = {};
      while (i + 1 < argv.length && argv[i + 1].startsWith('--workflow-arg')) {
        const argKey = argv[++i];
        if (i + 1 >= argv.length) {
          throw new Error(
            `Missing value for ${argKey}. Usage: --workflow-arg key=value`
          );
        }
        const argValue = argv[++i];
        const eqIndex = argValue.indexOf('=');
        if (eqIndex === -1) {
          throw new Error(
            `Invalid workflow arg format: ${argValue}. Expected key=value`
          );
        }
        const key = argValue.slice(0, eqIndex).trim();
        if (!key) {
          throw new Error(
            `Invalid workflow arg format: ${argValue}. Key cannot be empty.`
          );
        }
        workflowArgs[key] = argValue.slice(eqIndex + 1);
      }
      options.workflow = {
        pluginId: parts[0],
        workflowName: parts[1],
        args: workflowArgs,
      };
    } else if (arg === '--tool' && i + 1 < argv.length) {
      const toolName = argv[++i];
      const input: Record<string, unknown> = {};
      while (i + 1 < argv.length && argv[i + 1].startsWith('--tool-arg')) {
        const argKey = argv[++i];
        if (i + 1 >= argv.length) {
          throw new Error(
            `Missing value for ${argKey}. Usage: --tool-arg key=value`
          );
        }
        const argValue = argv[++i];
        const eqIndex = argValue.indexOf('=');
        if (eqIndex === -1) {
          throw new Error(
            `Invalid tool arg format: ${argValue}. Expected key=value`
          );
        }
        input[argValue.slice(0, eqIndex)] = argValue.slice(eqIndex + 1);
      }
      return { kind: 'tool', toolName, input, options };
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionalArgs.push(arg);
    }
  }

  if (options.workflow) {
    return { kind: 'workflow', options } as CliInvocation;
  }

  if (positionalArgs.length > 0) {
    return { kind: 'chat', prompt: positionalArgs.join(' '), options };
  }

  // NEW: env var fallback for subagent mode flags
  options.subagentId ??= process.env.DRONE_SUBAGENT_ID;
  options.persona ??= process.env.DRONE_PERSONA;

  return { kind: 'default', options };
}

/**
 * Parse arguments for the `migrate` subcommand.
 */
function parseMigrateSubcommand(args: string[]): CliInvocation {
  const migrateOptions: MigrateCliOptions = {};
  const options: CliOptions = createDefaultCliOptions();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--list') {
      migrateOptions.list = true;
    } else if (arg === '--type' && i + 1 < args.length) {
      migrateOptions.type = args[++i];
    } else if (arg === '--id' && i + 1 < args.length) {
      migrateOptions.id = args[++i];
    } else if (arg === '--from' && i + 1 < args.length) {
      migrateOptions.from = args[++i];
    } else if (arg === '--to' && i + 1 < args.length) {
      migrateOptions.to = args[++i];
    } else if (arg === '--move') {
      migrateOptions.move = true;
    } else if (arg === '--backup-to' && i + 1 < args.length) {
      migrateOptions.backupTo = args[++i];
    } else if (arg === '--pull') {
      migrateOptions.pull = true;
    } else if (arg === '--scope' && i + 1 < args.length) {
      migrateOptions.scope = args[++i];
    } else if (arg === '--beacon-host' && i + 1 < args.length) {
      migrateOptions.beaconHost = args[++i];
    } else if (arg === '--beacon-port' && i + 1 < args.length) {
      migrateOptions.beaconPort = Number(args[++i]);
    } else if (arg === '--config-dir' && i + 1 < args.length) {
      options.configDir = args[++i];
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown migrate option: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return {
    kind: 'migrate',
    migrateOptions,
    options,
  };
}

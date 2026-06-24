export type CliOptions = {
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
    };

/**
 * Parse command-line arguments into a structured CliInvocation.
 */
export function parseCliArgs(argv: string[]): CliInvocation {
  const options: CliOptions = {
    once: false,
    outputPlain: false,
    outputJson: false,
    pluginOverrides: [],
  };

  const positionalArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--once') {
      options.once = true;
    } else if (arg === '--output-plain') {
      if (options.outputJson) {
        throw new Error("Cannot use --output-plain and --output-json at the same time.");
      }
      options.outputPlain = true;
    } else if (arg === '--output-json') {
      if (options.outputPlain) {
        throw new Error("Cannot use --output-plain and --output-json at the same time.");
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
    // NEW: subagent mode flags
    } else if (arg === '--subagent-id' && i + 1 < argv.length) {
      options.subagentId = argv[++i];
    } else if (arg === '--persona' && i + 1 < argv.length) {
      options.persona = argv[++i];
    } else if (arg === '--workflow' && i + 1 < argv.length) {
      const raw = argv[++i];
      const parts = raw.split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(
          `Invalid workflow format: ${raw}. Expected <plugin>.<workflow>`
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
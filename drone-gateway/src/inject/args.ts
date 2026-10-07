export interface InjectCommonOptions {
  configPath?: string;
  host?: string;
  port?: number;
  token?: string;
  adapterId: string;
  conversationId: string;
  prefix?: string;
  json: boolean;
}

export type InjectInvocation =
  | { kind: 'help' }
  | {
      kind: 'inject-message';
      options: InjectCommonOptions;
      text?: string;
      file?: string;
    }
  | {
      kind: 'run-agent';
      options: InjectCommonOptions;
      task?: string;
      taskFile?: string;
      persona?: string;
      workingDir?: string;
      model?: string;
      agentPath?: string;
      timeoutSeconds: number;
      noResponseSentinel: boolean;
    };

export const DEFAULT_TIMEOUT_SECONDS = 600;

const SUBCOMMANDS = new Set(['inject-message', 'run-agent']);

/**
 * Parse the `drone-gateway-inject` argv (already sliced past the interpreter
 * and script path). Throws on unknown flags, missing required values and
 * malformed inputs; returns `{ kind: 'help' }` for --help/-h.
 */
export function parseInjectArgs(argv: string[]): InjectInvocation {
  let subcommand: string | undefined;
  const positionals: string[] = [];
  const common: Partial<InjectCommonOptions> = { json: false };

  let file: string | undefined;
  let taskFile: string | undefined;
  let persona: string | undefined;
  let workingDir: string | undefined;
  let model: string | undefined;
  let agentPath: string | undefined;
  let timeoutSeconds: number | undefined;
  let noResponseSentinel = false;

  const need = (flag: string, value: string | undefined): string => {
    if (value === undefined) throw new Error(`Option ${flag} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      return { kind: 'help' };
    }
    if (arg === '--config') {
      common.configPath = need(arg, argv[++i]);
    } else if (arg === '--host') {
      common.host = need(arg, argv[++i]);
    } else if (arg === '--port') {
      common.port = parsePort(need(arg, argv[++i]));
    } else if (arg === '--token') {
      common.token = need(arg, argv[++i]);
    } else if (arg === '--adapter') {
      common.adapterId = need(arg, argv[++i]);
    } else if (arg === '--conversation') {
      common.conversationId = need(arg, argv[++i]);
    } else if (arg === '--prefix') {
      common.prefix = need(arg, argv[++i]);
    } else if (arg === '--json') {
      common.json = true;
    } else if (arg === '--file') {
      file = need(arg, argv[++i]);
    } else if (arg === '--task-file') {
      taskFile = need(arg, argv[++i]);
    } else if (arg === '--persona') {
      persona = need(arg, argv[++i]);
    } else if (arg === '--working-dir') {
      workingDir = need(arg, argv[++i]);
    } else if (arg === '--model') {
      model = need(arg, argv[++i]);
    } else if (arg === '--agent-path') {
      agentPath = need(arg, argv[++i]);
    } else if (arg === '--timeout') {
      timeoutSeconds = parseTimeout(need(arg, argv[++i]));
    } else if (arg === '--no-response-sentinel') {
      noResponseSentinel = true;
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new Error(`Unknown option: ${arg}`);
    } else if (subcommand === undefined) {
      if (!SUBCOMMANDS.has(arg)) {
        throw new Error(`Unknown subcommand: ${arg}`);
      }
      subcommand = arg;
    } else {
      positionals.push(arg);
    }
  }

  if (subcommand === undefined) {
    throw new Error(
      'Missing subcommand. Expected one of: inject-message, run-agent'
    );
  }

  if (common.adapterId === undefined || common.adapterId.trim() === '') {
    throw new Error('Option --adapter is required');
  }
  if (
    common.conversationId === undefined ||
    common.conversationId.trim() === ''
  ) {
    throw new Error('Option --conversation is required');
  }

  const options = common as InjectCommonOptions;

  if (subcommand === 'inject-message') {
    if (positionals.length > 1) {
      throw new Error('inject-message accepts at most one positional text');
    }
    const positional = positionals[0];
    if ((positional === undefined) === (file === undefined)) {
      throw new Error(
        'inject-message requires exactly one of a positional text or --file <path|->'
      );
    }
    return { kind: 'inject-message', options, text: positional, file };
  }

  if (positionals.length > 1) {
    throw new Error('run-agent accepts at most one positional task');
  }
  const positional = positionals[0];
  if ((positional === undefined) === (taskFile === undefined)) {
    throw new Error(
      'run-agent requires exactly one of a positional task or --task-file <path|->'
    );
  }
  return {
    kind: 'run-agent',
    options,
    task: positional,
    taskFile,
    persona,
    workingDir,
    model,
    agentPath,
    timeoutSeconds: timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    noResponseSentinel,
  };
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value: ${raw}`);
  }
  return port;
}

function parseTimeout(raw: string): number {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Invalid --timeout value: ${raw}`);
  }
  return seconds;
}

export function usageText(): string {
  return [
    'drone-gateway-inject <subcommand> [options]',
    '',
    'Subcommands:',
    '  inject-message   Inject a literal message into a conversation (no LLM)',
    '  run-agent        Spawn a one-shot agent and inject its final chat message',
    '',
    'Common options:',
    '  --config <path>        Gateway config file (for controlApi discovery)',
    '  --host <host>          Control API host override',
    '  --port <port>          Control API port override',
    '  --token <token>        Control API Bearer token override',
    '  --adapter <id>         Target adapter id (required)',
    '  --conversation <id>    Target conversation id (required)',
    '  --prefix <string>      Prepend to the first line (\\n, \\t, \\\\ escapes)',
    '  --json                 Emit a JSON result on stdout',
    '',
    'inject-message:',
    '  <text> | --file <path|->   Exactly one source (positional or file/stdin)',
    '',
    'run-agent:',
    '  <task> | --task-file <path|->   Exactly one source (positional or file/stdin)',
    '  --persona <id>         Persona to run as',
    '  --working-dir <path>   Child working directory',
    '  --model <id>           Model override',
    '  --agent-path <path>    drone-agent executable path',
    '  --timeout <seconds>    Agent time budget (default 600)',
    '  --no-response-sentinel Suppress injection when the agent replies <<NO_RESPONSE>>',
  ].join('\n');
}

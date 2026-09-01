import { resolveAddress, AddressError } from './address.js';
import { ApiError, SwarmClient } from './client.js';

interface ParsedArgs {
  beacon?: string;
  coordinator?: string;
  positional: string[];
  flags: Record<string, string>;
}

const HELP = `drone-swarm — standalone REST client for the drone swarm

Usage:
  drone-swarm [--beacon <url> | --coordinator <url>] <command> [args]

Address selection (mutually exclusive):
  --beacon <url>        Talk to a beacon (wiki routes live at /wiki/*)
  --coordinator <url>   Talk to the coordinator (routes live under /api/*)
  --web-token <t>       Web token for the coordinator web port (Bearer auth).
                        Preferred over DRONE_COORDINATOR_WEB_TOKEN.
  Environment: DRONE_BEACON_URL / DRONE_COORDINATOR_URL
  Environment: DRONE_COORDINATOR_WEB_TOKEN — used when --web-token is absent
  Default: local coordinator on http://localhost:3456

Session commands (coordinator):
  session list [--status <s>] [--limit <n>]
  session log <id>            Print the full conversation transcript as JSON
  session transcript <id>     Print the readable --- Turn N --- transcript
  session process <id>        Transition a finished session to "processing"
  session processed <id>      Mark a processed session complete [--summary <s>] [--notes <n>]

Wiki commands (beacon or coordinator):
  wiki read <pageId>
  wiki write <pageId> --title <t> --file <path> | --content <text>
        [--scope <beacon|coordinator>] [--tags <a,b,c>] [--sources <x,y>]
  wiki search <query>

Fragment commands (list: beacon or coordinator; set/delete: beacon only):
  fragments list [--target <agentId|broadcast>]
  fragments set <id> --target <agentId|broadcast> --content <text> | --file <path>
        [--phase <header|footer>] [--expires-at <epochMs>]
  fragments delete <id> --target <agentId|broadcast>

JSON is printed to stdout; errors go to stderr with exit code 1.
`;

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--beacon' && i + 1 < argv.length) {
      parsed.beacon = argv[++i];
    } else if (arg === '--coordinator' && i + 1 < argv.length) {
      parsed.coordinator = argv[++i];
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        parsed.flags[key] = argv[++i];
      } else {
        parsed.flags[key] = 'true';
      }
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function runSessionCommand(
  client: SwarmClient,
  action: string,
  args: ParsedArgs
): Promise<number> {
  const id = args.positional[2];
  switch (action) {
    case 'list': {
      const query: Record<string, string> = {};
      if (args.flags.status) {
        query.status = args.flags.status;
      }
      if (args.flags.limit) {
        query.limit = args.flags.limit;
      }
      const { sessions, count } = await client.listSessions(query);
      printJson({ count, sessions });
      return 0;
    }
    case 'log': {
      if (!id) {
        console.error('usage: drone-swarm session log <id>');
        return 1;
      }
      const { log } = await client.getSessionLog(id);
      printJson(log);
      return 0;
    }
    case 'transcript': {
      if (!id) {
        console.error('usage: drone-swarm session transcript <id>');
        return 1;
      }
      const { transcript } = await client.getSessionTranscript(id);
      printJson(transcript);
      return 0;
    }
    case 'process': {
      if (!id) {
        console.error('usage: drone-swarm session process <id>');
        return 1;
      }
      const { result } = await client.processSession(id);
      printJson(result);
      return 0;
    }
    case 'processed': {
      if (!id) {
        console.error('usage: drone-swarm session processed <id>');
        return 1;
      }
      const body: { summary?: string; notes?: string } = {};
      if (args.flags.summary) {
        body.summary = args.flags.summary;
      }
      if (args.flags.notes) {
        body.notes = args.flags.notes;
      }
      const { result } = await client.markSessionProcessed(id, body);
      printJson(result);
      return 0;
    }
    default:
      console.error(`unknown session action "${action}"`);
      return 1;
  }
}

async function runWikiCommand(
  client: SwarmClient,
  action: string,
  args: ParsedArgs
): Promise<number> {
  const id = args.positional[2];
  switch (action) {
    case 'read': {
      if (!id) {
        console.error('usage: drone-swarm wiki read <pageId>');
        return 1;
      }
      const { page } = await client.readWikiPage(id);
      printJson(page);
      return 0;
    }
    case 'write': {
      if (!id) {
        console.error('usage: drone-swarm wiki write <pageId> --title <t> ...');
        return 1;
      }
      let content = args.flags.content;
      if (!content && args.flags.file) {
        const { readFile } = await import('node:fs/promises');
        content = await readFile(args.flags.file, 'utf8');
      }
      if (!args.flags.title || !content) {
        console.error(
          'wiki write requires --title and one of --file or --content'
        );
        return 1;
      }
      const { page } = await client.writeWikiPage(id, {
        title: args.flags.title,
        content,
        ...(args.flags.scope ? { scope: args.flags.scope } : {}),
        ...(args.flags.tags
          ? { tags: args.flags.tags.split(',').map(t => t.trim()) }
          : {}),
        ...(args.flags.sources
          ? { sources: args.flags.sources.split(',').map(s => s.trim()) }
          : {}),
      });
      printJson(page);
      return 0;
    }
    case 'search': {
      if (!id) {
        console.error('usage: drone-swarm wiki search <query>');
        return 1;
      }
      const results = await client.searchWiki(id);
      printJson({ results });
      return 0;
    }
    default:
      console.error(`unknown wiki action "${action}"`);
      return 1;
  }
}

async function runFragmentsCommand(
  client: SwarmClient,
  action: string,
  args: ParsedArgs
): Promise<number> {
  const id = args.positional[2];
  switch (action) {
    case 'list': {
      const query: Record<string, string> = {};
      if (args.flags.target) {
        query.target = args.flags.target;
      }
      const { fragments } = await client.listFragments(query);
      printJson({ fragments });
      return 0;
    }
    case 'set': {
      if (!id || !args.flags.target) {
        console.error(
          'usage: drone-swarm fragments set <id> --target <agentId|broadcast> --content <text> | --file <path>'
        );
        return 1;
      }
      let content = args.flags.content;
      if (!content && args.flags.file) {
        const { readFile } = await import('node:fs/promises');
        content = await readFile(args.flags.file, 'utf8');
      }
      if (!content) {
        console.error('fragments set requires one of --content or --file');
        return 1;
      }
      const { fragment } = await client.setFragment({
        id,
        target: args.flags.target,
        content,
        ...(args.flags.phase ? { phase: args.flags.phase } : {}),
        ...(args.flags['expires-at']
          ? { expiresAt: Number(args.flags['expires-at']) }
          : {}),
      });
      printJson(fragment);
      return 0;
    }
    case 'delete': {
      if (!id || !args.flags.target) {
        console.error(
          'usage: drone-swarm fragments delete <id> --target <agentId|broadcast>'
        );
        return 1;
      }
      await client.deleteFragment(id, args.flags.target);
      printJson({ ok: true });
      return 0;
    }
    default:
      console.error(`unknown fragments action "${action}"`);
      return 1;
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
  fetchImpl?: typeof fetch
): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.help || args.flags.h || args.positional.length === 0) {
    console.log(HELP);
    return args.positional.length === 0 && !args.flags.help ? 1 : 0;
  }

  try {
    const address = resolveAddress({
      beacon: args.beacon,
      coordinator: args.coordinator,
    });
    const webToken =
      args.flags['web-token'] ||
      (address.target === 'coordinator'
        ? process.env.DRONE_COORDINATOR_WEB_TOKEN
        : undefined);
    const client = new SwarmClient(
      address.target,
      address.baseUrl,
      webToken || undefined,
      fetchImpl
    );

    const [group, action] = args.positional;
    switch (group) {
      case 'session':
        return await runSessionCommand(client, action ?? '', args);
      case 'wiki':
        return await runWikiCommand(client, action ?? '', args);
      case 'fragments':
        return await runFragmentsCommand(client, action ?? '', args);
      default:
        console.error(`unknown command group "${group}"`);
        console.log(HELP);
        return 1;
    }
  } catch (err) {
    if (err instanceof AddressError || err instanceof ApiError) {
      console.error(err.message);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    return 1;
  }
}

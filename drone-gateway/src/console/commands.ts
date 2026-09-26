import { ConsoleCommandRegistry } from './registry.js';
import { formatJson, formatList } from './format.js';
import type { ConsoleCommand, ConsoleRunInput } from './types.js';

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec {
  return typeof value === 'object' && value !== null ? (value as Rec) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function flagStr(
  flags: Record<string, string | boolean>,
  name: string
): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function intFlag(
  flags: Record<string, string | boolean>,
  name: string
): number | undefined {
  const value = flagStr(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatTimestamp(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return new Date(value).toISOString();
}

function formatSession(rec: Rec): string {
  return [
    `id: ${scalar(rec.id)}`,
    `status: ${scalar(rec.status)}`,
    `persona: ${rec.personaId ? scalar(rec.personaId) : '(none)'}`,
    `beacon: ${scalar(rec.beaconId)}`,
    `updated: ${formatTimestamp(rec.updatedAt)}`,
  ].join('\n');
}

function personaLine(value: unknown): string {
  const rec = asRec(value);
  const description = scalar(rec.description);
  return `${scalar(rec.id)} — ${scalar(rec.name)}${description ? `: ${description}` : ''}`;
}

function skillLine(value: unknown): string {
  const rec = asRec(value);
  const description = scalar(rec.description);
  return `${scalar(rec.id)} — ${scalar(rec.name)}${description ? `: ${description}` : ''}`;
}

function beaconLine(value: unknown): string {
  const rec = asRec(value);
  const connection = rec.connected ? 'connected' : 'disconnected';
  return `${scalar(rec.id)} — ${connection} @ ${scalar(rec.host)}:${scalar(rec.port)}`;
}

async function terminateAgent(
  input: ConsoleRunInput,
  agentId: string
): Promise<string> {
  const beacons = asArray(await input.api.listBeacons()).map(asRec);
  const matches: { beaconId: string; spawnId: string }[] = [];
  for (const beacon of beacons) {
    const beaconId = scalar(beacon.id);
    const spawns = asArray(await input.api.listSpawns(beaconId)).map(asRec);
    for (const spawn of spawns) {
      const spawnId = scalar(spawn.id);
      if (spawn.agentId === agentId && spawnId) {
        matches.push({ beaconId, spawnId });
      }
    }
  }

  if (matches.length === 0) {
    throw new Error(`No spawn found for agent "${agentId}".`);
  }
  if (matches.length > 1) {
    const candidates = matches
      .map(m => `${agentId} on beacon ${m.beaconId}, spawn ${m.spawnId}`)
      .join('; ');
    throw new Error(`Multiple spawns match agent "${agentId}": ${candidates}.`);
  }

  const match = matches[0];
  const raw = await input.api.terminateSpawn(match.beaconId, match.spawnId);
  if (input.json) return formatJson(raw);
  return `Terminated agent "${agentId}" (beacon ${match.beaconId}, spawn ${match.spawnId}).`;
}

function buildCommands(): ConsoleCommand[] {
  return [
    {
      name: 'swarm.broadcast',
      description: 'Broadcast a message to every beacon',
      usage: 'swarm.broadcast <message> [--channel <name>]',
      valueFlags: ['channel'],
      run: async ({ positionals, flags, json, api }) => {
        const message = positionals.join(' ');
        if (!message)
          return 'Usage: swarm.broadcast <message> [--channel <name>]';
        const channel = flagStr(flags, 'channel') ?? 'swarm-console';
        const raw = await api.broadcast({
          fromAgentId: 'gateway',
          channel,
          body: message,
        });
        if (json) return formatJson(raw);
        const rec = asRec(raw);
        return `Broadcast delivered to ${scalar(rec.deliveredCount)} of ${scalar(rec.totalBeacons)} beacon(s).`;
      },
    },
    {
      name: 'swarm.persona.list',
      description: 'List global personas',
      usage: 'swarm.persona.list',
      run: async ({ json, api }) => {
        const raw = await api.listPersonas();
        if (json) return formatJson(raw);
        const rows = asArray(raw);
        return formatList(rows.map(personaLine), rows.length);
      },
    },
    {
      name: 'swarm.persona.create',
      description: 'Create a global persona',
      usage: 'swarm.persona.create <id> <description> [systemPrompt]',
      run: async ({ positionals, json, api }) => {
        const [id, description, systemPrompt] = positionals;
        if (!id || !description) {
          return 'Usage: swarm.persona.create <id> <description> [systemPrompt]';
        }
        const raw = await api.createPersona({
          id,
          name: id,
          description,
          systemPrompt: systemPrompt ?? description,
        });
        if (json) return formatJson(raw);
        return `Created persona "${id}".`;
      },
    },
    {
      name: 'swarm.persona.update',
      description: 'Update a global persona',
      usage: 'swarm.persona.update <id> [systemPrompt]',
      run: async ({ positionals, json, api }) => {
        const [id, systemPrompt] = positionals;
        if (!id) return 'Usage: swarm.persona.update <id> [systemPrompt]';
        const raw = await api.updatePersona(
          id,
          systemPrompt !== undefined ? { systemPrompt } : {}
        );
        if (json) return formatJson(raw);
        return `Updated persona "${id}".`;
      },
    },
    {
      name: 'swarm.persona.delete',
      description: 'Delete a global persona',
      usage: 'swarm.persona.delete <id>',
      run: async ({ positionals, json, api }) => {
        const [id] = positionals;
        if (!id) return 'Usage: swarm.persona.delete <id>';
        const raw = await api.deletePersona(id);
        if (json) return formatJson(raw);
        return `Deleted persona "${id}".`;
      },
    },
    {
      name: 'swarm.skill.list',
      description: 'List global skills',
      usage: 'swarm.skill.list',
      run: async ({ json, api }) => {
        const raw = await api.listSkills();
        if (json) return formatJson(raw);
        const rows = asArray(raw);
        return formatList(rows.map(skillLine), rows.length);
      },
    },
    {
      name: 'swarm.skill.create',
      description: 'Create a global skill',
      usage: 'swarm.skill.create <id> <description> [body]',
      run: async ({ positionals, json, api }) => {
        const [id, description, body] = positionals;
        if (!id || !description) {
          return 'Usage: swarm.skill.create <id> <description> [body]';
        }
        const raw = await api.createSkill({
          id,
          name: id,
          description,
          trigger: description,
          body: body ?? description,
        });
        if (json) return formatJson(raw);
        return `Created skill "${id}".`;
      },
    },
    {
      name: 'swarm.skill.update',
      description: 'Update a global skill',
      usage: 'swarm.skill.update <id> [body]',
      run: async ({ positionals, json, api }) => {
        const [id, body] = positionals;
        if (!id) return 'Usage: swarm.skill.update <id> [body]';
        const raw = await api.updateSkill(
          id,
          body !== undefined ? { body } : {}
        );
        if (json) return formatJson(raw);
        return `Updated skill "${id}".`;
      },
    },
    {
      name: 'swarm.skill.delete',
      description: 'Delete a global skill',
      usage: 'swarm.skill.delete <id>',
      run: async ({ positionals, json, api }) => {
        const [id] = positionals;
        if (!id) return 'Usage: swarm.skill.delete <id>';
        const raw = await api.deleteSkill(id);
        if (json) return formatJson(raw);
        return `Deleted skill "${id}".`;
      },
    },
    {
      name: 'swarm.session.list',
      description: 'List swarm sessions',
      usage: 'swarm.session.list [--status <s>] [--limit <n>] [--offset <n>]',
      valueFlags: ['status', 'limit', 'offset'],
      run: async ({ flags, json, api }) => {
        const raw = await api.listSessions({
          status: flagStr(flags, 'status'),
          limit: intFlag(flags, 'limit'),
          offset: intFlag(flags, 'offset'),
        });
        if (json) return formatJson(raw);
        const rec = asRec(raw);
        const rows = asArray(rec.sessions);
        const total = typeof rec.count === 'number' ? rec.count : rows.length;
        const lines = rows.map(value => {
          const session = asRec(value);
          const owner = session.personaId
            ? ` (${scalar(session.personaId)})`
            : '';
          return `${scalar(session.id)} — ${scalar(session.status)}${owner}`;
        });
        return formatList(lines, total);
      },
    },
    {
      name: 'swarm.session.get',
      description: 'Get one swarm session',
      usage: 'swarm.session.get <sessionId>',
      run: async ({ positionals, json, api }) => {
        const [sessionId] = positionals;
        if (!sessionId) return 'Usage: swarm.session.get <sessionId>';
        const raw = await api.getSession(sessionId);
        if (json) return formatJson(raw);
        return formatSession(asRec(raw));
      },
    },
    {
      name: 'swarm.beacon.list',
      description: 'List registered beacons',
      usage: 'swarm.beacon.list',
      run: async ({ json, api }) => {
        const raw = await api.listBeacons();
        if (json) return formatJson(raw);
        const rows = asArray(raw);
        return formatList(rows.map(beaconLine), rows.length);
      },
    },
    {
      name: 'swarm.beacon.status',
      description: 'Show beacon connection and spawn summary',
      usage: 'swarm.beacon.status <beaconId>',
      run: async ({ positionals, json, api }) => {
        const [beaconId] = positionals;
        if (!beaconId) return 'Usage: swarm.beacon.status <beaconId>';
        const beacons = asArray(await api.listBeacons()).map(asRec);
        const beacon = beacons.find(b => b.id === beaconId);
        if (!beacon) throw new Error(`Beacon not found: ${beaconId}`);
        const spawns = asArray(await api.listSpawns(beaconId)).map(asRec);
        if (json) return formatJson({ beacon, spawns });
        const counts = new Map<string, number>();
        for (const spawn of spawns) {
          const status = scalar(spawn.status);
          counts.set(status, (counts.get(status) ?? 0) + 1);
        }
        const summary =
          counts.size > 0
            ? [...counts.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([status, count]) => `${status}: ${count}`)
                .join(', ')
            : 'no spawns';
        return `${beaconLine(beacon)}\nspawns: ${summary}`;
      },
    },
    {
      name: 'swarm.beacon.spawn',
      description: 'Spawn an agent on a beacon',
      usage: 'swarm.beacon.spawn <beaconId> [--persona <id>] [--task <text>]',
      valueFlags: ['persona', 'task'],
      run: async ({ positionals, flags, json, api }) => {
        const [beaconId] = positionals;
        if (!beaconId) {
          return 'Usage: swarm.beacon.spawn <beaconId> [--persona <id>] [--task <text>]';
        }
        const raw = await api.spawnAgent({
          targetBeaconId: beaconId,
          personaId: flagStr(flags, 'persona'),
          task: flagStr(flags, 'task'),
        });
        if (json) return formatJson(raw);
        const rec = asRec(raw);
        return [
          `spawnId: ${scalar(rec.spawnId)}`,
          `agentId: ${scalar(rec.agentId)}`,
          `status: ${scalar(rec.status)}`,
        ].join('\n');
      },
    },
    {
      name: 'swarm.agent.status',
      description: 'Show one agent session',
      usage: 'swarm.agent.status <agentId>',
      run: async ({ positionals, json, api }) => {
        const [agentId] = positionals;
        if (!agentId) return 'Usage: swarm.agent.status <agentId>';
        const raw = await api.getSession(agentId);
        if (json) return formatJson(raw);
        return formatSession(asRec(raw));
      },
    },
    {
      name: 'swarm.agent.terminate',
      description: 'Terminate an agent process',
      usage: 'swarm.agent.terminate <agentId>',
      run: async input => {
        const [agentId] = input.positionals;
        if (!agentId) return 'Usage: swarm.agent.terminate <agentId>';
        return terminateAgent(input, agentId);
      },
    },
    {
      name: 'swarm.agent.inject',
      description: 'Inject a message into a live agent session',
      usage: 'swarm.agent.inject <agentId> <text> [--steer]',
      run: async ({ positionals, flags, json, api }) => {
        const [agentId, ...rest] = positionals;
        const text = rest.join(' ');
        if (!agentId || !text) {
          return 'Usage: swarm.agent.inject <agentId> <text> [--steer]';
        }
        const raw = await api.sendSessionMessage(
          agentId,
          text,
          flags.steer === true
        );
        if (json) return formatJson(raw);
        return `Injected message into session "${agentId}".`;
      },
    },
    {
      name: 'swarm.agent.persona',
      description: 'Set or clear an agent session persona',
      usage: 'swarm.agent.persona <agentId> <personaId> [--clear]',
      run: async ({ positionals, flags, json, api }) => {
        const [agentId, personaId] = positionals;
        if (!agentId) {
          return 'Usage: swarm.agent.persona <agentId> <personaId> [--clear]';
        }
        const clear = flags.clear === true;
        if (!clear && !personaId) {
          return 'Usage: swarm.agent.persona <agentId> <personaId> [--clear]';
        }
        const raw = await api.setSessionPersona(
          agentId,
          clear ? null : personaId
        );
        if (json) return formatJson(raw);
        return clear
          ? `Cleared persona for session "${agentId}".`
          : `Set persona "${personaId}" for session "${agentId}".`;
      },
    },
  ];
}

export function createConsoleRegistry(): ConsoleCommandRegistry {
  const registry = new ConsoleCommandRegistry();
  for (const command of buildCommands()) {
    registry.register(command);
  }
  registry.register({
    name: 'swarm.help',
    description: 'List available swarm console commands',
    usage: 'swarm.help',
    run: async () =>
      registry
        .list()
        .map(command => `${command.usage} — ${command.description}`)
        .join('\n'),
  });
  return registry;
}

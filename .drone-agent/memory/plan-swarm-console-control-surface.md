---
key: plan-swarm-console-control-surface
tags:
  - plan
  - drone-gateway
  - swarm-console
  - control-surface
  - roadmap-4.4
created: 2026-09-26T18:39:45.371Z
updated: 2026-09-26T18:39:45.371Z
---

# Plan: Gateway Swarm Console Control Surface (roadmap 4.4)

## Summary

Add a `swarm-console` control surface to `drone-gateway` that lets a human drive the swarm from a chat platform (Matrix) using dot-notation commands of the form `swarm.<namespace>.<command> [args] [--flags]`. Each command maps **directly onto an existing coordinator REST endpoint** — no LLM, no spawned agent, deterministic output.

**Why:** roadmap 4.4 is the next major unimplemented feature. It exists to exercise the gateway end-to-end (spawn/terminate/inspect the swarm from chat), which in turn produces real sessions to feed the later Automated Learning Loop (roadmap 5.2). Full command specification: project memory `swarm-console-command-spec`.

## Scope

**In scope (v1):** a gateway-side `swarm-console` surface; an engine-level surface registry; a conversation-level `allowedSenders` authorization gate; a shell-like command parser; human-readable + `--json` output; docs + tests.

**Out of scope (tracked separately, do NOT implement here):**
- The five commands that need new coordinator endpoints: `swarm.agent.focus`, `swarm.agent.interrupt`, `swarm.beacon.policy`, `swarm.session.search`, `swarm.session.delete` → memory `followup-swarm-console-unbacked-commands`.
- The beacon-restart termination boundary → memory `followup-swarm-spawn-terminate-beacon-restart`.
- `mention-router` (roadmap 4.5), Telegram/Slack adapters (4.6/4.7), a coordinator-side command bus, the Web UI autocomplete tree.
- Console commands from the **local** spawn backend (coordinate commands need the coordinator; local mode returns a clear error).

## Locked design decisions

1. **Execution = direct REST.** The surface parses text and calls coordinator REST itself. No LLM, no agent process.
2. **Grammar = dot-notation, required `swarm.` root.** No `!` or `/` aliases. Hierarchical (autocomplete-ready).
3. **Parser/dispatch lives gateway-side**, factored as a standalone `ConsoleCommandRegistry` (name → handler → formatter) over an abstract `SwarmApi` interface. A future coordinator-side "command bus" promotion is then a move, not a rewrite. v1 is coordinator-backend-only.
4. **v1 command set = endpoint-backed only + `swarm.help`** (exact list below).
5. **Authorization = optional `allowedSenders: string[]` at the conversation level**, enforced by the **engine** at dispatch time (never inside a surface). Matches on `senderId` only. If a sender is not allowed, that conversation simply isn't a match → dispatch falls through to the wildcard (where a `discard` surface makes it observable). Unset = all senders allowed.
6. **Output = human-readable markdown-list default + a global `--json` flag** returning the raw coordinator payload. Formatters are pure functions `(payload) => string`. Ordering is whatever the coordinator returns. List commands pass through `--limit`/`--offset`; the formatter truncates with an explicit `… N more (use --limit/--offset)` tail.
7. **`swarm.agent.terminate` kills the process** via `DELETE /api/spawn/:beaconId/:spawnId` (the only command that does). Endpoint errors are surfaced verbatim. No separate session-end command in v1.
8. **Enablement = per-conversation spec** `{ "type": "swarm-console" }` in `controlSurfaces`, with optional `allowedSenders` as a top-level field on the same conversation file. No console-specific `spec.config` keys in v1.
9. **`swarm.agent.terminate <agentId>` resolves the spawn client-side:** iterate `GET /api/beacons`, then `GET /api/spawn/:beaconId`, and match the spawn whose `agentId` equals the argument. Do **not** use `GET /api/agents/location` (the `agent_locations` table may be unpopulated). On no match / multiple matches, return an error listing candidates. Let `DELETE`'s own `running`/`spawning` guard produce the "cannot kill" error.
10. **Extract an engine-level surface registry** and migrate all three surfaces (`persona-assignment`, `discard`, `swarm-console`) onto it, replacing the hardcoded `switch` in `createControlSurface`. A `SurfaceContext` formalizes what a surface factory may depend on.
11. **Parser is a shell-like tokenizer** (double/single quotes, `--flag value`, bare `--flag`, positionals first); a pure function. `--count` is dropped from `swarm.beacon.spawn` (one agent per command). Unknown command → one-line hint `Unknown command "…". Try swarm.help.`

## Command → endpoint mapping (exact, v1)

| Command | Method + path | Request body / notes |
|---|---|---|
| `swarm.help` | — | Lists commands from the registry. |
| `swarm.broadcast <message>` | `POST /api/messages/broadcast` | `{ fromAgentId: "gateway", channel: <--channel, default "swarm-console">, body: <message> }`. All three fields required by the route. |
| `swarm.persona.list` | `GET /api/personas` | — |
| `swarm.persona.create <id> <description> [systemPrompt]` | `POST /api/personas` | `{ id, name: id, description, systemPrompt: systemPrompt ?? description }` |
| `swarm.persona.update <id> [systemPrompt]` | `PUT /api/personas/:id` | `{ systemPrompt }` (omit if absent) |
| `swarm.persona.delete <id>` | `DELETE /api/personas/:id` | — |
| `swarm.skill.list` | `GET /api/skills` | — |
| `swarm.skill.create <id> <description> [body]` | `POST /api/skills` | `{ id, name: id, description, trigger: description, body: body ?? description }` |
| `swarm.skill.update <id> [body]` | `PUT /api/skills/:id` | `{ body }` (omit if absent) |
| `swarm.skill.delete <id>` | `DELETE /api/skills/:id` | — |
| `swarm.session.list [--status --limit --offset]` | `GET /api/sessions` | Query passthrough. Response `{ sessions, count }`. |
| `swarm.session.get <sessionId>` | `GET /api/sessions/:id` | Response `{ session }`. |
| `swarm.beacon.list` | `GET /api/beacons` | Bare array; each `{ id, name, host, port, connected, lastHeartbeat, spawnRoots?, trustStatus, fingerprintConfirmed }`. |
| `swarm.beacon.status <beaconId>` | `GET /api/beacons` + `GET /api/spawn/:beaconId` | Beacon entry (connection) + spawn list summarized by status. |
| `swarm.beacon.spawn <beaconId> [--persona <id>] [--task <text>]` | `POST /api/spawn` | `{ targetBeaconId, personaId?, task? }`. Response `{ spawnId, agentId, status, beaconUrl, message, targetBeaconId }`. |
| `swarm.agent.status <agentId>` | `GET /api/sessions/:agentId` | `agentId` **is** the session id. Response `{ session }`. |
| `swarm.agent.terminate <agentId>` | `GET /api/beacons` → `GET /api/spawn/:beaconId` → `DELETE /api/spawn/:beaconId/:spawnId` | Client-side `agentId`→spawn resolution (decision 9). |
| `swarm.agent.inject <agentId> <text> [--steer]` | `POST /api/sessions/:agentId/message` | `{ content: <text>, steer: !!flags.steer }`. |
| `swarm.agent.persona <agentId> <personaId>` (or `--clear`) | `PATCH /api/sessions/:agentId/persona` | `{ personaId: <personaId> \| null }`. |

**Key identity fact:** a spawned agent's `agentId` equals its swarm session id (`agent-<uuid>`), **not** the `spawnId`.

## Files

**New**
- `drone-gateway/src/console/swarm-api.ts` — `SwarmApi` interface (the abstract coordinator surface handlers depend on).
- `drone-gateway/src/console/types.ts` — `ParsedCommand`, `ConsoleCommand`, `ConsoleRunInput`.
- `drone-gateway/src/console/tokenize.ts` — shell-like tokenizer.
- `drone-gateway/src/console/parse.ts` — `parseCommand(line, registry)`.
- `drone-gateway/src/console/registry.ts` — `ConsoleCommandRegistry`.
- `drone-gateway/src/console/format.ts` — pure formatters (`formatJson`, `formatList`, `truncationTail`).
- `drone-gateway/src/console/commands.ts` — all v1 command definitions + their formatters.
- `drone-gateway/src/surfaces/types.ts` — `SurfaceContext`, `SurfaceFactory`.
- `drone-gateway/src/surfaces/registry.ts` — `SurfaceRegistry`.
- `drone-gateway/src/surfaces/builtins.ts` — `registerBuiltInSurfaces(registry)`.
- `drone-gateway/src/surfaces/persona-assignment.ts` — moved factory.
- `drone-gateway/src/surfaces/discard.ts` — moved factory.
- `drone-gateway/src/surfaces/swarm-console.ts` — the console surface factory.
- `drone-gateway/docs/adr/003-surface-registry-and-swarm-console.md` — ADR.
- Tests: `test/console-tokenize.test.ts`, `test/console-parse.test.ts`, `test/console-registry.test.ts`, `test/console-format.test.ts`, `test/console-commands.test.ts`, `test/surface-registry.test.ts`, `test/swarm-console-surface.test.ts`.

**Changed**
- `drone-gateway/src/types.ts` — add `ResolvedConversation`; change `ResolvedServiceAdapter.conversations` to `Map<string, ResolvedConversation>`.
- `drone-gateway/src/coordinator-client.ts` — add the missing endpoints; `implements SwarmApi`.
- `drone-gateway/src/engine.ts` — surface registry, `SurfaceContext`, `allowedSenders` gate.
- `drone-gateway/src/config/load.ts` — parse `allowedSenders`; build `ResolvedConversation`.
- `drone-gateway/src/index.ts` — construct the `SwarmClient`/`CoordinatorClient` and pass it to the engine.
- `drone-gateway/CONTEXT.md` — glossary + config layout updates.
- `test/engine.test.ts`, `test/config-load.test.ts`, `test/coordinator-client.test.ts` — updated.

## Step-by-step implementation

> Order matters: Steps 1–4 are prerequisites for 5; Step 4 (the engine refactor) must land before Steps 5–6 so the console and the authz gate build on the registry. Each step is atomic and independently testable.

### Step 1 — Extend `CoordinatorClient` and define `SwarmApi` *(agent: coder)*
Depends on: none.

1. Create `src/console/swarm-api.ts`:
```ts
export interface SwarmApi {
  listBeacons(): Promise<unknown[]>;
  listSpawns(beaconId: string): Promise<unknown[]>;
  terminateSpawn(beaconId: string, spawnId: string): Promise<unknown>;
  spawnAgent(input: { targetBeaconId: string; personaId?: string; task?: string }): Promise<unknown>;
  listSessions(query?: { status?: string; limit?: number; offset?: number }): Promise<{ sessions: unknown[]; count: number }>;
  getSession(id: string): Promise<unknown>;
  sendSessionMessage(id: string, content: string, steer: boolean): Promise<unknown>;
  setSessionPersona(id: string, personaId: string | null): Promise<unknown>;
  broadcast(input: { fromAgentId: string; channel: string; body: string }): Promise<unknown>;
  listPersonas(): Promise<unknown[]>;
  createPersona(input: { id: string; name: string; description: string; systemPrompt: string }): Promise<unknown>;
  updatePersona(id: string, input: Record<string, unknown>): Promise<unknown>;
  deletePersona(id: string): Promise<unknown>;
  listSkills(): Promise<unknown[]>;
  createSkill(input: { id: string; name: string; description: string; trigger: string; body: string }): Promise<unknown>;
  updateSkill(id: string, input: Record<string, unknown>): Promise<unknown>;
  deleteSkill(id: string): Promise<unknown>;
}
```
2. In `src/coordinator-client.ts`, add the missing methods (`listSessions`, `getSession`, `sendSessionMessage`, `setSessionPersona`, `broadcast`, `listPersonas`, `createPersona`, `updatePersona`, `deletePersona`, `listSkills`, `createSkill`, `updateSkill`, `deleteSkill`), reusing the existing private `request()` helper. Normalize the return shapes (`listBeacons`/`listSpawns` → array; `listSessions` → `{ sessions, count }`). Make `CoordinatorClient implements SwarmApi` and adjust existing method signatures to match.
3. Extend `test/coordinator-client.test.ts` for each new method (URL, method, body, error-on-non-2xx).

**Verify:** `pnpm --filter drone-gateway test` passes; LSP clean.

### Step 2 — Console parser core *(agent: coder)*
Depends on: Step 1 (types only).

1. `src/console/types.ts`:
```ts
import type { SwarmApi } from './swarm-api.js';

export interface ParsedCommand {
  name: string;                                 // "swarm.beacon.list"
  positionals: string[];
  flags: Record<string, string | boolean>;
  json: boolean;
}
export interface ConsoleRunInput {
  positionals: string[];
  flags: Record<string, string | boolean>;
  json: boolean;
  api: SwarmApi;
}
export interface ConsoleCommand {
  name: string;
  description: string;
  usage: string;                                // "swarm.beacon.spawn <beaconId> [--persona <id>] [--task <text>]"
  valueFlags?: string[];                        // flags that consume the next token
  run(input: ConsoleRunInput): Promise<string>;
}
```
2. `src/console/tokenize.ts` — `export function tokenize(line: string): string[]`. Handles `"…"` and `'…'` grouping; unterminated quote = take the rest; collapses bare whitespace.
3. `src/console/registry.ts` — `ConsoleCommandRegistry` with `register` (throws on duplicate), `get`, `list` (sorted by name).
4. `src/console/parse.ts`:
```ts
export function parseCommand(line: string, registry: ConsoleCommandRegistry): ParsedCommand | null
```
Returns `null` if the first token does not start with `swarm.`. Otherwise builds `positionals`/`flags` using the command's `valueFlags` (a `--flag` consumes the next token only if the flag is declared as a value flag and the next token is not itself a flag; otherwise it is boolean `true`). Sets `json = flags.json === true`.
5. Tests: quoting, flags with/without values, positionals, `--json`, non-`swarm.` returns null. Keep pure (no I/O).

**Verify:** new parser tests pass; LSP clean.

### Step 3 — Command definitions and formatters *(agent: coder)*
Depends on: Steps 1–2.

1. `src/console/format.ts` — pure helpers:
   - `formatJson(value: unknown): string` → a fenced ```json block.
   - `truncationTail(shown: number, total: number): string` → `"" ` when `shown >= total`, else `… ${total - shown} more (use --limit/--offset)`. Note: `/` in the tail is a deliberate, spec-literal token; keep it inside the string.
   - `formatList(lines: string[], total: number): string` → joins lines + appends `truncationTail`.
2. `src/console/commands.ts` — `createConsoleRegistry(): ConsoleCommandRegistry` registering every command from the mapping table. Each `run()`:
   - calls the corresponding `api` method,
   - if `json` → `formatJson(raw)`,
   - else formats a compact list (one entity per line).
   For `swarm.agent.terminate`, implement the client-side resolution (decision 9): `listBeacons()` → for each beacon `listSpawns(b.id)` → collect matches where `spawn.agentId === agentId`; zero matches → error listing that no spawn matched; >1 → error listing `agentId on beacon <id>, spawn <id>` candidates; one → `terminateSpawn(beaconId, spawnId)`.
   `swarm.help` renders command names + usage from the registry (no API call).
3. Tests `test/console-format.test.ts` and `test/console-commands.test.ts`: for every command, assert the exact `SwarmApi` call (method + args) using a mock `SwarmApi`, and assert the formatted output; cover the terminate 0/1/many paths; cover `--json`.

**Verify:** command/format tests pass; every v1 command has a test.

### Step 4 — Engine surface registry; migrate existing surfaces *(agent: coder)*
Depends on: none (do before Steps 5–6).

1. `src/surfaces/types.ts`:
```ts
import type { ControlSurfaceSpec, DroneControlSurface } from '../types.js';
import type { SpawnBackend } from '../spawn-backend.js';
import type { SwarmApi } from '../console/swarm-api.js';

export interface SurfaceContext {
  spawnBackend: SpawnBackend;
  swarm: SwarmApi | undefined;   // undefined in local spawn-backend mode
}
export type SurfaceFactory = (
  spec: ControlSurfaceSpec,
  conversationId: string,
  ctx: SurfaceContext
) => DroneControlSurface;
```
2. `src/surfaces/registry.ts` — `SurfaceRegistry` (`register` throws on duplicate; `get`; `types()` sorted).
3. Move `createPersonaAssignmentSurface` → `src/surfaces/persona-assignment.ts` and `createDiscardSurface` → `src/surfaces/discard.ts`, changing their signatures to `(spec, conversationId, ctx)`.
4. `src/surfaces/builtins.ts`:
```ts
export function registerBuiltInSurfaces(registry: SurfaceRegistry): void {
  registry.register('persona-assignment', createPersonaAssignmentSurface);
  registry.register('discard', createDiscardSurface);
  registry.register('swarm-console', createSwarmConsoleSurface);
}
```
(Step 5 adds the last line; for Step 4 register only the first two so the build stays green.)
5. `src/engine.ts`: add a `SurfaceRegistry` built in the constructor via `registerBuiltInSurfaces`; replace the `createControlSurface` switch with a registry lookup that throws `No control surface implementation available for type "X". Supported types: <types>`; build a `SurfaceContext` from the spawn backend (and, after Step 5, the swarm client) and pass it to the factory.
6. Update `test/engine.test.ts` (unknown type error lists types; persona-assignment/discard behavior unchanged).

**Verify:** engine tests pass; behavior byte-identical for the existing two surfaces.

### Step 5 — `swarm-console` surface + wiring *(agent: coder)*
Depends on: Steps 3–4.

1. `src/surfaces/swarm-console.ts`:
```ts
export const createSwarmConsoleSurface: SurfaceFactory = (spec, conversationId, ctx) => {
  const registry = createConsoleRegistry();
  return {
    id: `swarm-console-${conversationId}`,
    type: 'swarm-console',
    handleMessage: async (msg) => {
      const line = msg.text.trim();
      if (!line.startsWith('swarm.')) return { response: null, handled: false };   // compose with sibling surfaces
      if (!ctx.swarm) return { response: 'Swarm console requires the coordinator spawn backend (set spawnBackend: "coordinator").', handled: true };
      const parsed = parseCommand(line, registry);
      const cmd = parsed ? registry.get(parsed.name) : undefined;
      if (!parsed || !cmd) return { response: `Unknown command "${parsed?.name ?? line.split(/\s+/)[0]}". Try swarm.help.`, handled: true };
      try {
        return { response: await cmd.run({ positionals: parsed.positionals, flags: parsed.flags, json: parsed.json, api: ctx.swarm }), handled: true };
      } catch (err) {
        return { response: `Error: ${err instanceof Error ? err.message : String(err)}`, handled: true };
      }
    },
  };
};
```
2. Add the `swarm-console` registration line to `builtins.ts`.
3. `src/index.ts`: construct the swarm client in coordinator mode and pass it to the engine:
```ts
const swarm = config.spawnBackend === 'coordinator'
  ? new CoordinatorClient(config.coordinatorUrl, config.coordinatorToken)
  : undefined;
const engine = new GatewayEngine(config, spawnBackend, swarm);
```
Update the `GatewayEngine` constructor signature accordingly.
4. Tests `test/swarm-console-surface.test.ts`: non-`swarm.` → `{handled:false}`; unknown `swarm.x` → help hint; local mode → backend error; command failure → `Error: …`; happy path returns formatted output.

**Verify:** console surface tests pass; `swarm.help` lists all v1 commands.

### Step 6 — Conversation-level `allowedSenders` *(agent: coder)*
Depends on: Step 4.

1. `src/types.ts`: add
```ts
export interface ResolvedConversation {
  allowedSenders?: string[];      // undefined = allow all
  surfaces: ControlSurfaceSpec[];
}
```
and change `ResolvedServiceAdapter.conversations` to `Map<string, ResolvedConversation>`.
2. `src/config/load.ts`: read `convData.allowedSenders`; if present it must be an array of strings (warn + ignore otherwise); store `{ allowedSenders, surfaces: specs }`.
3. `src/engine.ts`: change the internal control-surface map to hold `ResolvedConversation` with instantiated surfaces; in `handleMessage`, only include a conversation's (or the wildcard's) surfaces when `senderAllowed(entry.allowedSenders, msg.senderId)`:
```ts
function senderAllowed(allowed: string[] | undefined, senderId: string | undefined): boolean {
  if (!allowed) return true;
  return senderId !== undefined && allowed.includes(senderId);
}
```
Disallowed → not a candidate → normal fall-through to wildcard.
4. Tests: `test/config-load.test.ts` (parse/validate `allowedSenders`); `test/engine.test.ts` (allowed sender handled; disallowed falls through to wildcard; unset allows all).

**Verify:** engine + config tests pass.

### Step 7 — Documentation *(agent: coder)*
Depends on: Steps 1–6.

1. `drone-gateway/CONTEXT.md`: rewrite the **Swarm Console** glossary entry to the dot-notation grammar (remove the `!spawn`/`!status` wording); add a **Surface Registry** term; add `allowedSenders` to the config-layout block; document the v1 command set and note the deferred commands.
2. Add `drone-gateway/docs/adr/003-surface-registry-and-swarm-console.md` recording decisions 1–11 (context, decision, alternatives, consequences) in the style of ADR 001/002.

**Verify:** docs render; no stale `!spawn` references remain.

### Step 8 — Review *(agent: reviewer)*
Depends on: Steps 1–7.
Review the diff against this plan: no LLM/agent in the console path; authz enforced only in the engine; no duplication between `CoordinatorClient` and `SwarmApi`; every command endpoint matches the mapping table; no dead code; files under 750 lines; comments limited to jsdoc/complex-algorithm/TODO.

### Step 9 — Validation *(agent: tester)*
Depends on: Step 8. Run the full validation criteria below and report results.

## Validation criteria

1. **LSP clean** across the workspace (no errors/warnings in any package) — `lsp__get_diagnostics`, `severity: all`.
2. **Lint passes:** `pnpm -r run lint` exits 0 (ESLint + Prettier). Re-read files after prettier rewrites before further edits.
3. **Build passes:** `pnpm -r run build` exits 0.
4. **Fast tests pass:** `pnpm -r run test` exits 0.
5. **New coverage:** every new source file is covered by unit tests, specifically:
   - `console/tokenize.ts`, `console/parse.ts`, `console/registry.ts`, `console/format.ts`, `console/commands.ts` (all commands, incl. terminate 0/1/many, `--json`, truncation tail).
   - `surfaces/registry.ts` (duplicate throw, unknown-type error lists types).
   - `surfaces/swarm-console.ts` (compose-on-non-command, unknown-command hint, local-mode error, error passthrough).
   - engine `allowedSenders` gate (allowed / disallowed-falls-through / unset).
   - new `CoordinatorClient` methods.
6. **Behavioral acceptance (manual, gateway-testing goal):** with a coordinator running and a Matrix adapter configured:
   - an allowed sender DMing `swarm.help` receives the command list;
   - `swarm.beacon.list` and `swarm.beacon.status <id>` return beacon data from the live swarm;
   - `swarm.session.list` returns sessions; `swarm.session.get <id>` returns one;
   - `swarm.beacon.spawn <beaconId> --persona <id> --task "..."` returns a `spawnId`+`agentId`, and `swarm.agent.status <agentId>` finds it; `swarm.agent.terminate <agentId>` reports success (and a clear error after a beacon restart);
   - a **disallowed** sender's `swarm.*` message is not executed (it falls through to the wildcard/`discard`, observable in logs);
   - in **local** spawn-backend mode, a `swarm.*` command returns the "requires the coordinator spawn backend" message.
7. **No dead code / no unused vars / no fluff comments;** every changed or new file is under 750 lines.
8. **No scope creep:** the five deferred commands are absent from the grammar; no coordinator files were modified.

## Follow-ups (deliberately excluded)
- `followup-swarm-console-unbacked-commands` — coordinator endpoints for `focus`, `interrupt`, `beacon.policy`, `session.search`, `session.delete`.
- `followup-swarm-spawn-terminate-beacon-restart` — persistent spawn identity / startup reconciliation so termination survives a beacon restart.

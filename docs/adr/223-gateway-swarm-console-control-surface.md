---
tags:
  [
    decision,
    drone-gateway,
    swarm-console,
    control-surface,
    surface-registry,
    roadmap-4.4,
    adr,
  ]
related:
  [
    concepts/swarm-console-command-spec.md,
    modules/drone-gateway.md,
    decisions/058-gateway-config-model.md,
    decisions/124-executable-resolution-refactor.md,
  ]
---

# 223 — Gateway `swarm-console` control surface + engine surface registry (roadmap 4.4)

**Status**: Implemented (2026-09-26) · **Branch**: `feat/gateway-swarm-console` · **Commits**: `5fdc520b` (+ memory/breadcrumbs `3444c81e`, `27ac4031`, `26d6ba35`, `0406f508`) · **Plan**: project-memory `plan-swarm-console-control-surface` — _deleted from project memory after ingest_ · **Gateway ADR**: merged into this page (2026-10-06) — the former in-tree `drone-gateway/docs/adr/003-surface-registry-and-swarm-console.md` copy was deleted

**Summary**: Roadmap 4.4. A new gateway-side `swarm-console` control surface lets a human drive the swarm from a chat platform with dot-notation commands (`swarm.<namespace>.<command> [args] [--flags]`), each mapped **directly onto an existing coordinator REST endpoint** — no LLM, no spawned agent, deterministic output. The work also extracts an **engine-level control-surface registry** (replacing the hardcoded `switch`), migrates all three surfaces onto it, and adds a **conversation-level `allowedSenders` authorization gate** enforced by the engine.

## Why

The console exists to **exercise the gateway end-to-end** (spawn / terminate / inspect the swarm from chat), which in turn produces real sessions to feed the later Automated Learning Loop (roadmap 5.2). It is the gateway's third control surface, which is the point at which a hardcoded dispatch `switch` stops being the right shape.

## Locked design decisions (11)

1. **Execution = direct REST.** The surface parses the line and calls coordinator REST itself. No LLM, no agent process — `swarm.beacon.list` must never hallucinate.
2. **Grammar = dot-notation, required `swarm.` root.** No `!` / `/` aliases. The prefix requirement enables composition: `[swarm-console, persona-assignment]` handles console commands and lets everything else fall through to the persona.
3. **Parser/dispatch is gateway-side**, factored as a standalone `ConsoleCommandRegistry` (name → handler) over an abstract `SwarmApi` interface, so a future coordinator-side "command bus" promotion is a move, not a rewrite. v1 is **coordinator-backend-only**; local mode returns a clear error.
4. **v1 command set = endpoint-backed only + `swarm.help`.** Commands with no backing endpoint are omitted entirely (not stubbed).
5. **Authorization = optional `allowedSenders: string[]` at the conversation level**, enforced by the **engine** at dispatch time (never inside a surface), matching on `senderId` only. A disallowed sender is not a match for that conversation, so dispatch **falls through to the wildcard** (where a `discard` surface makes the refusal observable). Unset = every sender allowed. Authorization is orthogonal to surface behavior (per [058-gateway-config-model](058-gateway-config-model.md) surfaces only read `text` + sender "decorations").
6. **Output = compact markdown-list default + a global `--json` flag** returning the raw coordinator payload. Formatters are pure `(payload) => string`. List commands pass `--limit`/`--offset` through and append an explicit `… N more (use --limit/--offset)` tail when truncated.
7. **`swarm.agent.terminate` kills the process** via `DELETE /api/spawn/:beaconId/:spawnId` (the only command that does). Endpoint errors are surfaced verbatim; `DELETE`'s own `running`/`spawning` guard is the single source of truth for "cannot kill". Ending only the session record (what the coordinator UI does today) leaves the process alive and burning tokens.
8. **Enablement = per-conversation spec** `{ "type": "swarm-console" }` in `controlSurfaces`, with optional `allowedSenders` as a top-level field on the same conversation file. No console-specific `spec.config` keys in v1.
9. **`swarm.agent.terminate <agentId>` resolves the spawn client-side:** list `GET /api/beacons`, then `GET /api/spawn/:beaconId` for each, matching `spawn.agentId`. Deliberately does **not** use `GET /api/agents/location` (the `agent_locations` table may be unpopulated — no production caller of the beacon's `registerAgentLocation`). Zero/multiple matches → an error listing candidates.
10. **Extract an engine-level `SurfaceRegistry`** and migrate all three surfaces (`persona-assignment`, `discard`, `swarm-console`) onto it, replacing the hardcoded `switch` in `createControlSurface`. A `SurfaceContext` formalizes what a factory may depend on (`spawnBackend` + optional `swarm`). Rule of three: a switch is fine for two surfaces; a registry is the right shape at three, with `mention-router` (4.5) anticipated.
11. **Parser is a shell-like tokenizer** (single/double quotes, `--flag value`, bare `--flag`, positionals first); a pure function. `--count` is dropped from `swarm.beacon.spawn` (the endpoint spawns exactly one agent per call). Unknown command → one-line hint `Unknown command "…". Try swarm.help.`

## Command → endpoint mapping (shipped v1)

| Command                                                          | Method + path                                                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `swarm.help`                                                     | — (lists the registry)                                                                                                        |
| `swarm.broadcast <message> [--channel <name>]`                   | `POST /api/messages/broadcast` (`{fromAgentId:"gateway", channel, body}`)                                                     |
| `swarm.persona.list`                                             | `GET /api/personas`                                                                                                           |
| `swarm.persona.create <id> <description> [systemPrompt]`         | `POST /api/personas` (`{id, name, description, systemPrompt}`)                                                                |
| `swarm.persona.update <id> [systemPrompt]`                       | `PUT /api/personas/:id`                                                                                                       |
| `swarm.persona.delete <id>`                                      | `DELETE /api/personas/:id`                                                                                                    |
| `swarm.skill.list`                                               | `GET /api/skills`                                                                                                             |
| `swarm.skill.create <id> <description> [body]`                   | `POST /api/skills` (`{id, name, description, trigger, body}`)                                                                 |
| `swarm.skill.update <id> [body]`                                 | `PUT /api/skills/:id`                                                                                                         |
| `swarm.skill.delete <id>`                                        | `DELETE /api/skills/:id`                                                                                                      |
| `swarm.session.list [--status --limit --offset]`                 | `GET /api/sessions` (`{sessions, count}`)                                                                                     |
| `swarm.session.get <sessionId>`                                  | `GET /api/sessions/:id` (`{session}`)                                                                                         |
| `swarm.beacon.list`                                              | `GET /api/beacons` (bare array)                                                                                               |
| `swarm.beacon.status <beaconId>`                                 | `GET /api/beacons` + `GET /api/spawn/:beaconId`                                                                               |
| `swarm.beacon.spawn <beaconId> [--persona <id>] [--task <text>]` | `POST /api/spawn` (`{targetBeaconId, personaId?, task?}`)                                                                     |
| `swarm.agent.status <agentId>`                                   | `GET /api/sessions/:agentId` (`agentId` **is** the session id)                                                                |
| `swarm.agent.terminate <agentId>`                                | `GET /api/beacons` → `GET /api/spawn/:beaconId` → `DELETE /api/spawn/:beaconId/:spawnId` (client-side resolution, decision 9) |
| `swarm.agent.inject <agentId> <text> [--steer]`                  | `POST /api/sessions/:agentId/message` (`{content, steer}`)                                                                    |
| `swarm.agent.persona <agentId> <personaId>` (or `--clear`)       | `PATCH /api/sessions/:agentId/persona` (`{personaId \| null}`)                                                                |

**Key identity fact:** a spawned agent's `agentId` equals its swarm session id (`agent-<uuid>`), **not** its `spawnId` — which is why `terminate` needs the client-side spawn scan.

## Deferred (no backing endpoint, tracked separately)

`swarm.agent.focus`, `swarm.agent.interrupt`, `swarm.beacon.policy`, `swarm.session.search`, `swarm.session.delete`. Each needs a new coordinator endpoint first; project memory `followup-swarm-console-unbacked-commands`. Also deferred: the general `bootstrap__swarm` setup workflow, `mention-router` (roadmap 4.5), Telegram/Slack adapters (4.6/4.7), a coordinator-side command bus, and the Web UI autocomplete tree.

## Implementation

**New `src/console/`** (transport-agnostic command layer): `swarm-api.ts` (the abstract `SwarmApi` coordinator surface handlers depend on), `types.ts` (`ParsedCommand` / `ConsoleRunInput` / `ConsoleCommand`), `tokenize.ts` (quote-aware tokenizer; an unterminated quote consumes the rest of the line), `registry.ts` (`ConsoleCommandRegistry`, duplicate-name guard), `parse.ts` (`parseCommand` → name / positionals / flags / `json`), `format.ts` (`formatJson` fenced block, `formatList`, `truncationTail`), `commands.ts` (the 19 command definitions + handlers, incl. the client-side terminate resolution).

**New `src/surfaces/`**: `types.ts` (`SurfaceContext` / `SurfaceFactory`), `registry.ts` (`SurfaceRegistry`), `builtins.ts` (`registerBuiltInSurfaces`), `persona-assignment.ts` + `discard.ts` (migrated out of the engine), and `swarm-console.ts`.

**Changed**: `engine.ts` (registry-backed dispatch + `senderAllowed` gate + `SurfaceContext`), `types.ts` (**`ResolvedConversation`** = `{ allowedSenders?, surfaces }`; `ResolvedServiceAdapter.conversations` is now `Map<string, ResolvedConversation>`), `config/load.ts` (`parseAllowedSenders` — validates a non-empty string array, warns + ignores otherwise), `index.ts` (constructs `CoordinatorClient` in coordinator mode and passes it to the engine), `coordinator-client.ts` (**`implements SwarmApi`**; adds `listSessions`, `getSession`, `sendSessionMessage`, `setSessionPersona`, `broadcast`, persona/skill CRUD; `spawnAgent` moved to an object arg), `coordinator-spawn-backend.ts` (call-site update), `CONTEXT.md` (glossary: Swarm Console rewritten, Surface Registry + Allowed Senders added; config layout updated), plus `docs/adr/003-surface-registry-and-swarm-console.md`.

**Deviations from the written plan**: `SwarmApi.spawnAgent` gained an optional `spawnId` (the plan's snippet omitted it; `CoordinatorSpawnBackend` needs it for idempotency) — a superset; `--json` was added to the `ParsedCommand`/`ConsoleRunInput` surface (implied by decision 6, absent from the Step-2 snippet); an empty `allowedSenders: []` is rejected at load (warn + ignore) rather than silently denying every sender.

## Review round (what it caught)

A `review`-persona pass over the uncommitted branch found and fixed: a **stale surface-count assertion** (`test/surface-registry.test.ts` still expected 2 registered types after `swarm-console` made it 3 — an interim-step artifact the plan's own Step 4 note had invited); an unused `ResolvedConversation` import; dead `CoordinatorClient.listAgents`/`getSpawn` (no callers) + their tests; fluff comments in `coordinator-spawn-backend.ts`; a terminate-resolution edge (skips spawns with a missing id, avoiding `DELETE …//`); a de-branched unknown-command path in `swarm-console.ts`; and a prettier pass.

## Validation

LSP clean; `pnpm lint` exit 0 (root script — note `pnpm -r run lint` does not exist in this repo); `pnpm -r run build` exit 0; `pnpm test` **3328 passed / 14 skipped / 0 failed** (238 files, 3 skipped). A Node smoke test against the built `dist` confirmed the grammar (19 registered commands; quoted `--task "fix the bug"` and `--limit`/`--offset` group correctly; `swarm.agent.focus` and non-`swarm.` lines are correctly unknown). **Manual live-swarm acceptance was NOT run** — no live coordinator + Matrix adapter was available; the end-to-end chat path is verified only by unit test + the smoke test.

## Pre-existing gateway defects surfaced (NOT fixed here)

The console made two latent defects visible by doing the same operations correctly: `CoordinatorClient.sendMessage` posts `{toAgentId, body}` to `POST /api/messages/relay`, but the coordinator route requires `fromBeaconId`, `fromAgentId`, `toAgentId`, **and** `body` (so the whole gateway→coordinator relay path always 400s); and `CoordinatorSpawnBackend.terminateSession` passes `session.processId` (the `agentId`) where `DELETE /api/spawn/:beaconId/:spawnId` needs the `spawnId`, and defaults `targetBeaconId` to the literal `'default'`. Both are unfixed; the new `swarm.agent.terminate` does both correctly.

## Related

- swarm-console-command-spec — the v1 command specification (this ADR ships its endpoint-backed subset).
- [drone-gateway](../../drone-gateway/) — the gateway module page (surfaces, config model, key files).
- [058-gateway-config-model](058-gateway-config-model.md) — folder-hierarchy config + per-conversation dedicated surface instances (the model extended here).
- [124-executable-resolution-refactor](124-executable-resolution-refactor.md) — shared helpers the gateway already leans on.

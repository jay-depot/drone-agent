---
tags: [decision, herdr, plugin, cli-flags, session-import, integration, adr]
related:
  [
    modules/drone-agent-plugins.md,
    concepts/spawn-backend.md,
    decisions/217-steer-and-btw-commands.md,
  ]
---

# ADR 239: Herdr agent integration plugin

**Status**: Implemented (2026-10-08, branch `feat/herdr-support`)

## Context

[Herdr](https://herdr.dev) is a terminal multiplexer for coding agents. An
agent that reports to Herdr gets its name and `idle`/`working`/`blocked` state
in the sidebar and `herdr agent list`, notifications when it finishes,
`herdr agent wait` automation, and—most valuably—**restore into the same pane
after a Herdr server restart** via a reported resume command.

Herdr documents a vendor-owned integration path
(<https://herdr.dev/docs/add-herdr-support/>): every process in a Herdr pane
inherits `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`, and
`HERDR_SOCKET_PATH`, and reports three things through `"$HERDR_BIN_PATH" pane`:

1. **state** — `pane report-agent <pane> --source S --agent A --state idle|working|blocked [--seq N] [--message M]`
2. **resume command** — `--agent-session-id <id> [-- <argv...>]` (first word a plain PATH name, no apostrophes/control chars, ≤64 args, ≤8 KiB; the source must already hold the pane)
3. **release** — `pane release-agent <pane> --source S --agent A`

drone-agent reported nothing, so it was invisible to Herdr and a Herdr restart
lost the session.

Three drone-agent facts shaped the design:

- **No session id without swarm.** The only session id lives in the swarm
  plugin's `DroneSwarmCapability.getAgentId()`.
- **No session resume exists** (ADR 158). The nearest capability is
  `/swarm-session import`, which recreates an old session's context into the
  current session (an import, not a continuation).
- **`blocked` has no source signal.** drone-agent emits no event when it waits
  for user input (elicitation), so `blocked` cannot be reported yet.

## Decision

Add an opt-in **`herdr` plugin** that reports state and a resume command to
Herdr, plus the two supporting mechanisms it needs.

### D1 — State fidelity: `idle` and `working` only

`working` on the `userMessage` conversation event, `idle` on `roundComplete`
(which fires on every loop-exit path). `blocked` is **deferred**: it would
require a new conversation event emitted from a single choke point wrapping
`engine.setElicitation`. A `TODO(FIXME)` insertion point is left in the plugin.

### D2 — Session-scoped: swarm required

The session id comes from `registration.request<DroneSwarmCapability>('swarm')`.
Without one the plugin reports **nothing** and warns once (on the first
`userMessage`, so the notice reaches the mounted TUI). `swarm` is an
**optional** dependency so `enablePlugin('herdr')` never throws when swarm is
off.

### D3 — Resume by import

The resume command is `drone-agent --swarm.session-import <id> [--persona P]
[--model M] [--beacon-host H --beacon-port P]`, with `argv[0]` from
`herdr.resumeCommand`. It attaches to the **first** state report (which also
holds the pane, satisfying Herdr's `resume_not_accepted` rule) and is validated
against Herdr's argv rules before sending; on violation it is dropped while
state reporting continues. It deliberately omits `--session-id` (would
self-import), `--swarm` (would select listen-mode), and `--once`/`--output-json`
/`--working-dir`. Resume is an **import**: the new process mints a new swarm
session id.

### D4 — Minimal plugin CLI-flag facility

`--swarm.session-import` needs to reach the swarm plugin at startup, but
`parseCliArgs` runs before plugins are registered and throws on unknown flags.
Add a **dotted-namespace facility**: any `--<pluginId>.<flag>[=<value>]` is
parsed liberally into `CliOptions.pluginFlags`, threaded into the engine,
exposed to each plugin via `registration.getCliFlags()` (namespace stripped),
and the namespacing plugin is **auto-enabled**. After `initialize()` the engine
warns once per namespace no enabled plugin claimed. A full declared-spec
refactor (parse-time help/validation) is a separate later branch; the blob
plumbing path is unchanged by it.

### D5 — Startup session-import

`runSessionImport(deps, sessionId, { from? })` is extracted from the
`/swarm-session import` handler into `session-import.ts`; the slash command
becomes a thin adapter. The swarm plugin offers a
`DroneSessionImportCapability`; `index.tsx` runs it after `onSessionStart` and
**before** the host mounts, buffering a terse summary that seeds the TUI via a
new `DroneTuiOptions.initialEntries` (the App only subscribes to conversation
events on mount, so an event emitted earlier would be lost). Non-TUI hosts
surface it through the logger.

### D6 — Shutdown and safety

Release on `onShutdown` only; **no** global SIGINT/SIGTERM handlers (only
`runSwarmListenMode` traps signals; Herdr's shell-prompt safety net covers an
un-released pane within ~1–2 s). No action on `/clear` (the session id is
unchanged). **Subagents are skipped** — they inherit `HERDR_ENV` and would
clobber the parent's pane. Reports carry a `--seq` that is strictly increasing
across process restarts (a wall-clock value), not merely in-process, and are
coalesced to a single in-flight call keeping only the latest state.

### D7 — Config and surfacing

`herdr: { enabled: boolean; resumeCommand: string; agentLabel: string }`
(defaults `true`, `drone-agent`, `drone-agent`). Herdr `--source` is fixed in
code to `drone-agent`. The plugin is silent unless `HERDR_ENV=1`. `--debug
herdr` enables verbose logs.

## Consequences

- drone-agent appears in `herdr agent list`, raises finish notifications, and
  survives a Herdr restart (resuming by import).
- `--seq` is derived from the wall clock so a restarted process cannot be
  silently dropped by Herdr's "not higher than the last accepted" rule; the
  earlier 0-based in-process counter produced exactly that failure after a run
  that exited without releasing.
- The plugin CLI-flag facility is the seed of a planned general mechanism;
  dotted flags are validated late (after registration), so a misspelled dotted
  core flag becomes a silent plugin flag caught only by the engine's warning.
- `blocked` reporting, local-log-based import fallback, and signal-trap release
  remain future work.

---
tags:
  [
    decision,
    checkpoint,
    portable-context,
    plugin-system,
    slash-command,
    cli-flags,
    session,
    adr,
  ]
related:
  [
    decisions/246-portable-context.md,
    decisions/239-herdr-agent-integration.md,
    decisions/146-swarm-session-import.md,
    concepts/session-management.md,
    modules/drone-agent.md,
    modules/drone-agent-plugins.md,
  ]
---

# 247: `checkpoint` plugin — named portable-context snapshots + auto-checkpoints

**Status**: Implemented (2026-10-11) · **Branch**: `feat/portable-context` · **Plan**: project-memory `plan-portable-context`

**Summary**: The `checkpoint` plugin is the first consumer of portable context ([246](246-portable-context.md)). It saves/restores named context snapshots as `./.drone-agent/checkpoints/<name>.json` (one file per checkpoint, holding a full portable-context export), drives them with a `/checkpoint` slash command, restores one at startup with `--checkpoint.restore <name>`, and optionally writes auto-checkpoints at session end and after each round. It is opt-in (`defaultEnabled: false`).

## Context

Portable context ([246](246-portable-context.md)) is inert until something calls it. The first consumer must be a **project-level** store: snapshots are about the work in the current project directory, so `.drone-agent/checkpoints` is the natural home (a sibling of the checked-in `.drone-agent/memory`, `.drone-agent/personas`, etc.). Two entry points are required — an interactive slash command and a startup flag — plus optional unattended snapshots. Startup flags follow the plugin CLI-flag facility (`--<pluginId>.<flag>`, auto-enabling the plugin, read via `registration.getCliFlags()`), per [239](239-herdr-agent-integration.md).

## Decision

**1. Plugin shape.** `drone-agent/src/plugins/checkpoint/index.ts` exports `checkpointPlugin: DronePlugin` with `id: 'checkpoint'`, `defaultEnabled: false`, and dependency `{ id: DRONE_PORTABLE_CONTEXT_CAPABILITY_ID, optional: true }`. It calls `registration.request<DronePortableContextCapability>(DRONE_PORTABLE_CONTEXT_CAPABILITY_ID)` and, when present, registers a contributor-free consumer (it only *calls* the capability). It also **offers** `DroneCheckpointCapability = { runStartupRestore: () => Promise<{ ok: boolean; summary: string }> }` for the startup path. Added to `staticBuiltInPlugins`.

**2. Command surface.** A `/checkpoint` slash command:

- `/checkpoint create <name>` | `restore <name>` | `delete <name>` | `rename <old> <new>` | `list`.
- No subcommand → `create` with a default name: a filesystem-safe ISO timestamp, `new Date().toISOString().replace(/[:.]/g, '-')` (e.g. `2026-10-11T15-34-09-123Z`).
- `busyBehavior: inv => inv.subcommand !== 'restore'` — `restore` is queued (it mutates the whole session mid-turn, so it must not interleave with a live turn); `create`/`delete`/`rename`/`list` run immediately (they touch only the on-disk checkpoint store, never the live session).

**3. Storage.** `drone-agent/src/plugins/checkpoint/store.ts`:

- `checkpointDir()` = `path.join(process.cwd(), '.drone-agent', 'checkpoints')`.
- `sanitizeName(name)` allows `[A-Za-z0-9._-]`, and **throws** on empty, path separators, or `..` (a checkpoint name is a filename; the guard is the path-traversal boundary).
- `writeCheckpoint(name, data)` → `mkdir -p` then a **atomic tmp+rename** write of `<name>.json`. (Atomicity matches the project's shared-state write discipline; a crash mid-write cannot leave a half-written checkpoint.)
- `readCheckpoint(name)`, `deleteCheckpoint(name)`, `renameCheckpoint(old, new)` (read + write + unlink), `listCheckpoints()` (readdir `*.json`, strip the extension).

**4. Startup restore.** `drone-agent/src/startup-checkpoint.ts` mirrors `startup-import.ts`: `runStartupCheckpointRestore(getCapability, logger, pluginFlags)` reads `pluginFlags['checkpoint.restore']`, resolves the `checkpoint` capability, calls `runStartupRestore()`, and returns a `ChatEntry[]` notice (or `undefined`). `index.tsx` calls it after `runStartupSessionImport(...)` and seeds the TUI with its entries. Because the session is empty at startup, the import's recycle step is a **no-op** (the [246](246-portable-context.md) empty gate) — no `onSessionClear`/`onSessionRecycle` fires, and no new swarm session is spawned.

**5. Auto-checkpoints.** Config `checkpoint: { autoOnSessionEnd: false, autoOnRoundComplete: false }` (both default false; the plugin itself is opt-in):

- `onSessionClear(payload)` → if `autoOnSessionEnd`, write `auto-end-<payload.sessionId>-<timestamp>` (the outgoing session is intact at this point, so the snapshot is complete).
- `onShutdown` → if `autoOnSessionEnd`, write `auto-end-<getSessionId()>-<timestamp>`.
- `onConversationEvent(e)` → if `e.kind === 'roundComplete'` and `autoOnRoundComplete`, increment a plugin-local ordinal and write `auto-round-<ordinal>-<sessionId>-<timestamp>`.

Auto-checkpoints **accumulate** (distinct timestamped names, never overwrite), use distinct sinks, and read the session non-mutatively, so the three paths are safe to run concurrently.

**6. CLI flag.** `--checkpoint.restore <name>` — the dotted plugin-flag convention auto-enables the plugin and is read as `getCliFlags()['restore']`. (The original user spec wrote `--checkpoint-restore <name>`, but the plugin-flag facility in [239](239-herdr-agent-integration.md) only supports `--<pluginId>.<flag>`; the dotted form is the reconciled spelling. A bare `--checkpoint-restore` would not parse.) Documented in the plugin's help snippets.

**7. Soft import failures.** Restore runs through `portable-context`'s `importContext`, which collects per-contributor failures into `warnings[]` rather than aborting — for now ([246](246-portable-context.md) D3). The `/checkpoint restore` handler surfaces `warnings` and `unavailableTools` to the user.

## Alternatives considered

- **Configurable checkpoint directory (`checkpoint.dir`).** Rejected: the project-level default is the only scope the feature needs, and a configurable dir invites path bugs; the dir is derived from `process.cwd()`.
- **`--checkpoint-restore` (non-dotted).** Rejected: the plugin-flag parser only recognizes `--<pluginId>.<flag>`; a non-dotted flag would silently not parse. The dotted form is the facility's contract.
- **Overwriting auto-checkpoints per session.** Rejected: accumulation is strictly more useful (a session's history of round snapshots is the point), and distinct timestamped names cost nothing.
- **A `checkpoint` capability offered for contributor registration.** Rejected: the plugin **consumes** portable context; it contributes nothing to `pluginData`, so a contributor slot would be dead weight.

## Consequences

- `AGENTS.md`'s plugin table and the project wiki's plugin page gain `checkpoint`; the hook list gains `onSessionRecycle`.
- Checkpoints are **not** checked into version control by default (`.drone-agent/checkpoints` is session-scoped output of the `checkpoint` feature, unlike the intentionally-checked-in memory/skills/insights). Users who want them shared can commit them explicitly.
- `--checkpoint.restore` boots, restores before the first turn, and — because the target is empty — fires no recycle hooks ([246](246-portable-context.md) §8 validation).
- `/checkpoint restore` is queued while the LLM works; the other subcommands run immediately.

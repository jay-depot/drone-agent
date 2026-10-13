---
tags: [decision]
related:
  [
    061-mcp-client.md,
    153-tool-mounting.md,
    207-merged-footer-fragments-single-message.md,
    246-portable-context.md,
    mcp-plugin.md,
  ]
---

# 252 — MCP `streamable_http` double-mount fix + tool-availability disclosure

**Status**: Accepted (2026-10-13)

## Context

A `streamable_http` MCP server could mount its tools twice on connect, which
threw `Tool already registered` from the engine's duplicate guard and aborted
the `drone-agent` process via an unhandled promise rejection. The crash was
intermittent (it depended on SSE stream timing). `stdio` servers were
unaffected.

Root cause: two mount paths raced for the same server, and the mount was not
idempotent.

- `client.ts` wired `onStreamReconnected: options.onReconnected` and fired it
  the moment the GET SSE stream opened — i.e. on the **first** connect, not a
  real reconnect. It also fired `onReconnected` at the end of the initial
  connect, redundant with the caller's own mount. Both were fire-and-forget
  with no `.catch`.
- `index.ts` independently ran `listAndMountTools(serverId, …, 'ready')` after
  `createMcpClientConnection` resolved, and `onReconnected` unregistered the
  old `serverToolMaps` entries then re-ran `listAndMountTools`.
- `listAndMountTools` called `registration.registerTool(...)` for every
  discovered tool with **no prior unregistration** — not idempotent.
- A latent second bug: the `onReconnected` unmount loop walked only
  `serverToolMaps` (the MCP tools), never the `mcp__<server>__list` /
  `mcp__<server>__get` resource/prompt helpers, so a genuine reconnect
  re-registered those and collided on them too.

The same reconnect / list-change churn can also silently remove tools the model
has already been using, with no signal to the model that they are gone.

## Decision

### D1 — Initial connect never fires the remount path

There is no `onConnected` callback; the initial mount is the caller's explicit
`listAndMountTools(..., 'ready')`. The connect-end `onReconnected` fire was
deleted, and the SSE stream-open hook was repointed away from `onReconnected`.

### D2 — Callbacks split by meaning

- `onStreamOpened?: () => void` — the GET SSE (server→client notification)
  channel opened/reopened. The plugin only flips `state.streaming = true` and
  clears `state.lastStreamError`. **Never remounts.**
- `onReconnected?: () => void | Promise<void>` — a transport reconnect that may
  have changed the tool surface. Fired **only** on a stdio child respawn.
- Both fire-and-forget sites carry a `.catch`, so a future failure degrades to
  a log line instead of aborting the process.

### D3 — Idempotent, surgical reconcile

`listAndMountTools` was renamed to `reconcileServerTools`. It diffs the
previously registered set (from `serverToolMaps`) against the freshly listed
set and unregisters only tools that vanished, registers only tools that
appeared, and leaves persisting tools completely untouched (preserving their
engine mount state). Resource/prompt helpers (`__list`/`__get`) are registered
**once per server** via a per-server flag. A no-op reconcile changes nothing.

### D4 — Per-server serialization

All reconcile call sites (initial mount, stdio respawn, `list_changed`) are
wrapped in a keyed promise chain (`withKeyLock('mcp:<serverId>', …)`, from the
generalized `shared/keyed-lock.ts`). It is a **serializing chain, not a
coalescer**: a `notifications/tools/list_changed` arriving mid-reconcile must
re-list *afterwards* (the list did change), not be dropped.

### D5 — Core-level, engine-owned tool-availability disclosure

The engine tracks `everMounted` (every canonical tool name ever successfully
mounted) and renders `everMounted − currentlyMounted` as an engine-owned
**footer** fragment, merged into the single trailing `<system-reminder>`
message per ADR 207. It renders `false` when empty. It is sticky (survives
turns) but non-growing history, and self-heals when a tool returns. This is
deliberately **not** a one-shot system reminder (the model re-tries dead tools
once it scrolls out — the failure ADR 246 documented) and **not** a stored turn
(ADR 246's cost).

### D6 — Per-entry annotation, derived at render from registry membership

- name still registered (`getTool(name)` defined) →
  `(Automatically unmounted, mount again if needed)`
- name gone from the registry →
  `(Removed from available set, do not attempt to call or mount again)`

Heading `# Unavailable tools`; capped at 20 entries with an
`…and N more (call runtime__list_tools for the current set)` overflow line.

### D7 — Suppression is per-operation, opt-out, default announce

The engine's removal primitives take `{ announce?: boolean }` (default `true`).

- `runtime__unmount_tool` (the model unmounted it itself) → `announce: false`
  (its name is deleted from `everMounted`, so it never appears).
- `/tool unmount`, `/tool unmount --all`, persona `applyToolPremount`, MCP
  unregister/reconcile → **announce**.
- Global kill-switch: `session.announceToolRemovals` (boolean, default `true`).

### D8 — Human-facing notice

When the unavailable set gains names, one coalesced `notice` conversation event
(`[N tool(s) became unavailable]`) is emitted so the operator sees it in the
TUI. Coalesced at flush time over the *net* delta, so a bulk unmount+remount
that nets to zero is silent.

### D9 — `mount` on an already-mounted tool is a success

Both `runtime__mount_tool` (returns
`{ success: true, alreadyMounted: true, message }`) and `/tool mount` (logs
`Already mounted <name>.`) detect the already-mounted case via
`ToolRegistry.get` + `isMounted` (engine) / `listMountedTools` (slash context).
No new registry API was needed. The truly-unknown case still returns
`Unknown tool: <name>`.

### New config

`session.announceToolRemovals` (boolean, default `true`) — a scalar, so no
`deepMerge` entry is needed. Set `false` to silence the disclosure entirely.

## Rejected alternatives

- **Relax the engine duplicate guard** (make `registerTool` idempotent). Hides
  the real defect — a genuine double-mount bug — and weakens the guard that
  catches every other plugin's accidental duplicate registration. The mount
  path should be correct, not the guard permissive.
- **A one-shot system reminder for removals.** The model re-tries dead tools
  once the reminder scrolls out of the window (the failure ADR 246 documented).
- **A stored-turn disclosure.** Permanent context cost for a transient fact
  (ADR 246's cost).
- **A coalescing in-flight guard.** Coalescing would *drop* a
  `list_changed` that arrived mid-reconcile, but the list genuinely changed and
  must be re-listed. A serializing chain is required (D4).

## Consequences

- A `streamable_http` server's tools are registered exactly once per connect;
  an initial connect fires no `onReconnected`; a concurrent stream-open +
  caller mount cannot throw `Tool already registered`.
- A `list_changed` arriving during a reconcile still re-lists afterwards.
- The footer fragment reflects `everMounted − currentlyMounted`, self-heals on
  re-mount, respects `session.announceToolRemovals: false`, and caps at 20.
- `runtime__mount_tool` on an already-mounted tool returns
  `{ success: true, alreadyMounted: true }`; the unknown case still returns
  `Unknown tool`.
- No unhandled promise rejections are produced by the MCP reconnect paths.

---
tags: [decision]
related:
  [
    254-swarm-extensions.md,
    255-mcp-swarm-http-transport-and-tokens.md,
    223-gateway-swarm-console-control-surface.md,
    249-gateway-portable-context-continuity-and-outbound-ledger.md,
    211-beacon-coordinator-trust-hardening.md,
    modules/drone-gateway.md,
    modules/drone-swarm-common.md,
  ]
---

# 256 — drone-gateway as a swarm extension (v0, sender role)

**Status**: Accepted (2026-10-19)

## Context

The drone-gateway connects chat conversations to drone swarm agents. It talked
to the coordinator over the coordinator's **web port** with a shared **Bearer
token** (`coordinatorToken`) — a second connection and a second trust path
beside the beacon protocol of ADR [254](254-swarm-extensions.md).

ADR 254 built the extension protocol (mTLS identity, registration, reverse
channel, manifest, session events) and deferred the gateway replatform. That
deferral leaves the gateway unable to receive session events, which the next
phase needs to push tools and prompt fragments into the agents it caused.

This ADR records the v0 replatform: the **pipe**, not the features.

## Decision

**D1 — Sender only.** The gateway is an extension that **sends**. Its node
connection carries spawn and management requests. The callee direction (the
gateway declaring callable capabilities that other swarm members invoke) is a
later phase.

**D2 — Transport swap, class kept.** `CoordinatorClient` keeps its class and
its `SwarmApi` implementation, but no longer owns a transport. It takes a
`CoordinatorFetch` in its constructor — the extension node's mTLS
`getFetch()` — and sends every request through it. `coordinatorToken` and the
`Authorization` header are gone.

**D3 — Hint value.** The extension hint is `drone-gateway:<conversationId>`:
self-describing, and unique per conversation.

**D4 — Implicit gate.** `coordinatorUrl` **presence** enables the extension.
There is no separate flag. Absent `coordinatorUrl` means a standalone chat agent
runner. `coordinatorToken` is a **removed key** and is a hard error when
present, matching the removal precedent of `spawnBackend` / `targetBeaconId`.

**D5 — Settings block.** Optional `swarmExtension`:

| Field              | Default                 |
| ------------------ | ----------------------- |
| `id`               | `drone-gateway`         |
| `name`             | `Drone Gateway`         |
| `dataDir`          | `<configDir>/extension` |
| `requestTimeoutMs` | `15000`                 |

`dataDir` resolves against the config directory, with `~` expansion. An invalid
field falls back to its default with one warning.

**D6 — `coordinatorUrl` keeps its shape.** It stays the primary/mTLS address
(for example `http://127.0.0.1:3456`). The node derives the WebSocket URL from
it. The coordinator serves `/api/*` on both ports, so the node's fetch reaches
the same routes.

**D7 — One node per process.** A gateway process owns exactly one extension
node.

**D8 — Boot now, register in the background.** The gateway starts and serves
conversations at once. Registration retries with exponential backoff, and so
does the WebSocket — the beacon's shape, 1 s to 30 s, without end. `attempts`
resets on `open`.

**D9 — Empty manifest.** v0 declares
`{ protocolVersion: 1, capabilities: [], bundles: [] }`. The node is an
extension because it declares a manifest (ADR 254 D15); the manifest is empty
because nothing is callable yet.

**D10 — Hint on both backends.** The extension hint goes to the coordinator
backend (`config.extensionHint`) **and** the local backend
(`--extension-hint`). In local mode it is inert today; the next phase needs it.

**D11 — Session events are log-only.** `sessionStarted` / `sessionEnded`
handlers are wired but write a debug line. Filtering by hint is the next phase.

**D12 — Bounded request timeout.** The node's coordinator fetch has a bounded
request timeout (default 15 s, `swarmExtension.requestTimeoutMs`). On timeout it
rejects with `coordinator did not respond within <ms> ms`. Before this, a stalled
coordinator could block a conversation's dispatch tail without end.

**D13 — Shutdown order.** Stop the **Injection API**, then the **Gateway
Engine** (agents terminate over the live node), then the node, then exit.
Terminate stays best-effort; waiting for terminate confirmation is project-wide
hardening, out of scope here.

**D14 — A handle, not a transport.** New module
`drone-gateway/src/extension-node.ts` exports `ExtensionNodeHandle`, which owns
start / readiness / fetch / stop. `main()` owns the handle. `CoordinatorClient`
stays a transport only.

**D15 — SDK registration retry.** `createExtensionNode` gains
`awaitRegistration` (default `true`). With `false` it resolves before
registration and retries in the background. The gateway passes `false`.
`stop()` clears both the WebSocket reconnect timer and the registration-retry
timer.

**D16 — No coordinator or beacon change.** Both `SpawnConfig` types already
carry `extensionHint`, and the spawner already appends `--extension-hint`.

**D17 — Documentation and dependency.** This ADR, `drone-gateway/CONTEXT.md`,
`docs/agents/swarm-extensions.md`, and the swarm wiki. `drone-swarm-common`
becomes a gateway dependency.

## Trust note

A loopback registration is auto-approved (ADR
[211](211-beacon-coordinator-trust-hardening.md)), so a gateway on the same host
as the coordinator needs no ceremony. A remote gateway needs the pre-approval
token flow, which is deferred. The node's identity and TLS material live under
`dataDir`; the fingerprint is pinned on first contact (TOFU).

## Consequences

- One connection and one trust path replace two.
- The gateway needs no shared secret; it authenticates with its own mTLS
  identity.
- The node gives the gateway a session-event channel and a manifest, which the
  next phase uses for tool and prompt injection.
- **Breaking**: a `coordinatorToken` in `config.json` is now a hard error. The
  gateway host must delete it (a manual, out-of-repo step; ADR
  [224](224-gateway-swarm-console.md) set that precedent for
  `targetBeaconId`).
- Temporary loss of network capability is accepted: a gateway that cannot reach
  its coordinator serves local conversations and registers when the coordinator
  returns.

## Deferred

- The callee direction.
- Tool injection and prompt fragments for gateway-spawned agents.
- The gateway config UI.
- Remote extensions and the pre-approval-token flow.
- Project-wide shutdown hardening (wait for terminate confirmation).
- A front-end bundle for the gateway.

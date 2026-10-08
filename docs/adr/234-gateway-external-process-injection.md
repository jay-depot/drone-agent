---
tags:
  [
    decision,
    gateway,
    injection,
    control-api,
    external-process,
    helper-cli,
    one-shot-agent,
    architecture,
    adr,
  ]
related:
  [
    modules/drone-gateway.md,
    decisions/232-gateway-surface-lifecycle-and-working-dir.md,
    decisions/233-gateway-chat-tagging-batching-optout.md,
    decisions/224-gateway-spawn-targeting.md,
    decisions/223-gateway-swarm-console-control-surface.md,
    concepts/spawn-backend.md,
    concepts/json-listen-mode.md,
  ]
---

# 234 — Gateway external-process injection + one-shot agent helper

**Status**: Implemented (2026-10-07) · **Branch**: `feat/gateway-external-process-injection` · **Commit**: `d950a1ce` · **PR**: #119 · **Gateway ADR**: none (project-wiki only)

**Summary**: The gateway bridged chat platforms to agents in **one direction only** — _inbound_ (`chat → engine → control surface → SpawnBackend.sendMessage → agent`). There was no way for an _external_ process (a cron job, a CI hook, any script) to get text **into** a chat conversation. This ADR adds the **outbound** direction: a new loopback HTTP **control API** on the daemon (`POST /inject`, `GET /status`, `GET /conversations`), a second binary `drone-gateway-inject` with two subcommands (`inject-message` — post a literal string, no LLM; `run-agent` — spawn a one-shot `drone-agent`, post its final chat message), and the engine bridge that ties them together. The daemon performs the actual post (it owns the platform connections, E2EE keys included), so the helper never touches platform state.

## Why

1. **Inbound-only.** Every path led _into_ the gateway; nothing could post _out_ except a live control surface answering a message. Recurring jobs (heartbeats, triage, reports) had no way to surface a result.
2. **External processes cannot hold platform credentials.** E2EE keys ([229-gateway-matrix-crypto-opt-in](229-gateway-matrix-crypto-opt-in.md)) live only in the daemon process, so a stand-alone helper cannot post directly — the daemon must do the post on the helper's behalf.
3. **A spawn-and-report job needs a one-shot agent, not a resident session.** The existing machinery (`LocalSpawnBackend`) is built for a persistent child answering turn after turn; a report job launches an agent, lets it finish, and exits.

## Locked decisions (27, from the planning grilling)

1. **Two helpers, one shared injection API.** Both `drone-gateway-inject` subcommands go through one loopback HTTP **control API** on the daemon (new `controlApi` config). The helper owns arg parsing / child spawning; the daemon owns the post.
2. **Outbound only.** Inject = `adapter.sendMessage()`. It does **not** go through the engine's surface dispatch. Inbound delivery (a posted message becoming a user turn) and conversation continuity are **deferred** to a later feature that will likely subsume parts of this one.
3. **Opt-in is per-conversation.** `injection: { enabled: boolean }` in the conversation file; the loader keeps a conversation that has a non-empty `controlSurfaces` **or** `injection.enabled` (a conversation loaded for injection only, with zero surfaces, drops inbound chat — unchanged surface behavior). The **wildcard `*` is never an injection target** — an `injection` block on `_default_.json` is ignored with a warning.
4. **The agent helper spawns a local child only.** Coordinator-routed spawn is deferred (it needs the deferred coordinator receive path).
5. **A dedicated one-shot module**, `src/inject/spawn-once.ts` — **not** `LocalSpawnBackend`. Only `resolveDroneExecutable` (from `drone-core`) and the NDJSON event _kinds_ are reused; the persistent-child machinery is deliberately avoided.
6. **Second bin in the same package**, `drone-gateway-inject`, with subcommands `inject-message` and `run-agent`.
7. **API shape.** `POST /inject`, `GET /status`, `GET /conversations`; unknown adapter/conversation → **404**, not opted in → **403**, bad body → **400**.
8. **Framing is verbatim** plus an optional caller-supplied `--prefix`.
9. **`controlApi: { enabled: false, host: "127.0.0.1", port: 8090 }`** (+ optional `token`). Loader warns when `enabled` and `host` is not loopback.
10. **Task input = positional or `--task-file <path|->` (stdin); exactly one.**
11. **`run-agent` flags:** `--persona --working-dir --model --agent-path --timeout(600s) --json`.
12. **The one and only return value is the final chat message** (the last `assistantMessage`). No subagent mimicry; inject on success only.
13. **Final-only.** Streaming narration (interim `assistantMessage`s) is deferred behind a default-off `--narration`.
14. **Task-only input; no ambient conversation context.**
15. **Optional `controlApi.token` (Bearer).** Loopback trust when unset.
16. **The helper discovers the daemon** via `--config` → `controlApi.{host,port,token}`, with `--host`/`--port`/`--token` + `DRONE_GATEWAY_TOKEN` overrides (override > env > config-file > built-in default).
17. **Bridge = public engine methods.** `injectMessage(adapterId, conversationId, text)` + `listAdapterIds()` + `listInjectableConversations()`, with typed errors.
18. **Failure matrix.** Unreachable/404/403 → stderr + exit 1; child error/timeout → no inject + exit 1; success → inject + exit 0. Plain SIGTERM→SIGKILL (no process group).
19. **No serialization.** Injection bypasses the per-conversation `runOnTail`; it may interleave with a live turn (documented).
20. **`inject-message` input = positional or `--file <path|->`; exactly one.**
21. **`--prefix` on both subcommands**, helper-side, prepends to the first line (literal prepend); interprets `\n`, `\t`, `\\` (other escapes literal).
22. **Server lifecycle in `main()`.** `ControlApiServer` built after `engine.start()`, stopped before `engine.stop()`; `EADDRINUSE` → exit 1; no hot-reload.
23. **Fixed 30s helper HTTP timeout.** `--timeout` is the _agent_ budget only, not the HTTP call.
24. **Docs.** This decision lives in project memory (the user's macro pulls it into the wiki). No `docs/` how-to, no gateway-local ADR. `drone-gateway/CONTEXT.md` is updated.
25. **Hand-rolled arg parser** (may unify into `drone-core` later).
26. **`run-agent --no-response-sentinel`.** On `isNoResponse(finalMessage)` → inject nothing, stderr notice, **exit 0**; `--json` reports `{ ok: true, injected: false, suppressed: true }`. This lets a recurrent heartbeat job stay quiet.
27. **Incidental rules.** The child's stdin is **closed** after the kickoff line (`runJsonMode` reads stdin until EOF); `--working-dir` is passed **both** as `--working-dir <dir>` **and** as the child `cwd`; an empty/whitespace final message → no inject, stderr warning, exit 0.

## Implementation

**New**

- `drone-gateway/src/errors.ts` — `UnknownAdapterError`, `UnknownConversationError`, `InjectionNotEnabledError`.
- `drone-gateway/src/control-api/server.ts` — `ControlApiServer` (Fastify): optional `onRequest` Bearer gate; `GET /status`, `GET /conversations`, `POST /inject`; typed error → status mapping (404/403/500), 400 on bad body.
- `drone-gateway/src/inject/args.ts` — `parseInjectArgs`, `usageText`, `DEFAULT_TIMEOUT_SECONDS = 600`, `InjectInvocation`/`InjectCommonOptions`; subcommand detection, exactly-one input rules, `--port` (1–65535) and `--timeout` (finite ≥ 0) validation, unknown-flag rejection.
- `drone-gateway/src/inject/prefix.ts` — `unescapePrefix`, `applyPrefix`.
- `drone-gateway/src/inject/client.ts` — `ControlApiClient` (`status`/`listConversations`/`inject`), `GatewayUnreachableError`, `GatewayHttpError`, `HTTP_TIMEOUT_MS = 30_000` (`AbortSignal.timeout`).
- `drone-gateway/src/inject/spawn-once.ts` — `spawnOnce` (spawns `drone-agent --once --output-json`, writes `{ type: 'kickoff', task }` to stdin then ends it, returns the **last** `assistantMessage`, ignores non-JSON stderr logs, SIGTERM→SIGKILL after a 5s grace on timeout), `SpawnOnceTimeoutError`, `SpawnOnceFailureError`.
- `drone-gateway/src/inject/commands.ts` — `runInjectCli` (+ `runInjectMessage`, `runRunAgent`, `resolveControlApi`, `readText`/`readStdin`); maps the failure matrix to stderr + exit codes.
- `drone-gateway/src/inject/cli.ts` — bin entry (`main()` → `runInjectCli`).
- `drone-gateway/bin/drone-gateway-inject` — ESM shim → `dist/inject/cli.js`.

**Modified**

- `drone-gateway/src/types.ts` — `ControlApiConfig { enabled; host; port; token? }`; `GatewayConfig.controlApi?`; `ResolvedConversation.injectionEnabled?`.
- `drone-gateway/src/config/load.ts` — `parseControlApi` (warn-and-default; non-loopback-host warning when enabled); `parseInjection` (boolean-true only; wildcard ignored with a warning); relaxes the "non-empty surfaces" requirement to `specs.length === 0 && !injectionEnabled → skip`; `controlApi` always present on the built config.
- `drone-gateway/src/engine.ts` — `InstantiatedConversation.injectionEnabled`; `listAdapterIds()`; `listInjectableConversations()`; `injectMessage()` (outbound-only: straight to `adapter.sendMessage`, **not** through `runOnTail`); imports the three typed errors.
- `drone-gateway/src/index.ts` — `readGatewayVersion()`; construct/start `ControlApiServer` after `engine.start()` when `controlApi.enabled`, stop it before `engine.stop()` in both the shutdown handler and the catch.
- `drone-gateway/package.json` — adds `fastify@^5.12.5` + the `drone-gateway-inject` bin.
- `drone-gateway/CONTEXT.md` — glossary: _Injection_, _Injection API_, _Injection Target_, _Agent Helper_, _Message Helper_; config layout gains `controlApi`.
- `pnpm-lock.yaml` — the `fastify` specifier for the drone-gateway importer.

## Validation

LSP clean; `pnpm -r run typecheck` exit 0; `pnpm -r run build` exit 0; `pnpm run lint` exit 0; root `pnpm test` **3672 passed / 14 skipped / 268 files**. Gateway suite **451 passed / 32 files**.

New suites: `control-api-server.test.ts` (10), `inject-args.test.ts` (21), `inject-client.test.ts` (9), `inject-commands.test.ts` (12), `inject-prefix.test.ts` (9), `inject-spawn-once.test.ts` (6). Extended: `config-load.test.ts` (29→42 — `controlApi` defaults/validation + injection parsing), `engine.test.ts` (22→28 — injection bridge), `index.test.ts` (11→12 — control-API start wiring).

## Notes

- **The daemon must own the post.** E2EE keys (ADR 229) live only in the daemon; a helper with its own Matrix client would need its own keys and would fork the session. So the helper only _asks_ the daemon to post.
- **`spawnOnce` writes-and-closes stdin deliberately.** `runJsonMode` reads stdin until EOF, so the kickoff event must be followed by `end()` or the child never starts.
- **Two `apply_diff` frictions hit during execution** (recorded as insights): a patch whose hunks lack `@@ -a,b +c,d @@` headers is rejected outright (`no hunks found`), and a multi-hunk patch can **partially** apply (it reports which hunks failed) — re-read and re-apply only the failed hunk.
- **`pnpm run lint` dirties the tree** (recorded as an insight, recurring): `prettier --write .` reformats `pnpm-lock.yaml` (~5800 lines) and touches `.drone-agent/`; revert those, then restore the real lockfile delta with `pnpm install --no-frozen-lockfile` and verify with `--frozen-lockfile`.

## Out of scope (explicitly deferred)

- **Remote (coordinator-routed) spawn** for `run-agent` — needs the deferred coordinator receive path.
- **Streaming narration** (`--narration`, default off) — inject interim `assistantMessage`s (must dedup the child's final-message echo).
- **Inbound delivery** (inject as a user turn to a resident surface) and **conversation continuity / session resume** — a later feature, expected to subsume parts of this one.
- **Reconciling `drone-gateway/docs/adr/` with the project wiki's ADRs** — redundant and out of sync.
- **Unifying the hand-rolled CLI parsers** into `drone-core`.
- A **config-level per-conversation prefix**.

## Related

- [drone-gateway](../../drone-gateway/) — the gateway module page (config model, key files, types, tests).
- [232-gateway-surface-lifecycle-and-working-dir](232-gateway-surface-lifecycle-and-working-dir.md) — the prior gateway slice (surface lifecycle; the `workingDir` precedent the helper's `--working-dir` mirrors).
- [233-gateway-chat-tagging-batching-optout](233-gateway-chat-tagging-batching-optout.md) — the sibling outbound work; `isNoResponse`/`NO_RESPONSE_SENTINEL` reused by `--no-response-sentinel`.
- [224-gateway-spawn-targeting](224-gateway-spawn-targeting.md) — the per-surface config pattern the `injection` opt-in parallels.
- [223-gateway-swarm-console-control-surface](223-gateway-swarm-console-control-surface.md) — the other "chat drives the system" surface (no LLM), contrasted with injection (no dispatch at all).
- spawn-backend — the persistent-session machinery `spawn-once` deliberately avoids.
- json-listen-mode — the `runJsonMode` (`--once --output-json`) protocol the helper drives.

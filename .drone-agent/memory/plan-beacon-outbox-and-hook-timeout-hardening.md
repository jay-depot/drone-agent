---
key: plan-beacon-outbox-and-hook-timeout-hardening
tags:
  - plan
  - drone-beacon
  - drone-coordinator
  - outbox
  - session-end
created: 2026-10-26T16:01:03.742Z
updated: 2026-10-26T16:01:03.742Z
---

# Plan: Beacon outbox hardening + session-end hook timeout + coordinator defects

Status: COMPLETED 2026-10-26 on branch `fix/outbox-and-hook-timeout-hardening` (commits b4cfc9c1, 64f9c351, 693d9bfe, d98352c4, da38f425). All steps 1–10 executed. Full gates green: `pnpm -r run build`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run test` (4458 passed, 16 skipped, 0 failed).

## Implementation notes / deviations

- Step 2 deviation: `resolveSessionEndCommandTimeoutMs` + `DEFAULT_COMMAND_TIMEOUT_MS` (300000) live in new `drone-coordinator/src/command-timeout.ts`, not `index.ts`. Reason: importing `src/index.js` from a test fails to resolve `drone-swarm-common/tls` under the root vitest config — `test/app-helper.ts` exists precisely to avoid importing index.ts (it has TLS deps). `session-end.ts` now imports the shared default from command-timeout.ts too (its own private 30000 fallback removed).
- Step 7: coordinator-ws backoff-reset IS unit-tested (`drone-beacon/test/coordinator-ws.test.ts`, FakeWebSocket harness + fake timers: two closes escalate 1s→2s, then open+close reconnects at the 1s floor again). Connect-log tests assert both 'present' and 'ABSENT' variants.
- Pre-existing failures verified on clean stashes and left untouched: coordinator `test/wiki-routes.test.ts > GET /api/wiki/graph`, and the beacon wiki tests (wiki-origin-reads, wiki-index-support, wiki-semantic-search, wiki-indexer) when run with the BEACON-PACKAGE vitest config from inside `drone-beacon/` (they pass under the root config — the failures are config-dependent, not related to this work; the wiki tests expect a fresh knowledge-base dir that prior test runs polluted).
- Test-run residue: `drone-beacon/knowledge-base/` and `drone-coordinator/knowledge-base/` untracked dirs — do not commit.

Out of scope, user-owned: mirroring the flock guard onto the deployed ambiorix catch-up/hook scripts. Same-host auth exception (claimed-identity WS path) is broken by design today; user deferred fixing it. Post-deploy validation on ambiorix still pending (beacon RSS flat during coordinator-down window, outbox file near-zero, next hourly librarian produces a non-empty transcript).

## Summary

Three problems, one branch:

1. **Outbox unbounded growth + RSS spikes.** The beacon's durable outbox (SQLite `outbox` table) has no delete-on-delivery, no body-size cap, and an unbounded dequeue query. On ambiorix this grew to 39,548 rows / 1.6 GB, and the 60 s flush tick materializing the whole undelivered backlog is the best theory for the hourly RSS spike (3.0–4.4 GB, earlyoom kills).
2. **Session-end hook timeout too short.** 30 s hardcoded in both servers kills the librarian agent mid-run. Decision: raise default to 5 minutes and add a `sessionEnd.commandTimeoutMs` config key.
3. **Small confirmed defects:** WS reconnect backoff never resets after a successful connect; the beacon logs nothing about the coordinator URL/cert it dials; coordinator 500s from UNIQUE-constraint failures on client-supplied primary keys; the bootstrap catch-up script template has no concurrency guard.

## Locked decisions

- Delete-on-delivery (NOT a retention window) in `markOutboxDelivered`.
- Enqueue body cap ~900 KB, log-and-drop above (coordinator bodyLimit is 1 MiB).
- Bounded dequeue using the `idx_outbox_undelivered` partial index.
- `DEFAULT_COMMAND_TIMEOUT_MS` 30000 → 300000 in both servers + `sessionEnd.commandTimeoutMs` config key validated in `drone-swarm-common`.
- WS backoff reset on successful open; startup log of dialed URL + cert presence.
- UNIQUE-constraint INSERTs → idempotent upsert/no-op.
- Bootstrap catch-up template: `flock` guard.
- NOT in scope: `drone-swarm` CLI stale beacon dialect (low priority), `DRONE_COORDINATOR_WEB_TOKEN` env fix (deployment, ambiorix), same-host auth exception, ambiorix deployment scripts.

## Dependencies and order

Step 1 must land first (drone-swarm-common types; dependent packages resolve types from built dist/ — run `pnpm -r run build` after it). Steps 2–9 are independent of each other after Step 1; do them in the listed order. Step 10 last.

## Steps

### Step 1 — `drone-swarm-common`: `sessionEnd.commandTimeoutMs`
File: `drone-swarm-common/src/config-file.ts`
- Extend the `SessionEndTrigger` command variant: `{ type: 'command'; command: string; commandTimeoutMs?: number }`.
- In `validateSessionEnd`: for the `command` variant, if `commandTimeoutMs` is present it must be a finite number > 0; error string `"sessionEnd.commandTimeoutMs" must be a positive number`. Keep the existing unknown-key rejection (the new key becomes an allowed key for the command variant only; the spawn variant still rejects it).
- Note: `mergeConfig` deep-merges `sessionEnd` within a matching trigger type, so a partial file override keeps working.
- Tests in `drone-swarm-common/test/config-file.test.ts`: accept `{ type:'command', command:'x', commandTimeoutMs: 300000 }`; reject zero, negative, non-number.
- After this step: `pnpm -r run build` before checking dependent-package types.

### Step 2 — Coordinator: default 5 min + read config key
File: `drone-coordinator/src/index.ts`
- Line ~80: `const DEFAULT_COMMAND_TIMEOUT_MS = 300000;`
- In the `configureSessionEndHook({ ... })` call (~line 583): pass `commandTimeoutMs: config.sessionEnd.type === 'command' && config.sessionEnd.commandTimeoutMs !== undefined ? config.sessionEnd.commandTimeoutMs : DEFAULT_COMMAND_TIMEOUT_MS`.
- `SessionEndHookConfig.commandTimeoutMs` already exists in both servers' `session-end.ts`; no signature change.

### Step 3 — Beacon: default 5 min + read config key
File: `drone-beacon/src/index.ts`
- Line ~99: `DEFAULT_COMMAND_TIMEOUT_MS = 300000`.
- Same conditional read in `configureSessionEndHook` (~line 285). The beacon passes `beaconId` too — keep it.

### Step 4 — Outbox: delete-on-delivery
File: `drone-beacon/src/db/outbox.ts`
- `markOutboxDelivered` becomes: `DELETE FROM outbox WHERE id = ?` (was UPDATE … SET deliveredAt).
- Keep the `deliveredAt IS NULL` filter in dequeue queries — the column stays in the schema (no migration) and the filter is harmless.
- Tests (`drone-beacon/test/outbox.test.ts`): update/extend the "marks entries delivered" test to assert the row is gone (`SELECT` by id returns undefined) and pending count drops. Existing tests that only check `dequeueDueOutbox`/`countPendingOutbox` after delivery keep passing.

### Step 5 — Outbox: enqueue body cap
File: `drone-beacon/src/db/outbox.ts`
- New constant `MAX_OUTBOX_BODY_BYTES = 900 * 1024`.
- In `enqueueOutbox`: serialize the body first, measure with `Buffer.byteLength(json, 'utf8')`; if over the cap, `logger.error(...)` (kind + endpoint + size) and return `undefined`.
- Change return type to `OutboxEntry | undefined`. Sole caller is `sendFireAndForget` in `drone-beacon/src/coordinator-client.ts:37-50`, which ignores the return value — no sweep needed, but verify with LSP find-references on `enqueueOutbox`.
- Import `logger` (`../logger.js`) into the db module.
- Test: enqueue a >900 KB body → returns undefined, `countPendingOutbox(true)` unchanged, no throw.

### Step 6 — Outbox: bounded dequeue
File: `drone-beacon/src/db/outbox.ts`, `dequeueDueOutbox`
- Replace the unbounded `SELECT * FROM outbox WHERE deliveredAt IS NULL` with two bounded queries:
  1. Fresh rows: `SELECT * FROM outbox WHERE deliveredAt IS NULL AND attempts = 0 ORDER BY createdAt ASC LIMIT ?` (limit param).
  2. Retry rows: `SELECT * FROM outbox WHERE deliveredAt IS NULL AND attempts > 0 ORDER BY lastAttemptAt ASC LIMIT ?` (limit param).
- JS-filter for due-ness (existing backoff math), merge, sort by `createdAt`, slice to `limit`. Both queries hit `idx_outbox_undelivered` instead of materializing the whole backlog.
- Call the queries with `limit` (the function's own cap); `countPendingOutbox()` calls with `Number.MAX_SAFE_INTEGER` keep working unchanged.
- Test: insert more undelivered rows than the limit, assert only the oldest `limit` are returned in `createdAt` order.

### Step 7 — WS backoff reset + connection logging
File: `drone-beacon/src/coordinator-ws.ts`
- In `connect()` (~line 98): change the log line to include cert presence, e.g. `Connecting to coordinator reverse channel at ${coordinatorUrl} (client certificate: ${tlsIdentity ? 'present' : 'ABSENT'})`.
- In the `ws.on('open')` handler (~line 123): add `attempts = 0;` before `announceFingerprint()`. This is the one-line backoff-reset fix; the extension client (`extension-server.ts:328,365`) is the reference pattern.
- Test if a unit test is feasible with the existing ws mocking in `drone-beacon/test/`; if the file has no existing test harness, a manual-verification note is acceptable (keep it honest in the commit message).

### Step 8 — Coordinator: idempotent session/event inserts
Files: `drone-coordinator/src/db/swarm-sessions.ts`, routes in `drone-coordinator/src/routes/swarm.ts`
- `createSwarmEvent` (~line 268): add `ON CONFLICT(id) DO NOTHING`. Keep returning the event. This kills the 500s when the outbox replays `/sync/events/push` with already-stored event ids (replay is by design idempotent — the 404-as-delivered rule depends on it).
- `createSwarmSession` (~line 51): add `ON CONFLICT(id) DO NOTHING` and, when the insert is a no-op, fetch and return the existing row (`getSwarmSession(id)`) so `/sync/sessions/register` stays 201-without-duplicate instead of 500.
- Check the route handlers do not assert on rows-affected; adjust if needed.
- Tests in `drone-coordinator/test/db.test.ts` (existing `createSwarmEvent` block ~line 868): replay the same id twice → no throw, single row; register the same session id twice → returns the original row, no duplicate.

### Step 9 — Bootstrap template: flock guard
File: `drone-agent/src/plugins/bootstrap/swarm-memory-scripts.ts`, `buildCatchupScript`
- Near the top of the generated script, after `set -euo pipefail`:
  ```bash
  exec 9>"$HOME/.drone-swarm-memory/.catchup.lock"
  flock -n 9 || { echo "catch-up: another instance is running; exiting"; exit 0; }
  ```
- Scope: template only. The user mirrors the deployed scripts on the coordinator host by hand (their explicit responsibility, do not plan a deployment step).
- Note in the script comment why: a hung librarian child must not stack concurrent catch-up batches.
- Check `drone-agent/test/` for `buildCatchupScript` snapshot/shape tests and update them.

### Step 10 — Docs
- `docs/adr/151-memory-pipeline-infra.md`: add a dated postscript — session-end timeout now defaults to 300000 ms, override with `sessionEnd.commandTimeoutMs` (command variant only); outbox rows are deleted on delivery; enqueue bodies over 900 KB are dropped with an error log; dequeue is bounded and index-driven.
- Grep `docs/` for "30s" / "30000" near session-end and update any stale claims.
- `docs/agents/memory-pipeline.md` if it documents the timeout or outbox retention.

## Validation criteria

1. `pnpm -r run build` — zero errors (run after Step 1 and at the end).
2. LSP diagnostics clean across all touched packages.
3. `pnpm run lint` passes (prettier will reformat — re-read files after).
4. `pnpm run test` (fast suite) passes, including new tests for: config validation (accept/reject `commandTimeoutMs`), delete-on-delivery, body cap drop, bounded dequeue ordering, duplicate event/session replay, catch-up script flock lines.
5. `pnpm run typecheck` passes.
6. Grep sweep: no remaining `SELECT * FROM outbox WHERE deliveredAt IS NULL` without LIMIT outside `countPendingOutbox` paths; both `configureSessionEndHook` sites read the config key; no plain `INSERT INTO swarm_events` / `swarm_sessions` without `ON CONFLICT`.
7. Manual (post-deploy, not blocking the plan): on ambiorix at the next coordinator-down window, confirm beacon RSS stays flat and outbox file size stays near-zero. Verify the next hourly librarian session on ambiorix produces a non-empty transcript (closes the original ingest complaint).
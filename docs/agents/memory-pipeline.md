# Memory Pipeline

The memory pipeline connects two existing subsystems: **session-data
collection** (sessions and conversation events flow from agents through
beacons to the coordinator) and **memory retrieval** (personas, skills, and
the wiki are synced back down). This document covers the infrastructure that
lets you build your own pipeline between them — or use the opinionated
default instead.

> **Opinionated default:** the `bootstrap__swarm-memory` workflow sets up the
> complete write-side pipeline for you: it generates a session-end ingest
> hook and a cron catch-up script (both feed ended-session transcripts to
> headless `coordinator-wiki-librarian` agent sessions via the
> `drone-swarm session transcript` command), merges the `sessionEnd`
> command trigger into the coordinator (and optionally beacon) config
> files, offers ask-first restarts, and smoke tests on real ended
> conversations. Run it from an agent on the coordinator host with
> `--plugin bootstrap`. Everything below is the "roll your own"
> alternative for people who want different trade-offs.

## Data flow

```
drone-agent session ends
        │
        ▼
beacon  ── DELETE /sync/sessions/:id ──► coordinator DELETE /api/sync/sessions/:id
        │   (session-end hook #1)          updateSwarmSessionStatus('ended')
        │                                  publishMutationEvent(session.ended)
        │                                  (session-end hook #2)
        ▼
session status lifecycle: active → stale → ended → processing → processed → archived
```

Both layers can fire a **session-end trigger** when a session ends:

- **Beacon**: `DELETE /sync/sessions/:id` (the agent-facing proxy). Fires after
  the end is forwarded to the coordinator; works offline.
- **Coordinator**: `DELETE /api/sync/sessions/:id`. Fires after the session is
  marked `ended` and the mutation event is published. This is the layer most
  users should choose, because the coordinator holds the shared knowledge base.

## Config files

Both servers accept `--config-file <path>` with resolution order
**defaults → file → CLI flags** (flags win). Session-end triggers are only
readable from a config file — they are not expressible as CLI flags, so using
a trigger implies a config file.

Example `~/.drone-coordinator/config.json`:

```json
{
  "port": 3456,
  "host": "0.0.0.0",
  "webPort": 8080,
  "webHost": "127.0.0.1",
  "useHttps": false,
  "sessionEnd": {
    "type": "command",
    "command": "drone-swarm --coordinator session process {session_id} && /usr/local/bin/my-ingest.sh {session_id}"
  }
}
```

Recognized top-level keys: `port`, `host`, `webPort`/`webHost` (coordinator
only), `dbPath`, `useHttps`, `sessionEnd`. Unknown keys are rejected at startup
with every problem listed at once.

### SessionEndTrigger

A discriminated union — strictly one variant or the other:

```jsonc
// Shell out. {session_id} is substituted. Non-blocking; stderr/stdout go to
// the server log; a 30s timeout applies.
{ "type": "command", "command": "my-ingest.sh {session_id}" }

// Spawn an agent via the swarm spawn system.
{ "type": "spawn", "persona": "coordinator-wiki-librarian", "beaconId": "beacon-123" }
```

- **Beacon layer**: `spawn` without `beaconId` defaults to _this_ beacon. A
  `beaconId` naming a different beacon is skipped with a warning.
- **Coordinator layer**: `spawn` requires `beaconId` — startup fails with a
  config error if it is missing. The spawn is forwarded to that beacon's
  `POST /spawn`.

Hook failures never affect the HTTP response; they are logged and contained.

## drone-swarm CLI

`drone-swarm` is a standalone REST client replacing curl+jq incantations in
pipeline scripts. It prints JSON to stdout and errors to stderr (exit code 1).

Address selection (mutually exclusive):

| Source      | Form                                         |
| ----------- | -------------------------------------------- |
| Flag        | `--coordinator <url>` or `--beacon <url>`    |
| Environment | `DRONE_COORDINATOR_URL` / `DRONE_BEACON_URL` |
| Default     | local coordinator on `http://localhost:3456` |

The target picks both address **and route dialect** — the coordinator serves
everything under `/api/...`, while the beacon serves wiki routes flat
(`/wiki/...`) and only proxies session reads (`/sync/sessions/:id/log`).

Session commands (coordinator):

```bash
drone-swarm --coordinator session list --status ended --limit 20
drone-swarm --coordinator session log <id>       # full transcript as JSON
drone-swarm --coordinator session process <id>   # ended → processing (returns transcript)
drone-swarm --coordinator session processed <id> --summary "..." --notes "..."
drone-swarm --coordinator session archive <id>   # processed → archived
drone-swarm --coordinator session restore <id>   # archived → processed
```

Bare `session list` (no `--status`) excludes archived sessions by default; use
`--status archived` to list archived sessions.

Wiki commands (both layers):

```bash
drone-swarm --coordinator wiki read <pageId>
drone-swarm --coordinator wiki write <pageId> --title "Page" --file page.md \
  --tags reference,pipeline --sources session-abc123
drone-swarm --beacon wiki search "rate limiting"
```

### Example bash pipeline

```bash
#!/usr/bin/env bash
set -euo pipefail
SESSION_ID="$1"
COORD="http://localhost:3456"

# Transition to processing and pull the transcript in one call.
drone-swarm --coordinator "$COORD" session process "$SESSION_ID" \
  > "/var/lib/memory-pipeline/$SESSION_ID.json"

# Analyze + insert into the wiki (your logic here).
/usr/local/bin/my-ingest.sh "/var/lib/memory-pipeline/$SESSION_ID.json"

# Mark complete so the session leaves the processing queue.
drone-swarm --coordinator "$COORD" session processed "$SESSION_ID" \
  --summary "ingested into wiki"
```

## Beacon outbox

When a beacon is configured with a coordinator, its fire-and-forget writes are
durable: they land in an SQLite `outbox` table first and a background flusher
delivers them to the coordinator.

- **Queued (fire-and-forget)**: pushEvents, registerSwarmSession,
  updateSwarmSessionPersona, endSwarmSession, pushPersona/pushSkill/
  deletePersona/deleteSkill, pushKnowledge, pushToolDefinitions.
- **Not queued (request-response or self-healing)**: spawn requests (dropped
  with an error if unreachable), registerBeacon, approval polling, heartbeats,
  persona/skill/knowledge fetches, relayMessage, session-pipeline reads.

Flush behavior: runs on an interval derived from `--sync-interval-minutes`
(capped at one minute), batches up to 50 entries oldest-first, retries failed
deliveries with exponential backoff (1s → 2s → 4s …), treats `404` as delivered
(the queued routes are idempotent under replay, so lost-response replays
self-heal), and permanently drops entries after 10 attempts with an error log.

If the beacon restarts before delivery, undelivered entries survive in SQLite
and drain once the coordinator is reachable again.

## Status lifecycle

Sessions move through: `active` → `stale` (24h inactive, hourly sweep) →
`ended` (agent disconnect or manual end) → `processing` (a pipeline claimed it;
the claim response includes the full resolved transcript) → `processed`
(pipeline finished; optional summary/notes attached) → `archived` (processed
sessions can be archived to hide them from the default sessions list; an
archived session can be restored to `processed`, or ended via the beacon's
authoritative sync `DELETE`).

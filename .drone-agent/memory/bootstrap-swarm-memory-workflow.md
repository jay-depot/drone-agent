---
key: bootstrap-swarm-memory-workflow
tags:
  - spec
  - workflow
  - bootstrap
  - swarm
  - memory-ingest
created: 2026-07-28T22:13:41.000Z
updated: 2026-07-28T22:13:41.000Z
---

# Spec: `bootstrap__swarm-memory` Workflow

## Overview

A new workflow registered in the `bootstrap` plugin that interactively sets up
an automated memory-ingestion pipeline. When a user runs:

```
drone-agent --plugin bootstrap --workflow bootstrap.swarm-memory
```

...the workflow checks prerequisites, optionally prompts the user about pipeline
design, writes the ingest script and systemd timer units, and enables the
pipeline.

## Plugin Requirements

The workflow needs these plugins enabled (the workflow should check and prompt
to enable any that are missing):

| Plugin | Why |
|---|---|
| `bootstrap` | Hosts this workflow. Must be passed via `--plugin bootstrap`. |
| `swarm` | Needed to verify beacon/coordinator connectivity and to give the agent access to `wiki_write` etc. during the kickoff message phase. |
| `exec` | Needed to run shell commands (check systemd status, write files, enable timer). |
| `file` | Needed to write the shell script and systemd unit files. |
| `ollama` (or any LLM provider) | Needed if the workflow asks the LLM to help design the pipeline. |

The workflow should use `ctx.enablePlugin()` to enable any missing plugins
(except `bootstrap` itself, which must be passed on the CLI).

## Workflow Metadata

```typescript
{
  name: 'swarm-memory',
  description:
    'Interactively set up an automated memory-ingestion pipeline that processes finished agent sessions into the coordinator wiki. Checks prerequisites, writes a shell script and systemd timer, and optionally lets you design the pipeline behavior.',
}
```

## Input Schema

```typescript
{
  type: 'object',
  properties: {
    // Optional — skip the design prompt and use the default "karpathy wiki" approach
    design: {
      type: 'string',
      description:
        'Optional — skip the design prompt. "default" for the standard karpathy-wiki approach, or a custom description of what kind of knowledge to extract.',
    },
    // Optional — skip the prerequisite checks and go straight to setup
    force: {
      type: 'boolean',
      description:
        'Skip prerequisite checks and write the pipeline files regardless.',
    },
  },
}
```

## Workflow Steps

### Step 1: Prerequisite Checks (skipped if `force=true`)

The workflow runs these checks in order, reporting each result to the user via
`ctx.elicit.ask()` or direct output. If a check fails, the workflow offers
guidance on how to fix it and asks whether to continue.

#### 1a. Coordinator is running

```bash
systemctl --user is-active drone-coordinator.service
```

If not active, report:
> The drone-coordinator service is not running. Start it with:
>   `systemctl --user start drone-coordinator.service`
> Or check its status with:
>   `systemctl --user status drone-coordinator.service`

#### 1b. Coordinator web port is reachable

```bash
curl -sf http://127.0.0.1:4300/health
```

The coordinator's web port (4300) is HTTP and bound to `0.0.0.0`, so it should
be reachable from localhost without TLS. If unreachable, check:
- Is the coordinator actually listening on port 4300? (`ss -tlnp | grep 4300`)
- Does the service unit have `--web-port 4300` and `--web-host 0.0.0.0`?

#### 1c. Coordinator has the wiki-librarian persona

```bash
curl -s http://127.0.0.1:4300/api/personas | jq -r '.[].id' | grep -q coordinator-wiki-librarian
```

If missing, the persona is auto-seeded on coordinator startup (see
`seedDefaults()` in `drone-coordinator/src/index.ts`). Restarting the
coordinator should create it:
```bash
systemctl --user restart drone-coordinator.service
```

#### 1d. `drone-agent` is installed

```bash
which drone-agent
```

Should resolve to `~/.local/bin/drone-agent`. If not found, the user needs to
install drone-agent first (e.g. `npm install -g drone-agent` or symlink from the
monorepo build).

#### 1e. `curl` and `jq` are available

```bash
which curl && which jq
```

Both are needed by the ingest script. If missing, prompt to install:
```bash
sudo apt install curl jq   # Debian/Ubuntu
```

#### 1f. Session status fix (if needed)

```bash
sqlite3 ~/.drone-coordinator/drone-coordinator.db \
  "SELECT COUNT(*) FROM swarm_sessions WHERE status = 'ended';"
```

If the count is > 0, the user has sessions stuck in `ended` status that can't
enter the pipeline. Offer to run the fix:

```bash
sqlite3 ~/.drone-coordinator/drone-coordinator.db \
  "UPDATE swarm_sessions SET status = 'finished' WHERE status = 'ended';"
```

This is safe — it only changes the status string, not the data. The pipeline
expects `finished` → `processing` → `processed`.

#### 1g. (Optional) Beacon is running

```bash
systemctl --user is-active drone-beacon.service
```

Not strictly required for the pipeline (the script talks to the coordinator
directly), but useful to flag if the user expects the wiki-librarian persona to
be available via the beacon.

### Step 2: Pipeline Design Prompt (skipped if `design` is provided)

If `design` is not provided, the workflow asks:

> How should the ingest pipeline work? I have a default approach in mind:
>
> **Default: "Karpathy wiki"** — Each session is analyzed for key insights,
> decisions, patterns, and architectural knowledge. The agent writes wiki pages
> organized by topic (architecture, workflows, conventions, decisions). Session
> IDs are recorded in each page's `sources` field for traceability.
>
> Would you like to use this default, or describe a different approach?
>
> Choices:
> - `default` — Use the karpathy-wiki approach
> - `custom` — Let me describe what I want

If `custom`, prompt for a freeform description of what kind of knowledge should
be extracted and how it should be organized. This description gets baked into
the prompt that the cron script passes to `drone-agent`.

### Step 3: Write the Pipeline Files

#### 3a. Write the ingest script

Write to `~/.local/bin/drone-wiki-ingest.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

COORDINATOR="http://127.0.0.1:4300"
LOG_DIR="$HOME/.drone-coordinator/ingest-logs"
DRONE_AGENT="$HOME/.local/bin/drone-agent"
PERSONA="coordinator-wiki-librarian"

mkdir -p "$LOG_DIR"

# 1. Find the oldest finished session
SESSION_JSON=$(curl -s "$COORDINATOR/api/sessions?status=finished&sortBy=updatedAt&sortDirection=ASC&limit=1")
SESSION_ID=$(echo "$SESSION_JSON" | jq -r '.sessions[0].id // empty')
COUNT=$(echo "$SESSION_JSON" | jq -r '.count // 0')

if [ -z "$SESSION_ID" ]; then
  echo "[$(date -Iseconds)] No finished sessions to process (total: $COUNT)" >> "$LOG_DIR/ingest.log"
  exit 0
fi

echo "[$(date -Iseconds)] Processing session: $SESSION_ID" >> "$LOG_DIR/ingest.log"

# 2. Transition to processing
curl -s -X POST "$COORDINATOR/api/sessions/$SESSION_ID/process" > /dev/null

# 3. Fetch the full log
curl -s "$COORDINATOR/api/sessions/$SESSION_ID/log" > "$LOG_DIR/$SESSION_ID.json"

# 4. Hand off to drone-agent
$DRONE_AGENT \
  --persona "$PERSONA" \
  --once \
  "I've transitioned session $SESSION_ID to processing status. The full conversation log is at $LOG_DIR/$SESSION_ID.json. Read it, analyze the conversation for key insights, decisions, and patterns, then write wiki pages to the coordinator knowledge base using wiki_write. When you're done, mark the session processed by POSTing to $COORDINATOR/api/sessions/$SESSION_ID/processed."

echo "[$(date -Iseconds)] Done processing: $SESSION_ID" >> "$LOG_DIR/ingest.log"
```

If the user chose a custom design in Step 2, the prompt in step 4 is customized
to reflect their description instead of the generic "key insights, decisions, and
patterns" language.

Make executable:
```bash
chmod +x ~/.local/bin/drone-wiki-ingest.sh
```

#### 3b. Write the systemd service unit

Write to `~/.config/systemd/user/drone-wiki-ingest.service`:

```ini
[Unit]
Description=Drone Wiki Ingest — process one finished session into the knowledge base
Documentation=https://github.com/unleethub/drone-agent

[Service]
Type=oneshot
ExecStart=%h/.local/bin/drone-wiki-ingest.sh

# Security
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
```

#### 3c. Write the systemd timer unit

Write to `~/.config/systemd/user/drone-wiki-ingest.timer`:

```ini
[Unit]
Description=Run drone-wiki-ingest every hour
Documentation=https://github.com/unleethub/drone-agent

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

### Step 4: Enable and Start

```bash
systemctl --user daemon-reload
systemctl --user enable drone-wiki-ingest.timer
systemctl --user start drone-wiki-ingest.timer
```

### Step 5: Return Results

The workflow returns:

**`toolResult`** — JSON summary of what was set up:

```json
{
  "ok": true,
  "files": {
    "script": "/home/user/.local/bin/drone-wiki-ingest.sh",
    "service": "/home/user/.config/systemd/user/drone-wiki-ingest.service",
    "timer": "/home/user/.config/systemd/user/drone-wiki-ingest.timer"
  },
  "prerequisites": {
    "coordinatorRunning": true,
    "coordinatorReachable": true,
    "wikiLibrarianPersona": true,
    "droneAgentInstalled": true,
    "curlAndJq": true,
    "sessionStatusFixApplied": false
  },
  "design": "default",
  "timerEnabled": true,
  "timerStarted": true
}
```

**`kickMessage`** — A human-readable summary injected as a synthetic user turn
so the agent can explain to the user what was set up and how to verify it:

```
Swarm memory ingest pipeline is set up.

Files written:
  ~/.local/bin/drone-wiki-ingest.sh
  ~/.config/systemd/user/drone-wiki-ingest.service
  ~/.config/systemd/user/drone-wiki-ingest.timer

The timer is enabled and running. It will fire every hour, pick up the oldest
finished session, and hand it to the coordinator-wiki-librarian persona for
analysis and wiki ingestion.

To check the timer:
  systemctl --user list-timers

To see the last run:
  journalctl --user -u drone-wiki-ingest.service -n 30

To see the ingest log:
  tail -f ~/.drone-coordinator/ingest-logs/ingest.log

To run a manual test:
  ~/.local/bin/drone-wiki-ingest.sh
```

## Error Handling

If any prerequisite check fails and the user chooses not to continue, the
workflow returns early with a `toolResult` describing what failed and what to
do about it, and no `kickMessage`.

If a file write fails, the workflow reports the specific file and asks whether
to retry or abort.

## Where to Implement

The workflow should be added to the `bootstrap` plugin at
`drone-agent/src/plugins/bootstrap/index.ts`, following the same pattern as
`bootstrap.project` and `bootstrap.user`. The registration call would be:

```typescript
registration.registerWorkflow(swarmMemoryWorkflow);
```

## Future Considerations

- **Batch processing**: The current design processes one session per timer fire.
  A future enhancement could process multiple sessions per run by looping in the
  shell script.
- **Custom personas**: The workflow could eventually let the user pick a
  different persona for the analysis step, not just
  `coordinator-wiki-librarian`.
- **Notification**: After processing, the agent could send a summary to a
  channel or webhook.

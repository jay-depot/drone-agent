---
key: manual-test-swarm-session-import
tags:
  - manual-testing
  - swarm
  - session-import
  - runbook
  - raspberry-pi
created: 2026-08-25T15:24:59.125Z
updated: 2026-08-25T15:24:59.125Z
---

# Manual Testing Runbook: `/swarm-session` (branch feat/swarm-session-import)

Companion to plan memory `plan-swarm-session-import-provider-fixes`. Execute AFTER deploying the branch build to the Pi beacon AND landing the provider-fix code steps. Kept as a standalone reference memory (not a plan) so wiki ingest does not consume it.

## Environment / verified pre-conditions

- Pi beacon reachable at 127.0.0.1:3457 over plain HTTP (user config swarm.beaconHost/Port/UseHttps = 127.0.0.1/3457/false). Verified alive 2026-08-25 (/health → 200); GET /sessions returned 404 pre-deploy.
- Agent runs locally from feat/swarm-session-import with the fix commits built (pnpm -r run build).
- User config declares OpenRouter model contextWindow metadata (e.g. openrouter/free ≈ 128k vs several 1M models) — deterministic lever for T6.

## T0 — Deploy gate

1. Deploy branch build to Pi beacon. Verify: beacon /health → 200.
2. `curl http://127.0.0.1:3457/sessions?limit=1` → 200 JSON (NOT 404). If 404: deploy did not take.
3. Coordinator trust established: a transcript fetch succeeds (see T2 path). If 503 "Coordinator unavailable": coordinator not trusted by beacon — complete the trust flow (/trust-coordinator) first.
4. Rebuild agent from branch locally; start a FRESH agent session; note its sessionId (needed for exclusion/self-import checks).

## T1 — List

- `/swarm-session list` → columns id | persona | status | createdAt | updatedAt; ≤10 rows; CURRENT session absent.
- `/swarm-session list --limit 3` → ≤3 rows. `/swarm-session list --status ended` → every row status=ended.
- `/swarm-session bogus` → usage warning listing valid subcommands.
- (Optional) Temporarily break beacon URL config → warning "Beacon URL not configured." Restore after.

## T2 — Happy-path import

1. Pick a SMALL ended session id from T1.
2. `/swarm-session import <id>` → logs: "Importing session <id> in N chunk(s) (X tokens each), resuming from chunk 1…", then per-chunk "Imported chunk k/N", then final "Imported chunks 1..N from session <id>."
3. Ask the agent about the imported session's work → answers reflect the OLD session's content; summaries read process+results flavored (steps taken, outcomes), not requests-flavored.
4. Synthetic `session_import` tool-call/result turns visible in transcript/TUI scrollback.

## T3 — Guards

- `/swarm-session import <current-session-id>` → "Cannot import the current session into itself."
- `/swarm-session import` (no id) → Usage line.
- `/swarm-session import <id> --from 999` → "--from 999 is out of range: … N chunk(s)." and ZERO injections (verify no turns added).

## T4 — Resume mechanics (--from)

1. After a successful T2 import of <id>, rerun `/swarm-session import <id> --from 2`.
2. Expect logs "resuming from chunk 2" and final "Imported chunks 2..N".
3. EXPECTED & BENIGN: chunks 2..N are summarized and injected AGAIN as duplicate turns (resume-after-abort tolerates overlap; true aborts print ranges + resume hint). Verify only: no crash/corruption, session remains coherent.
4. Optional (true abort repro): kill network mid-import → verify warn message lists imported chunks range, NOT-imported range, and exact "Resume with: /swarm-session import <id> --from k" command. (Abort path is unit-tested; this is belt-and-suspenders.)

## T5 — Config knobs (edit project .drone-agent/config.json; REVERT after)

- Set swarm.sessionImport.maxChunks=2 → reimport same session → exactly 2 chunk logs.
- Set chunkTokenBudgetPercent=25 → "(X tokens each)" X ≈ 2× the value seen at default 12%.
- Invalid values (e.g. maxChunks=0, percent=150) rejected by config schema validation.
- Remove overrides afterwards.

## T6 — Provider-refactor integration (model-dependent summary depth)

1. Active model openrouter/stealth/ox-alpha (declared 1M window) → note X in "(X tokens each)" during an import.
2. `/model` switch to a declared ~128k model (e.g. openrouter/free) → import the SAME session → X ≈ 128k × 12%.
3. Switch back / to another declared 1M model → X ≈ 1M × 12%.
   PASS = budget tracks the resolved window through the broker's declared⊕discovered chain AND mid-session model switches take effect immediately (ContextBudgetService cache invalidation working via resetContextWindowCache). Larger window MUST yield visibly richer summaries of the same session.

## T7 — Long-session degradation

1. Import 2–3 LARGE ended sessions sequentially into one session.
2. Compaction started/completed events appear BETWEEN chunk injections.
3. Continue chatting past the soft threshold → safety-trim notices fire; verify the OLDEST IMPORTED turns drop first; no non-convergence errors ("no turns could be dropped"); agent retains recent context throughout.

## T8 — Shared-wiring regressions (same branch)

- `/skills recall <known-id>` works in the TUI (sessionManager slash-command wiring fixed by this branch).
- Normal chat turn before and after imports behaves normally.
- `/plugins` lists swarm; startup shows NO warnings about llm dependency (optional-dep regression check).

## Teardown

Revert T5 config edits; optionally `/clear` the test session.

PASS CRITERIA: all T0–T8 checks green with zero unexpected warnings/errors in agent output or beacon logs.

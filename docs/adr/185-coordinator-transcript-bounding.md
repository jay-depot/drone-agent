---
tags:
  [
    decision,
    coordinator,
    transcript,
    memory-pipeline,
    bug-fix,
    session-import,
    json,
  ]
related:
  [
    decisions/151-memory-pipeline-infra.md,
    decisions/146-swarm-session-import.md,
    modules/drone-coordinator.md,
    concepts/memory-pipeline.md,
  ]
---

# 185: Coordinator transcript bounding — never truncate mid-JSON

**Status**: Implemented (2026-09-02, branch `feat/swarm-memory-rag`, commit `801e09a`)

## Context

The memory-pipeline ingest hook failed with `'Unterminated string in JSON'` at
~256KB. `buildSessionTranscript()` (`drone-coordinator/src/transcript.ts`) — the
lightweight transcript shared by session import and the swarm memory pipeline —
truncated tool **results** to 400 chars but NOT tool-call **arguments**. A single
complex tool call (a giant `exec` command, file content in args) produced a
huge line, and many such calls pushed the transcript past the transport limit.
The transcript was then truncated **mid-JSON**, breaking the downstream
`JSON.parse`.

## Decision

Bound the transcript in two layers so the response never truncates mid-JSON:

1. **Per-tool-call arguments.** New `truncateToolCallArgs()` caps each
   tool-call's serialized arguments at 400 chars (`MAX_TOOL_CALL_ARGS_CHARS`),
   appending `…[truncated, original N chars]` so the summarizer knows content
   was elided. (Tool results were already truncated at 400 chars.)

2. **Total transcript hard cap.** New `MAX_TRANSCRIPT_CHARS = 200 * 1024`
   (200KB — safely under the ~256KB transport limit). When the fully-rendered
   transcript would exceed it, the tail is elided with
   `…[transcript truncated, original N chars]`.

The fix is **coordinator-side only** — no workflow re-run was needed; existing
in-flight jobs get the bounded transcript automatically.

## Tests

`drone-coordinator/test/transcript.test.ts` gained 2 cases: long tool-call args
are truncated (with the note, original payload gone); and a session with many
individually-under-cap tool results is capped at the total size with the elision
note and never truncates mid-JSON.

## Alternatives considered

- **Raise/remove the transport limit** — rejected: the limit exists for a reason
  (aggregate payload size over the wire); the transcript is a summarizer input
  and does not need full fidelity.
- **Truncate whole tool-call events** — rejected: keeps `null`/skips the call
  entirely; per-argument truncation preserves the call signature + name.

## Consequences

- Session-import and memory-pipeline transcripts never break the transport with
  malformed JSON.
- Summaries are complete enough to know content was dropped (elision notes), not
  silently truncated.
- Adds to the `transcript.ts` invariants: per-result cap (400), per-args cap
  (400), total cap (200KB).

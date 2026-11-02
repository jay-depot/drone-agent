---
tags: [decision, guardrail, tool-calling, openai-compatible, schema]
related:
  [
    decisions/145-guardrail-reliability-features.md,
    decisions/161-runtime-enforcement-required-tool-inputs.md,
    decisions/071-tool-consolidation-batch-2.md,
    modules/drone-core.md,
    modules/drone-agent.md,
  ]
---

# ADR 267: Malformed tool-call arguments are a degenerate response + schema-honesty descriptions

**Status**: Implemented (2026-10-28, branch `fix/tool-call-args-parse-swallow`)

## Context

Two related findings from one operator incident:

1. **A silent swallow in the OpenAI-compatible adapter.** `fromOpenAiResponse`
   (`drone-agent/src/shared/openai-compatible.ts`) parsed every tool call's
   `arguments` string with a bare `try { JSON.parse(...) } catch { parsedArgs = {} }`.
   An unparseable arguments string therefore became an empty arguments object,
   and the call executed. A tool whose inputs happen to be optional at the
   schema level reported success on a call the model never actually made.
   The parse failure was invisible: no log, no event, no retry.

2. **An upstream provider failure shape.** OpenRouter's `deepseek-v4.1-flash`
   returned tool calls whose `arguments` were _valid JSON with missing
   properties_ — required fields (`action`, `key`) present, optional
   payload-carrying fields (`value`, `content`, `diff`) absent — while the
   model's reasoning narrated sending them. The failures clustered on large
   payloads. That case parses cleanly and is NOT covered by this ADR; it is an
   upstream report (a `--debug llm` capture decides model omission vs provider
   truncation before filing).

The incident also exposed a schema-honesty gap that invites the confusion in
(2): action-parameter tools (the ADR 071 consolidation pattern) carry
per-action requiredness in prose only. `memory.manage` declares
`required: ['action', 'key']` — its `value` is schema-optional even though the
`store` action cannot work without it. A schema-strict model can read the
schema as license to omit the payload.

## Decision

### 1. Parse failure is a degenerate response, not a silent heal

`DroneChatResponse` (drone-core) gains an optional `malformedToolCalls?:
string[]` — the names of tool calls whose arguments failed to parse or parsed
to a non-object (null, array, string, number). `fromOpenAiResponse` collects
the names whenever the degrade-to-`{}` path fires (parse throw or non-object
result) and sets the field only when it is non-empty, so healthy responses are
byte-identical to before. An empty arguments string stays exempt: it is a
legitimate zero-argument call, not corruption. Drivers that receive arguments
as native objects (ollama, anthropic) have no parse step to fail and never set
the field.

The conversation service treats a response carrying malformed tool calls as a
degenerate response under the existing `brokenResponses` thresholds
(hintAfter 2, maxHints 2 — no new config key): silent retry, then a
non-persisted hint, then the `onBrokenResponseLimitReached` abort. The whole
response is discarded — including any assistant text paired with the unusable
calls — so the session never holds a turn whose tool calls cannot be executed.
The notice label is distinct (`malformed tool-call arguments`), and the tier
has its own counter (`malformedToolCallResponseCount`), because the per-tier
counters exist precisely so an alternating failure pattern cannot conflate two
tiers' limits (see ADR 145). The counter resets on a healthy response, in
`clearSession`, and in `resetStuckDetectors`.

### 2. Routing principle: unrecoverable vs self-correctable

Degenerate-retry is reserved for arguments the model cannot recover from
feedback — unparseable JSON has no content to correct. A _missing named_
parameter is different: the tool's own validation error names the field, and
the model corrects in one round (observed live). Routing named-missing
parameters into degenerate-retry would burn four rounds and abort on a
deterministically confused model — a regression, not a fix. The existing
identical-tool-call streak guardrail (hintAfter 2, maxHints 3) already
backstops hollow-call loops in that class. Engine-level required-field
enforcement remains the ADR 161 follow-up: `inputSchema.required` cannot
express per-action requiredness, so a plain required check passes exactly the
arguments from this incident (`{action, key}`) — it needs a per-action
required contract first, which is its own design.

### 3. Schema-honesty sweep (descriptions only)

Where an action enum exists and a property is required for some actions but
absent from `required`, the property description now states the per-action
requiredness explicitly:

- `memory.manage` — `value`: REQUIRED when `action="store"`, omit otherwise,
  with a split-into-several-stores caution for very large values; `diff`:
  provide diff and/or tags when `action="edit"` (at least one required).
- `notepad.manage` — `content`: REQUIRED when `action="set"` or `"append"`;
  `diff`: REQUIRED when `action="edit"`. `content` and `diff` remain separate
  properties (a merged single-content property was tried and reverted: the
  merged wording was ambiguous).
- `todo.manage_list` — `id` (mark_*/remove_item), `title` (add_item), `items`
  (replace_list): each now states which actions require it.
- `search.text` and `utils` were surveyed and need no change: `search` has no
  action enum, and `utils` parameters are unconditionally required.

Descriptions only — no schema-structure or wire-format changes.

## Tests

- `test/openai-compatible.test.ts` (new) — invalid JSON → `{}` + name listed;
  valid JSON → field absent; parsed `null`/array/string → malformed; mixed
  good+bad calls → only bad names; empty/whitespace arguments string → not
  malformed (zero-argument call).
- `test/conversation-service-guardrails.test.ts` — malformed response → exact
  retry notice with the distinct label, the tool never executes, nothing is
  appended to the session; `onBrokenResponseLimitReached` receives the
  `malformed tool-call arguments` label after limits; the counter resets after
  a healthy (tool-carrying) response.

## Alternatives considered

- **Keep the silent `{}` heal** — rejected: it executes hollow calls and hides
  provider faults; the incident class this ADR names is exactly what it
  produced.
- **Degenerate-route missing optional parameters too** — rejected: see the
  routing principle. The model self-corrects from named tool errors; forcing a
  4-retry abort ladder on that case is a regression.
- **Engine-level required-field pre-execution check** — deferred: blind to
  per-action requiredness without a new contract (ADR 161 follow-up).
- **Merging notepad `content` and `diff` into one property** — rejected: the
  merged description was ambiguous; separate properties with sharp wording.

## Consequences

- Unparseable tool-call arguments now surface as a visible, bounded retry
  cycle instead of a silently executed hollow call.
- OpenRouter/deepseek valid-JSON-missing-properties remains open upstream;
  the `--debug llm` capture (ADR 082) decides the report before filing.
- Tool descriptions now carry per-action requiredness where the schema cannot.

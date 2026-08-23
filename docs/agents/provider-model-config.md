# Provider / Protocol / Model Configuration

Drone-agent's LLM configuration separates **protocols** (code) from
**providers** (data):

- A **protocol** is a wire format — `ollama`, `openai`, `openrouter`,
  `anthropic`, `echo`. Each protocol ships as a built-in plugin exporting an
  `LlmProtocolDriver` factory (createProvider, optional discoverModels,
  parameterSchema). All protocol plugins are default-enabled but **inert**
  until a providers entry selects their protocol; the real gate is
  `config.providers`.
- A **provider** is a user-defined entry in `config.providers` naming a
  protocol plus connection details, parameters, and models.
- A **model** lives under its provider as `<providerId>/<modelLocalId>`.

## Providers config

```jsonc
// ~/.drone-agent/config.json
{
  "providers": {
    "local": {
      "protocol": "ollama",
      "baseUrl": "http://127.0.0.1:11434",
      "parameters": { "temperature": 0.7 },
      "models": {
        "llama3.1": {},
        "fast": { "model": "llama3.1", "parameters": { "numCtx": 8192 } },
      },
    },
    "openrouter-main": {
      "protocol": "openrouter",
      "apiKey": "${OPENROUTER_API_KEY}",
      "autoImport": "onSelect",
      "models": {
        "anthropic/claude-opus-4.8": {
          "contextWindow": 1000000,
          "maxOutputTokens": 32000,
          "hasVision": true,
        },
      },
    },
  },
  "llm": {
    "active": "local/fast",
    "reasoningLevel": "medium",
  },
}
```

### Model entries and aliasing

The map KEY is the local reference id used in selection; the optional
`model` field is the upstream id sent on the wire and defaults to the key.
One level of aliasing is supported (`fast → llama3.1` above); chains
produce a startup warning and resolve only one level.

### Metadata

Optional per-model metadata: `contextWindow`, `maxOutputTokens`,
`hasVision` (default false), `supportsTools` (default true),
`reasoningLevel`. Resolution order for every field: declared entry >
alias-base entry > discovered > defaults.

The context window follows this same chain and feeds the status-bar usage
percentage and safety trimming. When a declared or discovered value exists,
it wins outright (`source: 'metadata'`); the driver's live probe (ollama's
`show`, for example) only runs when no catalog data exists, and the session
fallback (`session.contextWindowTokens`) is the last resort. Each model's
resolved window and its source are logged once per session, so a wrong
denominator is diagnosable from the log alone.

### Parameters

Flat camelCase maps at provider and model level, shallow-merged with the
model winning per key. Each driver validates against its `parameterSchema`:

- Known keys are type-checked and translated to wire names
  (`numCtx → num_ctx`, `topP → top_p`, …).
- Unknown keys warn once per request but are still sent.
- The provider-level `extra` map merges silently into the native request
  payload with no warnings (explicit escape hatch).

Ollama parameters land in the native `options{}` envelope — e.g. `numCtx`
becomes `options.num_ctx`.

### autoImport

Hybrid model sourcing merges declared ⊕ discovered models (declared wins
key-for-key) behind a ~60s TTL cache; discovery failures fall back to
declared-only with a warning. Per-provider `autoImport` controls whether
discovered models persist into config as empty `{}` stubs (pinning
existence, never snapshotting metadata):

- `off` — never persist.
- `onSelect` (default) — reserved for explicit `/model <pick>` selections.
- `all` — persist everything discovered (never removes stale entries).

## Selection identity

A selected model is canonically `<providerId>/<modelLocalId>`, split on the
FIRST slash so multi-slash upstream ids survive
(`openrouter/anthropic/claude-opus-4.8`). Rules:

- Config values (`llm.active`) require the full form.
- Interactive surfaces accept a bare local id as shorthand within the
  active provider.
- `/model` bare = read-only browse grouped by provider;
  `/model <pick>` persists to user-scope `llm.active`;
  `/model --once <pick>` switches without persisting.
- `--model <provider/model>` on the CLI overrides `llm.active` for that
  invocation only (never persisted).
- The status bar shows the full-form identity.

## Reasoning

Chain: session (`/reasoning`) > selected model entry `reasoningLevel` >
`llm.reasoningLevel`. Drivers own the mapping tables:

| protocol   | off                           | low                            | medium/high/max         |
| ---------- | ----------------------------- | ------------------------------ | ----------------------- |
| ollama     | `think: false`                | `think: 'low'`                 | `think: '<level>'`      |
| openai     | `reasoning_effort: 'minimal'` | `'low'`                        | `'\<level\>'`           |
| openrouter | `reasoning.effort: 'minimal'` | `'low'`                        | `'\<level\>'`           |
| anthropic  | no thinking block             | budget ≈10% of maxOutputTokens | ≈50% of maxOutputTokens |

Raw pass-through of non-standard strings is allowed (warned).

## Secrets

`apiKey` accepts a literal secret or a `${VAR}` template. Interpolation
runs per-layer at parse time; an unset variable fails startup naming the
variable and config path. Project-scope files must not define plaintext
keys (loud warning); user scope and swarm underlays may.

## Scopes

`providers` entries are **banned in project-scope config** (startup error).
Projects may pin `llm.active` / `llm.reasoningLevel`. Beacon/coordinator
underlays are sanctioned distribution channels; entries merge by key with
whole-entry replacement (a scope defining `providers.<id>` replaces that
entire entry — no partial overrides across scopes).

See `docs/agents/swarm-plugin.md` for the swarm-underlay contract.

## Migration from legacy sections

On load, if legacy sections exist (`llm.provider`, `ollama`, `openai`,
`anthropic`, `openrouter`), drone-agent synthesizes providers named after
each section and seeds `llm.active`. This is automatic, idempotent, and
announced with a notice. New config writers (bootstrap, first-run,
`/model`) emit the new format only.

The migration **persists**: the first load that sees legacy sections in a
user-scope `config.json` rewrites that file in canonical form. Each rewrite
is preceded by a timestamped backup (`config.json.<timestamp>.old`) holding
the original bytes, and is written atomically (tmp file + rename). Persisted
content is derived from the raw file, so `${VAR}` API-key templates stay
templates on disk; literal keys are relocated unchanged with an advisory
suggestion to switch to templates. Legacy sections are stripped whenever a
migration write touches a file — including sections already shadowed by an
existing `providers` block. Project-scope files never receive `providers`
(they are banned there); legacy sections at project scope apply in memory
for the session and produce a warning directing you to user scope.

The migration module remains deletable once the deprecation window closes.

## Intentional behavior change (anthropic max_tokens)

Previously the anthropic plugin borrowed `session.responseReserveTokens`
as its wire `max_tokens` (and derived thinking budgets from it). Wire
`max_tokens` now comes from resolved `maxOutputTokens` metadata (driver
default 8192 when undeclared), and thinking budgets are calibrated
fractions OF that value. `session.responseReserveTokens` has returned to
pure context-budgeting duty.

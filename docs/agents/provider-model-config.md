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
it wins outright (`source: 'metadata'`); the driver's live probe only runs
when no catalog data exists, and the session fallback
(`session.contextWindowTokens`) is the last resort. Each model's resolved
window and its source are logged once per session, and the `/context`
command prints them on demand: model identity, resolved window +
provenance slot, response reserve, and estimated usage.

For ollama, local models resolve through runtime enforcement truth rather
than advertised training lengths: a resident `/api/ps` entry wins (it
reflects VRAM clamping), then effective `numCtx` request parameters, then
the Modelfile's `num_ctx`, then a driver pin of 16384. Cloud models
(`:cloud`) run at their advertised length. Discovery therefore publishes
catalog context windows for cloud models only — catalog data outranks the
live probe broker-side, so publishing locals' training maxes would mask
runtime resolution permanently.

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
existence, never snapshotting metadata). **Status: the field is accepted
in schema and parsed into provider entries, but has no behavioral wiring
yet — discovered-stub persistence is planned:**

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

## Model roles

Some built-in plugins make their own LLM calls (compaction summarization,
persona creation, MCP server-description generation) rather than riding the
main chat loop. By default those calls reuse the session's active selection
(`llm.active`). **Model roles** let you pin a different provider/model for a
specific purpose via the user-scope `llm.modelRoles` map:

```json
{
  "llm": {
    "modelRoles": {
      "summarizer": "ollama/llama3.1",
      "wizard": "anthropic/claude-haiku-4-5",
      "describer": "openrouter/openai/gpt-5.3-codex",
      "image_describer": "openrouter/openai/gpt-5.3-codex"
    }
  }
}
```

Each role maps to a canonical `<providerId>/<modelLocalId>` selection (same
strict form as `llm.active`; bare ids are rejected). Unset or misconfigured
roles fall back to the active selection, so omitting the map changes nothing.
Resolution is stateless — it never mutates the active selection — and the
resolved provider is broker-enriched exactly like the active one (effective
parameters, resolved context window, error tagging).

Well-known roles (the startup validator warns on role names outside this
list, catching typos like `summarizer` that would otherwise silently fall
back):

| role         | consumer                                         |
| ------------ | ------------------------------------------------ |
| `summarizer` | Compaction (`/compact`) summary generation       |
| `wizard`     | `persona.create` wizard persona-draft generation |
| `describer`  | MCP server-description generation                |
| `image_describer` | Vision-capable model that describes images for non-vision targets, compaction, and persistence |

The role namespace is open — plugins may mint additional roles, though only
the well-known list above is recognized by the validator.

**Scopes:** `llm.modelRoles` is **banned in project-scope config** (startup
error), same class as `providers`: role values reference providers that may
not exist in a freshly-cloned environment. Define them in user config or
distribute via swarm underlays. `llm.modelRoles` merges per-key across
layers, so distinct roles from different scopes combine.

## Images & vision

Models declare vision support via the per-model `hasVision` metadata flag
(default false). When the active model is vision-capable, image content is
carried to the provider on the wire as native image parts (base64 blobs are
stripped from the text content and replaced with an `[Image attached]`
marker). When the active model is **not** vision-capable, images are
described instead: the `image_describer` role (falling back to the active
selection, then any vision-capable configured model) generates a text
description that is substituted into the message content, so the model
still sees the image's semantics without receiving the bytes.

Descriptions are also produced eagerly when a durability gate is active
(`log.enabled` or a swarm connection) so they survive compaction and
persistence even though the raw image bytes are destroyed. The
`image_describer` role is the preferred way to pin which model performs
this work; see the model-roles table above.

## Reasoning

Chain: session (`/reasoning`) > selected model entry `reasoningLevel` >
`llm.reasoningLevel`. Drivers own the mapping tables. A role-bound model
honors its model-entry `reasoningLevel` (then `llm.reasoningLevel`); there
is no session-level tier for role calls:

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

`providers` entries and `llm.modelRoles` are **banned in project-scope
config** (startup error). Projects may pin `llm.active` /
`llm.reasoningLevel`. Beacon/coordinator underlays are sanctioned
distribution channels; entries merge by key with whole-entry replacement (a
scope defining `providers.<id>` replaces that entire entry — no partial
overrides across scopes). `llm.modelRoles` merges per-key.

Project-scope discovery dedupes against the effective user config by file
identity: launching from the home directory would otherwise rediscover
`~/.drone-agent/config.json` and load it a second time as project scope,
tripping the ban above. When the walked-to file _is_ the user config it is
skipped, a one-time notice is logged at startup, and the session runs with
no project layer. Project-scope writes (`config.set` with scope `project`)
refuse in that situation — use user scope instead.

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

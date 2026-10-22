# Config System

Config files live in `.drone-agent/config.json` at each scope. The config loader
(`runtime/config.ts`) walks up the directory tree looking for `.drone-agent/`
directories, so project-level config overrides user-level config.

## `enabledPlugins` override map

`enabledPlugins` is a sparse override **map** (`Record<string, boolean>`), merged
per-key across layers and applied by the engine over the built-in default plugin
set (`required || defaultEnabled`):

- `true` force-enables
- `false` force-disables
- absent means no opinion

`required` plugins and the `--plugin`/`--swarm` CLI flags both override an
explicit `false`. A legacy array form is tolerated at parse time and rewritten
on disk once (with a `.old` backup + advisory notice). See ADR 251.

## `mergeMaps` rule

The named-entry maps `enabledPlugins`, `providers`, `trustedPlugins`,
`lsp.servers`, and `mcp.servers` use the `mergeMaps` merge rule: shallow,
1-level, where a `null` entry deletes that entry and a `null` whole value clears
the map.

## Key sections

`enabledPlugins`, `systemPrompt`, `activePersona`, `llm`, `ollama`,
`openrouter`, `session`, `lsp`, `mcp`, `compaction`, `memory`, `log`,
`promptFile`, `swarm`.

## `search.paths[]` RAG sources

`search.paths[]` entries accept an optional `ragSource?: boolean` (default
false). When true, that folder's workspace-file semantic index also feeds the
proactive swarm-memory RAG (`swarm.memory`) as an extra candidate source — file
hits compete with wiki entries for the same `ranking.topK` slots (no extra
slots). The `search` plugin must be enabled for the folder to be
registered/indexed. See ADR 245.

## `swarm.memory` — what stays agent-side

Ranking moved to the beacon (ADR 260): `topK`, `minScore`, `keywordBoost` and
`anchors` now live in the beacon's `ranking` config block, because ranking is a
property of the corpus rather than of the asking agent. The agent keeps only
conversation-shaped settings:

| Key                                    | Meaning                                                                |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `swarm.memory.enabled`                 | Master switch — hides the prompt fragment and makes zero network calls |
| `swarm.memory.window.maxQueryTokens`   | Token budget per assembled query input                                 |
| `swarm.memory.window.maxQuerySegments` | Max segmented window inputs per refresh                                |

`topK`, `minScore` and `anchors` are **deprecated** here: they warn once at
plugin registration and are otherwise ignored. Remove them from agent config and
set them in the beacon's `ranking` block instead.

## Related

- `docs/agents/swarm-plugin.md` — the beacon config underlay (coordinator →
  beacon → agent), secret handling, and underlay reactivity
- `docs/adr/260-keyword-wiki-index-and-beacon-fusion.md` — the keyword index and
  why ranking moved to the beacon
- `docs/agents/provider-model-config.md` — protocols, providers, and models

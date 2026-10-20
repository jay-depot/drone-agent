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
hits compete with wiki entries for the same `swarm.memory.topK` slots (no extra
slots). The `search` plugin must be enabled for the folder to be
registered/indexed. See ADR 245.

## Related

- `docs/agents/swarm-plugin.md` — the beacon config underlay (coordinator →
  beacon → agent), secret handling, and underlay reactivity
- `docs/agents/provider-model-config.md` — protocols, providers, and models
